import tls, { type ConnectionOptions as TlsConnectionOptions } from "node:tls";

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResult } from "pg";

import { TenantIsolationError, type ResolvedTenantContext } from "../tenancy/tenant-context";
import * as schema from "./schema";
import { SYSTEM_PERMISSION_CATALOG, SYSTEM_ROLE_DEFINITIONS } from "./seed-system-roles";

// ============================================================================
// 1. AWS RDS PostgreSQL Configuration & Types
// ============================================================================

/**
 * The AWS RDS console for `aurelia-timeflow-db-mumbai` currently provisions the
 * default initial database named `postgres`. Do not assume `aurelia_timeflow`
 * exists until `0000_create_database_and_role.sql` is explicitly executed.
 */
export const DEFAULT_AWS_RDS_DATABASE = "postgres" as const;
export const RECOMMENDED_DEDICATED_RDS_DATABASE = "aurelia_timeflow" as const;
export const DEFAULT_AWS_RDS_PORT = 5432 as const;
export const DEFAULT_AWS_RDS_POOL_MAX = 10 as const;
export const MAX_ALLOWED_RDS_POOL_SIZE = 100 as const;

export type AppEnvironment = "development" | "staging" | "production";
export type AwsRdsSslMode = "require" | "verify-ca" | "verify-full";
export type AwsRdsEndpointType = "rds-instance" | "rds-proxy" | "aurora-cluster" | "custom";

export interface AwsPostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  region: string;
  sslMode: AwsRdsSslMode;
  caCert?: string | undefined;
  poolMax: number;
  environment: AppEnvironment;
  endpointType: AwsRdsEndpointType;
  isAwsRdsEndpoint: boolean;
  isRdsProxyOrCluster: boolean;
  credentialSource: "environment" | "aws_secrets_manager_json";
}

export interface AwsSecretsManagerRdsPayload {
  host?: string;
  port?: number | string;
  dbname?: string;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
}

export interface AwsDatabaseHealthReport {
  status: "healthy" | "unconfigured" | "unhealthy";
  provider: "aws-rds-postgresql";
  environment: AppEnvironment;
  region: string;
  host: string | null;
  endpointType: AwsRdsEndpointType | null;
  port: number;
  databaseName: string;
  sslEnforced: boolean;
  sslMode: string | null;
  caVerified: boolean;
  hostnameVerified: boolean;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
  diagnosticHint?: string | undefined;
}

export interface DatabaseRoleSecurityStatus {
  roleName: string;
  isSuperuser: boolean;
  hasBypassRls: boolean;
  isLeastPrivilegeSafe: boolean;
}

export interface QueryableTransactionClient {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
  release: (err?: Error | boolean) => void;
}

export interface QueryableTransactionPool {
  connect: () => Promise<QueryableTransactionClient>;
}

export interface TenantTransactionContext {
  verifiedTenantId: string;
  db: AureliaAwsDb;
  client: QueryableTransactionClient;
}

// ============================================================================
// 2. Environment Separation, AWS Secrets Manager & Security Guards
// ============================================================================

/**
 * Ensures database configuration and queries never execute in a browser bundle.
 */
export function assertServerOnlyExecution(isBrowserWindow = false): void {
  if (isBrowserWindow) {
    throw new Error(
      "SECURITY_VIOLATION: AWS PostgreSQL client cannot be executed in a browser environment.",
    );
  }
}

/**
 * Resolves the active application environment (`development`, `staging`, `production`).
 */
export function getAppEnvironment(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): AppEnvironment {
  const raw = (env["APP_ENV"] ?? env["NODE_ENV"] ?? "development").toLowerCase().trim();
  if (raw === "production" || raw === "prod") return "production";
  if (raw === "staging" || raw === "stage") return "staging";
  return "development";
}

/**
 * Prevents local demo seed data from being loaded into the production AWS database.
 */
