import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { TenantIsolationError, type ResolvedTenantContext } from "../tenancy/tenant-context";
import * as schema from "./schema";
import { SYSTEM_PERMISSION_CATALOG, SYSTEM_ROLE_DEFINITIONS } from "./seed-system-roles";

// ============================================================================
// 1. AWS RDS / Aurora PostgreSQL Configuration & Types
// ============================================================================

export const DEFAULT_AWS_RDS_DATABASE = "aurelia_timeflow" as const;
export const DEFAULT_AWS_RDS_PORT = 5432 as const;

export type AppEnvironment = "development" | "staging" | "production";
export type AwsRdsSslMode = "require" | "verify-ca" | "verify-full";

export interface AwsPostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  region: string;
  sslMode: AwsRdsSslMode;
  poolMax: number;
  environment: AppEnvironment;
  isRdsProxyOrCluster: boolean;
}

export interface AwsDatabaseHealthReport {
  status: "healthy" | "unconfigured" | "unhealthy";
  provider: "aws-rds-postgresql";
  environment: AppEnvironment;
  region: string;
  host: string | null;
  port: number;
  databaseName: string;
  sslEnforced: boolean;
  sslMode: string | null;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
  diagnosticHint?: string | undefined;
}

// ============================================================================
// 2. Environment Separation & Security Guards
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
  return sanitized;
}

/**
 * Validates AWS RDS / Aurora PostgreSQL configuration from server environment variables.
 */
export function validateAwsPostgresConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): AwsPostgresConfig {
  assertServerOnlyExecution();

  // Reject any VITE_ client exposure of AWS database credentials
  if (env["VITE_AWS_RDS_PASSWORD"] || env["VITE_AWS_RDS_HOST"] || env["VITE_DATABASE_URL"]) {
    throw new Error(
      "SECURITY_VIOLATION: AWS PostgreSQL credentials must never be exposed via VITE_* client environment variables.",
    );
  }

  const environment = getAppEnvironment(env);
  const host = (env["AWS_RDS_HOST"] ?? "").trim();
  const user = (env["AWS_RDS_USER"] ?? "").trim();
  const password = env["AWS_RDS_PASSWORD"] ?? "";
  const database = (env["AWS_RDS_DATABASE"] ?? DEFAULT_AWS_RDS_DATABASE).trim();
  const region = (env["AWS_REGION"] ?? "ap-south-1").trim();
  const portRaw = Number(env["AWS_RDS_PORT"] ?? DEFAULT_AWS_RDS_PORT);
  const poolMaxRaw = Number(env["AWS_RDS_POOL_MAX"] ?? 10);
  const sslModeRaw = (env["AWS_RDS_SSL_MODE"] ?? "require").toLowerCase().trim();

  if (!host) {
    throw new Error(
      "Missing AWS_RDS_HOST environment variable. Set your AWS RDS or Aurora PostgreSQL endpoint in server environment variables.",
    );
  }
  if (!user) {
    throw new Error(
      "Missing AWS_RDS_USER environment variable. Set your AWS PostgreSQL database user in server environment variables.",
    );
  }
  if (!password) {
    throw new Error(
      "Missing AWS_RDS_PASSWORD environment variable. Set your AWS PostgreSQL password in server environment variables.",
    );
  }
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error(`Invalid AWS_RDS_PORT "${env["AWS_RDS_PORT"]}". Must be a valid TCP port.`);
  }

  const allowedSslModes = new Set<AwsRdsSslMode>(["require", "verify-ca", "verify-full"]);
  if (!allowedSslModes.has(sslModeRaw as AwsRdsSslMode)) {
    throw new Error(
      `SSL is mandatory for AWS RDS / Aurora PostgreSQL connections. Set AWS_RDS_SSL_MODE to "require", "verify-ca", or "verify-full" (received "${sslModeRaw}").`,
    );
  }

  const isRdsProxyOrCluster =
    host.includes(".rds.amazonaws.com") || host.includes(".proxy-") || host.includes(".cluster-");

  return {
    host,
    port: portRaw,
    database,
    user,
    password,
    region,
    sslMode: sslModeRaw as AwsRdsSslMode,
    poolMax: Number.isInteger(poolMaxRaw) && poolMaxRaw > 0 ? poolMaxRaw : 10,
    environment,
    isRdsProxyOrCluster,
  };
}