export function assertDemoDisabledInProduction(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): void {
  if (getAppEnvironment(env) === "production") {
    throw new Error(
      "PRODUCTION_SAFEGUARD: Demo seed data and browser demo personas are disabled in the production AWS PostgreSQL environment.",
    );
  }
}

/**
 * Redacts passwords, tokens, and secrets from connection strings or error messages
 * so AWS RDS credentials are never leaked in logs or health checks.
 */
export function redactPostgresCredentials(input: string, secretToMask?: string): string {
  if (!input) return "[empty]";
  let sanitized = input;
  if (secretToMask && secretToMask.length > 0) {
    sanitized = sanitized.split(secretToMask).join("********");
  }
  sanitized = sanitized.replace(/(:\/\/[^:/?#]+:)([^@]+)(@)/g, "$1********$3");
  sanitized = sanitized.replace(/(password\s*=\s*)([^\s&;]+)/gi, "$1********");
  sanitized = sanitized.replace(/("password"\s*:\s*")([^"]+)(")/gi, "$1********$3");
  return sanitized;
}

/**
 * Classifies the AWS RDS hostname format so single-instance RDS endpoints
 * (`<instance-id>.<dns-id>.ap-south-1.rds.amazonaws.com`) are distinguished from
 * RDS Proxy (`*.proxy-*`) and Aurora Cluster (`*.cluster-*`) endpoints.
 */
export function classifyAwsRdsEndpointType(host: string): AwsRdsEndpointType {
  const normalized = host.trim().toLowerCase();
  if (normalized.endsWith(".rds.amazonaws.com")) {
    if (normalized.includes(".proxy-")) return "rds-proxy";
    if (normalized.includes(".cluster-") || normalized.includes(".cluster-ro-")) {
      return "aurora-cluster";
    }
    return "rds-instance";
  }
  return "custom";
}

/**
 * Parses an AWS Secrets Manager RDS secret JSON payload (`AWS_RDS_SECRET_JSON`)
 * injected into an AWS ECS Fargate task or App Runner service.
 */
export function parseAwsSecretsManagerRdsJson(rawSecretJson: string): AwsSecretsManagerRdsPayload {
  try {
    const parsed = JSON.parse(rawSecretJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Secret payload must be a JSON object.");
    }
    return {
      host: typeof parsed["host"] === "string" ? parsed["host"].trim() : undefined,
      port:
        typeof parsed["port"] === "number" || typeof parsed["port"] === "string"
          ? parsed["port"]
          : undefined,
      dbname: typeof parsed["dbname"] === "string" ? parsed["dbname"].trim() : undefined,
      database: typeof parsed["database"] === "string" ? parsed["database"].trim() : undefined,
      username: typeof parsed["username"] === "string" ? parsed["username"].trim() : undefined,
      user: typeof parsed["user"] === "string" ? parsed["user"].trim() : undefined,
      password: typeof parsed["password"] === "string" ? parsed["password"] : undefined,
    };
  } catch {
    throw new Error(
      "Invalid AWS_RDS_SECRET_JSON format. Expected valid AWS Secrets Manager RDS JSON object.",
    );
  }
}

/**
 * Validates AWS RDS PostgreSQL configuration from server environment variables
 * or AWS Secrets Manager JSON (`AWS_RDS_SECRET_JSON`).
 * Never silently downgrades SSL or masks invalid pool configurations.
 */
export function validateAwsPostgresConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): AwsPostgresConfig {
  assertServerOnlyExecution();

  // Reject any VITE_ client exposure of AWS database credentials
  if (
    env["VITE_AWS_RDS_PASSWORD"] ||
    env["VITE_AWS_RDS_HOST"] ||
    env["VITE_DATABASE_URL"] ||
    env["VITE_AWS_RDS_SECRET_JSON"]
  ) {
    throw new Error(
      "SECURITY_VIOLATION: AWS PostgreSQL credentials must never be exposed via VITE_* client environment variables.",
    );
  }

  const secretJsonRaw = (env["AWS_RDS_SECRET_JSON"] ?? "").trim();
  const secretPayload = secretJsonRaw ? parseAwsSecretsManagerRdsJson(secretJsonRaw) : undefined;

  const environment = getAppEnvironment(env);
  const host = (env["AWS_RDS_HOST"] ?? secretPayload?.host ?? "").trim();
  const user = (env["AWS_RDS_USER"] ?? secretPayload?.username ?? secretPayload?.user ?? "").trim();
  const password = env["AWS_RDS_PASSWORD"] ?? secretPayload?.password ?? "";
  const database = (
    env["AWS_RDS_DATABASE"] ??
    secretPayload?.dbname ??
    secretPayload?.database ??
    DEFAULT_AWS_RDS_DATABASE
  ).trim();
  const region = (env["AWS_REGION"] ?? "ap-south-1").trim();
  const portRaw = Number(env["AWS_RDS_PORT"] ?? secretPayload?.port ?? DEFAULT_AWS_RDS_PORT);
  const sslModeRaw = (env["AWS_RDS_SSL_MODE"] ?? "require").toLowerCase().trim();
  const caCert = env["AWS_RDS_CA_CERT"]?.trim() || undefined;

  if (!host) {
    throw new Error(
      "Missing AWS_RDS_HOST environment variable. Set your AWS RDS PostgreSQL endpoint in server environment variables or AWS_RDS_SECRET_JSON.",
    );
  }
  if (!user) {
    throw new Error(
      "Missing AWS_RDS_USER environment variable. Set your AWS PostgreSQL database user in server environment variables or AWS_RDS_SECRET_JSON.",
    );
  }
  if (!password) {
    throw new Error(
      "Missing AWS_RDS_PASSWORD environment variable. Set your AWS PostgreSQL password in server environment variables or AWS_RDS_SECRET_JSON.",
    );
  }
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error(`Invalid AWS_RDS_PORT "${env["AWS_RDS_PORT"]}". Must be a valid TCP port.`);
  }

  let poolMax: number = DEFAULT_AWS_RDS_POOL_MAX;
  if (env["AWS_RDS_POOL_MAX"] !== undefined && env["AWS_RDS_POOL_MAX"].trim() !== "") {
    const parsedPoolMax = Number(env["AWS_RDS_POOL_MAX"]);
    if (
      !Number.isInteger(parsedPoolMax) ||
      parsedPoolMax < 1 ||
      parsedPoolMax > MAX_ALLOWED_RDS_POOL_SIZE
    ) {
      throw new Error(
        `Invalid AWS_RDS_POOL_MAX "${env["AWS_RDS_POOL_MAX"]}". Must be an integer between 1 and ${MAX_ALLOWED_RDS_POOL_SIZE}.`,
      );
    }
    poolMax = parsedPoolMax;
  }

  const allowedSslModes = new Set<AwsRdsSslMode>(["require", "verify-ca", "verify-full"]);
  if (!allowedSslModes.has(sslModeRaw as AwsRdsSslMode)) {
    throw new Error(
      `SSL is mandatory for AWS RDS PostgreSQL connections. Set AWS_RDS_SSL_MODE to "require", "verify-ca", or "verify-full" (received "${sslModeRaw}").`,
    );
  }

  const endpointType = classifyAwsRdsEndpointType(host);
  const isAwsRdsEndpoint = endpointType !== "custom";
  const isRdsProxyOrCluster = endpointType === "rds-proxy" || endpointType === "aurora-cluster";

  return {
    host,
    port: portRaw,
    database,
    user,
    password,
    region,
    sslMode: sslModeRaw as AwsRdsSslMode,
    caCert,
    poolMax,
    environment,
    endpointType,
    isAwsRdsEndpoint,
    isRdsProxyOrCluster,
    credentialSource: secretPayload ? "aws_secrets_manager_json" : "environment",
  };
}

/**
 * Builds strict Node `tls.ConnectionOptions` for `pg.Pool` according to `AWS_RDS_SSL_MODE`:
 * - Never allows plaintext (`ssl: false` is prohibited).
 * - Never silently downgrades `verify-ca` or `verify-full` to `rejectUnauthorized: false`.
 * - `require`: Requires TLS encryption; verifies CA if `caCert` is provided.
 * - `verify-ca`: Enforces `rejectUnauthorized: true` (CA chain verification) without hostname check.
 * - `verify-full`: Enforces `rejectUnauthorized: true` AND strict hostname verification against `config.host`.
 */
export function buildPostgresTlsOptions(config: AwsPostgresConfig): TlsConnectionOptions {
  if (config.sslMode === "verify-full") {
    return {
      rejectUnauthorized: true,
      servername: config.host,
      ...(config.caCert ? { ca: config.caCert } : {}),
      checkServerIdentity: (hostname, cert) => tls.checkServerIdentity(hostname, cert),
    };
  }

  if (config.sslMode === "verify-ca") {
    return {
      rejectUnauthorized: true,
      servername: config.host,
      ...(config.caCert ? { ca: config.caCert } : {}),
      // PostgreSQL verify-ca validates the certificate chain against the CA without hostname matching
      checkServerIdentity: () => undefined,
    };
  }

  // sslMode === "require": TLS transport encryption is mandatory; if caCert is supplied, also verify CA
  return {
    rejectUnauthorized: Boolean(config.caCert),
    servername: config.host,
    ...(config.caCert ? { ca: config.caCert } : {}),
  };
}

/**
 * Prevents external non-VPC environments (such as Google AI Studio preview) from attempting
 * direct TCP connections to the private Mumbai RDS instance (`aurelia-timeflow-db-mumbai`).
 */
export function assertPrivateVpcNetworkBoundary(
  config: AwsPostgresConfig,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): void {
  const isPrivateMumbaiRds =
    config.host.includes("aurelia-timeflow-db-mumbai") ||
    config.host.endsWith(".ap-south-1.rds.amazonaws.com");
  const isPrivateVpcRuntime =
    (env["AWS_PRIVATE_VPC_EXECUTION"] ?? "").toLowerCase().trim() === "true";

  if (isPrivateMumbaiRds && !isPrivateVpcRuntime) {
    throw new Error(
      "PRIVATE_VPC_BOUNDARY: Production RDS in ap-south-1 (Publicly accessible = No) is only reachable from inside the private AWS VPC. Direct connections outside the VPC are prohibited. Set AWS_PRIVATE_VPC_EXECUTION=true only inside a verified AWS VPC runtime.",
    );
  }
}

// ============================================================================
// 3. Lazy Connection Pool (pg.Pool), Graceful Shutdown & Drizzle ORM
// ============================================================================

export type AureliaAwsDb = NodePgDatabase<typeof schema>;

declare global {
  var _aureliaAwsPgPool: Pool | undefined;
  var _aureliaAwsDrizzleDb: AureliaAwsDb | undefined;
  var _aureliaAwsShutdownRegistered: boolean | undefined;
}

/**
 * Creates or returns a cached `pg.Pool` configured for AWS RDS PostgreSQL
 * using explicit TLS options (`buildPostgresTlsOptions`).
 */
export function getAwsPostgresPool(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): Pool {
  const config = validateAwsPostgresConfig(env);
  assertPrivateVpcNetworkBoundary(config, env);

  if (!globalThis._aureliaAwsPgPool) {
    globalThis._aureliaAwsPgPool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.poolMax,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: buildPostgresTlsOptions(config),
    });

    globalThis._aureliaAwsPgPool.on("error", (err) => {
      console.error(
        "Unexpected error on idle AWS PostgreSQL pool client:",
        redactPostgresCredentials(err.message, config.password),
      );
    });

    registerAwsPostgresGracefulShutdown();
  }

  return globalThis._aureliaAwsPgPool;
}