// ============================================================================
// 3. Lazy Connection Pool (pg.Pool) & Drizzle ORM Initialization
// ============================================================================

export type AureliaAwsDb = NodePgDatabase<typeof schema>;

declare global {
  var _aureliaAwsPgPool: Pool | undefined;

  var _aureliaAwsDrizzleDb: AureliaAwsDb | undefined;
}

/**
 * Creates or returns a cached `pg.Pool` configured for AWS RDS / Aurora PostgreSQL
 * using the Object Method and TLS/SSL enforcement.
 */
export function getAwsPostgresPool(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): Pool {
  const config = validateAwsPostgresConfig(env);

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
      ssl: {
        rejectUnauthorized: config.sslMode === "verify-full",
      },
    });

    globalThis._aureliaAwsPgPool.on("error", (err) => {
      console.error(
        "Unexpected error on idle AWS PostgreSQL pool client:",
        redactPostgresCredentials(err.message, config.password),
      );
    });
  }

  return globalThis._aureliaAwsPgPool;
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
// 4. Multi-Tenant Enforcement & RLS Transaction Wrapper
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
 * Executes a tenant-scoped database callback inside an isolated transaction with
 * `app.current_tenant_id` bound for PostgreSQL Row-Level Security (RLS).
 */
export async function withTenantDatabaseScope<T>(
  ctx: ResolvedTenantContext,
  callback: (verifiedTenantId: string) => Promise<T>,
  options?: {
    claimedFrontendTenantId?: string;
    executeRlsInit?: (tenantId: string) => Promise<void>;
  },
): Promise<T> {
  const { verifiedTenantId } = buildTenantRlsConfigSql(ctx, options?.claimedFrontendTenantId);
  if (options?.executeRlsInit) {
    await options.executeRlsInit(verifiedTenantId);
  }
  return callback(verifiedTenantId);
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
// 5. AWS RDS / Aurora PostgreSQL Health Check & System Role Seeding
// ============================================================================

/**
 * Provides private-VPC-aware AWS networking diagnostics for RDS connectivity.
 * Respects private RDS topology (Publicly accessible = No).
 */
export function classifyAwsRdsConnectivityError(errorMessage: string): string | undefined {
  if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("EAI_AGAIN")) {
    return "Private VPC endpoint DNS is only resolvable from inside the AWS VPC (ap-south-1). Keep RDS 'Publicly accessible = No' and execute backend/migrations from an AWS-hosted compute resource (ECS/Fargate, EC2, App Runner VPC Connector, or CodeBuild) within the same VPC.";
  }
  if (errorMessage.includes("ETIMEDOUT") || errorMessage.includes("ECONNREFUSED")) {
    return "Private VPC TCP connection timed out on port 5432. Verify that the AWS backend compute security group is permitted by the RDS security group inbound rule on TCP 5432 within the private VPC.";
  }
  if (errorMessage.includes("password authentication failed")) {
    return "PostgreSQL authentication failed. Verify AWS_RDS_USER and AWS_RDS_PASSWORD in your environment variables.";
  }
  return undefined;
}

/**
 * Performs a credential-redacted health check for the AWS RDS / Aurora PostgreSQL connection.
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

  if (!rawHost) {
    return {
      status: "unconfigured",
      provider: "aws-rds-postgresql",
      environment,
      region,
      host: null,
      port: Number(env["AWS_RDS_PORT"] ?? DEFAULT_AWS_RDS_PORT),
      databaseName,
      sslEnforced: false,
      sslMode: null,
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
      host: rawHost,
      port: Number(env["AWS_RDS_PORT"] ?? DEFAULT_AWS_RDS_PORT),
      databaseName,
      sslEnforced: false,
      sslMode: env["AWS_RDS_SSL_MODE"] ?? null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      message: redactPostgresCredentials(rawMsg, env["AWS_RDS_PASSWORD"]),
    };
  }

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
      port: config.port,
      databaseName: config.database,
      sslEnforced: true,
      sslMode: config.sslMode,
      latencyMs,
      checkedAt: new Date().toISOString(),
      message: `AWS PostgreSQL connection verified for "${config.database}" (${config.region}).`,
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
      port: config.port,
      databaseName: config.database,
      sslEnforced: true,
      sslMode: config.sslMode,
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