/**
 * Drains and closes the active `pg.Pool` cleanly during container shutdown (`SIGTERM` / `SIGINT`).
 */
export async function closeAwsPostgresPool(): Promise<void> {
  const pool = globalThis._aureliaAwsPgPool;
  globalThis._aureliaAwsPgPool = undefined;
  globalThis._aureliaAwsDrizzleDb = undefined;
  if (pool) {
    await pool.end();
  }
}

/**
 * Registers once-per-process `SIGTERM` and `SIGINT` handlers to drain the PostgreSQL pool
 * cleanly when AWS ECS Fargate or App Runner stops a container task.
 */
export function registerAwsPostgresGracefulShutdown(): void {
  if (globalThis._aureliaAwsShutdownRegistered || typeof process === "undefined") {
    return;
  }
  globalThis._aureliaAwsShutdownRegistered = true;

  const handleSignal = () => {
    void closeAwsPostgresPool().catch(() => {
      // Ignore pool shutdown errors during process termination
    });
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}

/**
 * Returns a Drizzle ORM instance bound to the AWS RDS PostgreSQL connection pool.
 */
export function getAwsPostgresDb(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): AureliaAwsDb {
  const pool = getAwsPostgresPool(env);
  if (!globalThis._aureliaAwsDrizzleDb) {
    globalThis._aureliaAwsDrizzleDb = drizzle(pool, { schema });
  }
  return globalThis._aureliaAwsDrizzleDb;
}

// ============================================================================
// 4. Multi-Tenant Enforcement, Role Verification & RLS Transaction Wrapper
// ============================================================================

/**
 * Verifies that a resolved tenant context is authentic, active, and consistent,
 * and rejects any mismatch between a request's claimed tenantId and the authenticated membership.
 */
export function assertValidTenantExecutionContext(
  ctx: ResolvedTenantContext,
  claimedFrontendTenantId?: string,
): string {
  if (!ctx?.tenant?.id || !ctx?.membership?.id || !ctx?.user?.id) {
    throw new TenantIsolationError("Missing authenticated tenant context.");
  }
  if (ctx.tenant.status === "suspended" || ctx.tenant.status === "archived") {
    throw new TenantIsolationError(`Tenant ${ctx.tenant.id} is not active.`);
  }
  if (ctx.membership.status !== "active") {
    throw new TenantIsolationError(
      `User ${ctx.user.id} does not hold an active membership in tenant ${ctx.tenant.id}.`,
    );
  }
  if (ctx.membership.tenantId !== ctx.tenant.id) {
    throw new TenantIsolationError(
      "Critical tenant context mismatch between membership.tenantId and tenant.id.",
    );
  }
  if (claimedFrontendTenantId !== undefined && claimedFrontendTenantId !== ctx.tenant.id) {
    throw new TenantIsolationError(
      `Rejected untrusted frontend tenant_id "${claimedFrontendTenantId}" (authenticated membership belongs to "${ctx.tenant.id}").`,
    );
  }
  return ctx.tenant.id;
}

/**
 * Builds the parameterized SQL statement that activates PostgreSQL Row-Level Security (RLS)
 * for the current transaction (`SET LOCAL app.current_tenant_id`).
 */
export function buildTenantRlsConfigSql(
  ctx: ResolvedTenantContext,
  claimedFrontendTenantId?: string,
) {
  const verifiedTenantId = assertValidTenantExecutionContext(ctx, claimedFrontendTenantId);
  return {
    verifiedTenantId,
    statement: sql`SELECT set_config('app.current_tenant_id', ${verifiedTenantId}, true)`,
  };
}

/**
 * Inspects the active PostgreSQL database role to verify it is neither a superuser
 * nor granted `BYPASSRLS`, ensuring Row-Level Security policies cannot be bypassed.
 */
export async function verifyApplicationDatabaseRole(
  client: Pick<QueryableTransactionClient, "query">,
): Promise<DatabaseRoleSecurityStatus> {
  const result = await client.query(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0] as
    { rolname?: string; rolsuper?: boolean; rolbypassrls?: boolean } | undefined;

  if (!row) {
    throw new TenantIsolationError(
      "Unable to verify current PostgreSQL database role in pg_roles.",
    );
  }

  const isSuperuser = Boolean(row.rolsuper);
  const hasBypassRls = Boolean(row.rolbypassrls);

  return {
    roleName: String(row.rolname ?? "unknown"),
    isSuperuser,
    hasBypassRls,
    isLeastPrivilegeSafe: !isSuperuser && !hasBypassRls,
  };
}

/**
 * Throws a `TenantIsolationError` if the current PostgreSQL connection role is a superuser
 * or has `BYPASSRLS` enabled.
 */
export async function assertApplicationDatabaseRoleSecurity(
  client: Pick<QueryableTransactionClient, "query">,
): Promise<DatabaseRoleSecurityStatus> {
  const status = await verifyApplicationDatabaseRole(client);
  if (!status.isLeastPrivilegeSafe) {
    throw new TenantIsolationError(
      `SECURITY_VIOLATION: Application database role "${status.roleName}" must not be SUPERUSER (${status.isSuperuser}) or have BYPASSRLS (${status.hasBypassRls}).`,
    );
  }
  return status;
}

/**
 * Executes a tenant-scoped database callback inside a real PostgreSQL transaction (`BEGIN ... COMMIT / ROLLBACK`)
 * on a single dedicated connection acquired from the connection pool:
 * 1. Validates authenticated tenant and membership context (never trusting browser tenant_id).
 * 2. Acquires one dedicated `PoolClient` from `pg.Pool`.
 * 3. Starts transaction with `BEGIN`.
 * 4. Sets `app.current_tenant_id` via transaction-scoped `set_config('app.current_tenant_id', $1, true)` (`SET LOCAL`).
 * 5. Binds a Drizzle ORM instance (`txContext.db`) to that exact transaction connection so all queries share the transaction.
 * 6. Commits on success (`COMMIT`) or rolls back on any error (`ROLLBACK`).
 * 7. Always releases the connection in `finally`, preventing any tenant context leakage across pooled connections.
 */
export async function withTenantDatabaseScope<T>(
  ctx: ResolvedTenantContext,
  callback: (verifiedTenantId: string, txContext: TenantTransactionContext) => Promise<T>,
  options?: {
    claimedFrontendTenantId?: string;
    pool?: QueryableTransactionPool;
    env?: Record<string, string | undefined>;
    enforceLeastPrivilegeRole?: boolean;
    executeRlsInit?: (tenantId: string) => Promise<void>;
  },
): Promise<T> {
  // Step 1: Validate authenticated tenant & membership before touching the database pool
  const { verifiedTenantId } = buildTenantRlsConfigSql(ctx, options?.claimedFrontendTenantId);

  // Step 2: Acquire a single dedicated PostgreSQL client for this transaction
  const targetPool: QueryableTransactionPool = options?.pool ?? getAwsPostgresPool(options?.env);
  const client = await targetPool.connect();

  let transactionStarted = false;
  try {
    // Step 3: Begin transaction on the dedicated connection
    await client.query("BEGIN");
    transactionStarted = true;

    // Step 4: Optional strict role verification (NOSUPERUSER + NOBYPASSRLS)
    if (options?.enforceLeastPrivilegeRole) {
      await assertApplicationDatabaseRoleSecurity(client);
    }

    // Step 5: Set transaction-local tenant context (`is_local = true`, equivalent to SET LOCAL)
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [verifiedTenantId]);

    if (options?.executeRlsInit) {
      await options.executeRlsInit(verifiedTenantId);
    }

    // Step 6: Bind Drizzle ORM to this exact transaction client so all queries run on the same connection
    const txDb = drizzle(client as unknown as PoolClient, { schema });
    const result = await callback(verifiedTenantId, {
      verifiedTenantId,
      db: txDb,
      client,
    });

    // Step 7: Clear transaction-local GUC before commit as defense-in-depth and commit transaction
    await client.query("SELECT set_config('app.current_tenant_id', '', true)");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Step 8: Roll back transaction on any failure (automatically discarding set_config(..., true))
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve original error if rollback itself fails on a broken connection
      }
    }
    throw error;
  } finally {
    // Step 9: Always release the connection back to the pool
    client.release();
  }
}

/**
 * Provides type-safe Drizzle ORM table filter predicates scoped to the verified tenant.
 */
export function createTenantScopedFilters(
  ctx: ResolvedTenantContext,
  claimedFrontendTenantId?: string,
) {
  const tenantId = assertValidTenantExecutionContext(ctx, claimedFrontendTenantId);
  return {
    tenantId,
    membershipsFilter: eq(schema.memberships.tenantId, tenantId),
    projectsFilter: eq(schema.projects.tenantId, tenantId),
    timesheetsFilter: eq(schema.timesheets.tenantId, tenantId),
    leaveRequestsFilter: eq(schema.leaveRequests.tenantId, tenantId),
    approvalsFilter: eq(schema.approvals.tenantId, tenantId),
    resourceAllocationsFilter: eq(schema.resourceAllocations.tenantId, tenantId),
    auditLogsFilter: eq(schema.auditLogs.tenantId, tenantId),
  };
}

// ============================================================================
// 5. AWS RDS PostgreSQL Health Check & System Role Seeding
// ============================================================================

/**
 * Provides private-VPC-aware AWS networking diagnostics for RDS connectivity.
 * Respects private RDS topology (Publicly accessible = No).
 */
export function classifyAwsRdsConnectivityError(errorMessage: string): string | undefined {
  if (errorMessage.includes("PRIVATE_VPC_BOUNDARY")) {
    return "RDS instance in ap-south-1 is intentionally private (Publicly accessible = No). Run backend and migrations from inside the AWS VPC with AWS_PRIVATE_VPC_EXECUTION=true.";
  }
  if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("EAI_AGAIN")) {
    return "Private VPC endpoint DNS is only resolvable from inside the AWS VPC (ap-south-1). Keep RDS 'Publicly accessible = No' and execute backend/migrations from an AWS-hosted compute resource (ECS/Fargate, EC2, App Runner VPC Connector, or CodeBuild) within the same VPC.";
  }
  if (errorMessage.includes("ETIMEDOUT") || errorMessage.includes("ECONNREFUSED")) {
    return "Private VPC TCP connection timed out on port 5432. Verify that the AWS backend compute security group is permitted by the RDS security group inbound rule on TCP 5432 within the private VPC.";
  }
  if (errorMessage.includes("password authentication failed")) {
    return "PostgreSQL authentication failed. Verify AWS_RDS_USER and AWS_RDS_PASSWORD in your environment variables or AWS Secrets Manager secret.";
  }
  if (errorMessage.includes("does not exist") && errorMessage.includes("database")) {
    return "Target PostgreSQL database does not exist yet on the RDS instance. Connect to AWS_RDS_DATABASE=postgres or run 0000_create_database_and_role.sql from inside the private VPC first.";
  }
  return undefined;
}

/**
 * Performs a credential-redacted health check for the AWS RDS PostgreSQL connection.
 */
export async function checkAwsDatabaseHealth(options?: {
  env?: Record<string, string | undefined>;
  pingExecutor?: (config: AwsPostgresConfig) => Promise<void>;
}): Promise<AwsDatabaseHealthReport> {
  const env = options?.env ?? (typeof process !== "undefined" ? process.env : {});
  const environment = getAppEnvironment(env);
  const region = (env["AWS_REGION"] ?? "ap-south-1").trim();
  const databaseName = (env["AWS_RDS_DATABASE"] ?? DEFAULT_AWS_RDS_DATABASE).trim();
  const rawHost = (env["AWS_RDS_HOST"] ?? "").trim();
  const hasSecretJson = Boolean((env["AWS_RDS_SECRET_JSON"] ?? "").trim());

  if (!rawHost && !hasSecretJson) {
    return {
      status: "unconfigured",
      provider: "aws-rds-postgresql",
      environment,
      region,
      host: null,
      endpointType: null,
      port: Number(env["AWS_RDS_PORT"] ?? DEFAULT_AWS_RDS_PORT),
      databaseName,
      sslEnforced: false,
      sslMode: null,
      caVerified: false,
      hostnameVerified: false,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      message:
        "AWS_RDS_HOST is not configured in environment variables. Application is running in local/demo mode.",
    };
  }

  let config: AwsPostgresConfig;
  try {
    config = validateAwsPostgresConfig(env);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : "Invalid AWS RDS configuration";
    return {
      status: "unhealthy",
      provider: "aws-rds-postgresql",
      environment,
      region,
      host: rawHost || null,
      endpointType: rawHost ? classifyAwsRdsEndpointType(rawHost) : null,
      port: Number(env["AWS_RDS_PORT"] ?? DEFAULT_AWS_RDS_PORT),
      databaseName,
      sslEnforced: false,
      sslMode: env["AWS_RDS_SSL_MODE"] ?? null,
      caVerified: false,
      hostnameVerified: false,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      message: redactPostgresCredentials(rawMsg, env["AWS_RDS_PASSWORD"]),
    };
  }

  const tlsOpts = buildPostgresTlsOptions(config);
  const caVerified = Boolean(tlsOpts.rejectUnauthorized);
  const hostnameVerified = config.sslMode === "verify-full";

  const startedAt = Date.now();
  try {
    if (options?.pingExecutor) {
      await options.pingExecutor(config);
    } else {
      const pool = getAwsPostgresPool(env);
      await pool.query("SELECT 1 AS ok");
    }
    const latencyMs = Math.max(1, Date.now() - startedAt);
    return {
      status: "healthy",
      provider: "aws-rds-postgresql",
      environment: config.environment,
      region: config.region,
      host: config.host,
      endpointType: config.endpointType,
      port: config.port,
      databaseName: config.database,
      sslEnforced: true,
      sslMode: config.sslMode,
      caVerified,
      hostnameVerified,
      latencyMs,
      checkedAt: new Date().toISOString(),
      message: `AWS PostgreSQL connection verified for database "${config.database}" (${config.region}).`,
    };
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    const safeError = redactPostgresCredentials(rawError, config.password);
    return {
      status: "unhealthy",
      provider: "aws-rds-postgresql",
      environment: config.environment,
      region: config.region,
      host: config.host,
      endpointType: config.endpointType,
      port: config.port,
      databaseName: config.database,
      sslEnforced: true,
      sslMode: config.sslMode,
      caVerified,
      hostnameVerified,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      message: `AWS PostgreSQL health check failed: ${safeError}`,
      diagnosticHint: classifyAwsRdsConnectivityError(safeError),
    };
  }
}

/**
 * Seeds the 20 system permissions and 4 default system roles (`business_admin`, `manager`,
 * `team_lead`, `employee`) idempotently into AWS RDS PostgreSQL via Drizzle ORM.
 */
export async function seedSystemRolesInAwsPostgres(db: AureliaAwsDb): Promise<void> {
  for (const perm of SYSTEM_PERMISSION_CATALOG) {
    await db
      .insert(schema.permissions)
      .values({
        code: perm.code,
        module: perm.module,
        description: perm.description,
      })
      .onConflictDoNothing({ target: schema.permissions.code });
  }

  for (const roleDef of SYSTEM_ROLE_DEFINITIONS) {
    await db
      .insert(schema.roles)
      .values({
        tenantId: null,
        key: roleDef.key,
        name: roleDef.name,
        description: roleDef.description,
        isSystemRole: true,
      })
      .onConflictDoNothing();
  }
}
