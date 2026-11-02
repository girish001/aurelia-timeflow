// @vitest-environment node
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import type { QueryResult } from "pg";
import { describe, expect, it, beforeEach } from "vitest";

import { defaultAuthService } from "../server/auth/auth-service";
import {
  AwsSesEmailProvider,
  defaultEmailDeliveryProvider,
  getDevelopmentEmailOutbox,
  isAwsSesConfigured,
  loadAwsSesConfig,
  resolveAppPublicUrl,
  resolveEmailDeliveryProvider,
  validateEmailDeliveryEnvironment,
} from "../server/auth/email-provider";
import { hashPassword, verifyPassword, validatePasswordComplexity } from "../server/auth/password";
import { defaultSessionManager, SessionManager } from "../server/auth/session-manager";
import {
  defaultSsoService,
  loadOidcConfigFromAwsSecrets,
  type OidcProviderConfig,
} from "../server/auth/sso-service";
import { handleApiRequest } from "../server/api/routes";
import type {
  AureliaAwsDb,
  QueryableTransactionClient,
  QueryableTransactionPool,
} from "../server/db/aws-postgres";
import * as schema from "../server/db/schema";
import {
  registerCompanyInDb,
  verifyCompanyAdminEmailInDb,
} from "../server/repositories/postgres-tenant-store";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";
import type { UserRecord } from "../server/tenancy/tenant-context";

describe("Phase 2: Production Authentication & Security Remediation", { timeout: 30000 }, () => {
  let store: MultiTenantDataStore;
  const authService = defaultAuthService;
  const sessionManager = defaultSessionManager;
  const ssoService = defaultSsoService;

  const tenantAlphaId = "tenant_alpha_corp";
  const tenantBetaId = "tenant_beta_corp";

  const adminUser = {
    id: "user_alpha_admin",
    email: "admin@alpha.example.com",
    fullName: "Aarav Admin",
    emailVerifiedAt: new Date().toISOString(),
    isPlatformAdmin: false,
    status: "active" as const,
  };

  const managerUser = {
    id: "user_alpha_manager",
    email: "manager@alpha.example.com",
    fullName: "Maya Manager",
    emailVerifiedAt: new Date().toISOString(),
    isPlatformAdmin: false,
    status: "active" as const,
  };

  const employeeUser = {
    id: "user_alpha_employee",
    email: "employee@alpha.example.com",
    fullName: "Ishaan Employee",
    emailVerifiedAt: new Date().toISOString(),
    isPlatformAdmin: false,
    status: "active" as const,
  };

  const betaAdminUser = {
    id: "user_beta_admin",
    email: "admin@beta.example.com",
    fullName: "Bhavna Beta",
    emailVerifiedAt: new Date().toISOString(),
    isPlatformAdmin: false,
    status: "active" as const,
  };

  const platformAdminUser = {
    id: "user_platform_superadmin",
    email: "superadmin@aurelia-platform.com",
    fullName: "Vikram Platform Admin",
    emailVerifiedAt: new Date().toISOString(),
    isPlatformAdmin: true,
    status: "active" as const,
  };

  const defaultPassword = "SecurePass123!@#";

  beforeEach(async () => {
    // Reset session store, rate limiter, reset service, and email outbox
    sessionManager.clear();
    authService.getRateLimiter().reset();
    authService.getPasswordResetService().reset();
    defaultEmailDeliveryProvider.clearOutbox();

    store = new MultiTenantDataStore();

    // Setup Tenant Alpha
    store.registerTenant({
      id: tenantAlphaId,
      name: "Alpha Corporation",
      slug: "alpha-corp",
      status: "active",
      onboardingMode: "self_service",
    });

    // Setup Tenant Beta
    store.registerTenant({
      id: tenantBetaId,
      name: "Beta Logistics",
      slug: "beta-logistics",
      status: "active",
      onboardingMode: "self_service",
    });

    // Hash default password
    const hashedPass = await hashPassword(defaultPassword);

    // Register Users with Password Hashes
    store.registerUser(adminUser, hashedPass);
    store.registerUser(managerUser, hashedPass);
    store.registerUser(employeeUser, hashedPass);
    store.registerUser(betaAdminUser, hashedPass);
    store.registerUser(platformAdminUser, hashedPass);

    // Create Tenant Alpha Memberships
    store.createMembership({
      id: "mem_alpha_admin",
      tenantId: tenantAlphaId,
      userId: adminUser.id,
      jobTitle: "Chief Technology Officer",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: tenantAlphaId,
      membershipId: "mem_alpha_admin",
      roleKey: "business_admin",
    });

    store.createMembership({
      id: "mem_alpha_manager",
      tenantId: tenantAlphaId,
      userId: managerUser.id,
      jobTitle: "Engineering Manager",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: tenantAlphaId,
      membershipId: "mem_alpha_manager",
      roleKey: "manager",
    });

    store.createMembership({
      id: "mem_alpha_employee",
      tenantId: tenantAlphaId,
      userId: employeeUser.id,
      jobTitle: "Software Engineer",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: tenantAlphaId,
      membershipId: "mem_alpha_employee",
      roleKey: "employee",
    });

    // Create Tenant Beta Membership (isolated)
    store.createMembership({
      id: "mem_beta_admin",
      tenantId: tenantBetaId,
      userId: betaAdminUser.id,
      jobTitle: "Managing Director",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: tenantBetaId,
      membershipId: "mem_beta_admin",
      roleKey: "business_admin",
    });

    // Seed Project, Reporting Line & Timesheet in Tenant Alpha
    store.createProject({
      id: "proj_alpha_01",
      tenantId: tenantAlphaId,
      name: "Core Platform",
      code: "CORE",
      status: "active",
      budgetHours: 200,
      projectManagerMembershipId: "mem_alpha_manager",
    });

    store.addReportingLine({
      id: "rep_alpha_01",
      tenantId: tenantAlphaId,
      subordinateMembershipId: "mem_alpha_employee",
      managerMembershipId: "mem_alpha_manager",
    });

    store.createTimesheet({
      id: "ts_alpha_01",
      tenantId: tenantAlphaId,
      membershipId: "mem_alpha_employee",
      projectId: "proj_alpha_01",
      weekStartDate: "2026-10-26",
      totalHours: 40,
      status: "submitted",
    });
  });

  describe("1. Password Security & Hashing Standards", () => {
    it("hashes passwords using scrypt with 32-byte cryptographically secure salt", async () => {
      const hash = await hashPassword("MyTestPass123!@#");
      expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[a-f0-9]{64}\$[a-f0-9]{128}$/);

      const isValid = await verifyPassword("MyTestPass123!@#", hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword("WrongPassword123!@#", hash);
      expect(isValid).not.toBe(isInvalid);
      expect(isInvalid).toBe(false);
    });

    it("enforces strong password complexity rules", () => {
      expect(validatePasswordComplexity("short").valid).toBe(false);
      expect(validatePasswordComplexity("alllowercase123!").valid).toBe(false);
      expect(validatePasswordComplexity("ALLUPPERCASE123!").valid).toBe(false);
      expect(validatePasswordComplexity("NoSpecialChar123").valid).toBe(false);
      expect(validatePasswordComplexity("NoNumbersHere!@#").valid).toBe(false);
      expect(validatePasswordComplexity("ValidPass123!@#").valid).toBe(true);
    });
  });

  describe("2. Removal of Authentication Bypasses & Forged Identity Protection", () => {
    it("rejects forged x-aurelia-user-id header with HTTP 401 UNAUTHENTICATED", async () => {
      const res = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/team`, {
          headers: {
            "x-aurelia-user-id": adminUser.id,
          },
        }),
        { store },
      );

      expect(res?.status).toBe(401);
      const body = (await res?.json()) as { error: string };
      expect(body.error).toBe("UNAUTHENTICATED");
    });

    it("rejects forged Authorization: Bearer user:<id> header with HTTP 401 UNAUTHENTICATED", async () => {
      const res = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/projects`, {
          headers: {
            authorization: `Bearer user:${adminUser.id}`,
          },
        }),
        { store },
      );

      expect(res?.status).toBe(401);
      const body = (await res?.json()) as { error: string };
      expect(body.error).toBe("UNAUTHENTICATED");
    });

    it("rejects login attempts supplying only userId without password", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ userId: adminUser.id }),
        }),
        { store },
      );

      expect(res?.status).toBe(400);
    });

    it("rejects forged x-aurelia-platform-admin: true header from a non-platform-admin user with HTTP 403", async () => {
      // Regular tenant admin logs in with a real session
      const loginRes = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      // Attempts to call platform-admin endpoint by forging x-aurelia-platform-admin: true
      const forgedPlatformRes = await handleApiRequest(
        new Request("http://localhost/api/v1/platform-admin/tenants", {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${loginRes.sessionToken}`,
            "x-aurelia-platform-admin": "true",
          },
          body: JSON.stringify({
            companyName: "Forged Enterprise Corp",
            slug: "forged-ent",
            primaryDomain: "forged.example.com",
            primaryAdminEmail: "it@forged.example.com",
            primaryAdminFullName: "Forged IT",
          }),
        }),
        { store },
      );

      expect(forgedPlatformRes?.status).toBe(403);
      const body = (await forgedPlatformRes?.json()) as { error: string };
      expect(body.error).toBe("INSUFFICIENT_PERMISSIONS");

      // Genuine platform admin verified via server-side user record succeeds (201)
      const superAdminLogin = await authService.login(
        { email: platformAdminUser.email, password: defaultPassword },
        { store },
      );
      const legitimatePlatformRes = await handleApiRequest(
        new Request("http://localhost/api/v1/platform-admin/tenants", {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${superAdminLogin.sessionToken}`,
          },
          body: JSON.stringify({
            companyName: "Legitimate Enterprise Corp",
            slug: "legit-ent",
            primaryDomain: "legit.example.com",
            primaryAdminEmail: "it@legit.example.com",
            primaryAdminFullName: "Legit IT",
          }),
        }),
        { store },
      );
      expect(legitimatePlatformRes?.status).toBe(201);
    });
  });

  describe("3. Valid and Invalid Login & Rate Limiting", () => {
    it("successfully logs in with valid credentials, issuing session and HttpOnly cookie", async () => {
      const loginRes = await authService.login(
        {
          email: adminUser.email,
          password: defaultPassword,
          ipAddress: "127.0.0.1",
        },
        { store, isSecureRequest: true },
      );

      expect(loginRes.user.id).toBe(adminUser.id);
      expect(loginRes.sessionToken).toBeTruthy();
      expect(loginRes.session.userId).toBe(adminUser.id);
      expect(loginRes.setCookieHeader).toContain("HttpOnly");
      expect(loginRes.setCookieHeader).toContain("Secure");
      expect(loginRes.setCookieHeader).toContain("SameSite=Lax");
      expect(loginRes.tenants).toHaveLength(1);
      expect(loginRes.tenants[0]?.tenant.id).toBe(tenantAlphaId);
    });

    it("fails login with incorrect password and does not reveal sensitive info", async () => {
      await expect(
        authService.login(
          {
            email: adminUser.email,
            password: "WrongPassword999!",
            ipAddress: "127.0.0.1",
          },
          { store },
        ),
      ).rejects.toThrow("Invalid email or password.");
    });

    it("fails login for non-existent email with generic error to prevent user enumeration", async () => {
      await expect(
        authService.login(
          {
            email: "nonexistent@unknown.example",
            password: "SomePassword123!",
            ipAddress: "127.0.0.1",
          },
          { store },
        ),
      ).rejects.toThrow("Invalid email or password.");
    });

    it("throttles login attempts after 5 consecutive failures (brute-force protection)", async () => {
      const email = "victim@example.com";
      const ip = "192.168.1.100";

      for (let i = 0; i < 5; i++) {
        await expect(
          authService.login({ email, password: "BadPassword!", ipAddress: ip }, { store }),
        ).rejects.toThrow("Invalid email or password.");
      }

      await expect(
        authService.login({ email, password: defaultPassword, ipAddress: ip }, { store }),
      ).rejects.toThrow(/Too many failed login attempts/);
    });
  });

  describe("4. Persistent PostgreSQL Session Management, Restart Survival & Multi-Instance Concurrency", () => {
    async function setupPostgresForSessions() {
      const pg = new PGlite();
      const migration1 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0001_initial_multi_tenant.sql"),
        "utf8",
      );
      const migration2 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0002_auth_persistence.sql"),
        "utf8",
      );
      await pg.exec(migration1);
      await pg.exec(migration2);

      const pgliteClient: QueryableTransactionClient = {
        query: async (
          textOrConfig: string | { text: string; values?: unknown[]; rowMode?: string },
          values?: unknown[],
        ) => {
          let text: string;
          let params: unknown[];
          let rowMode: "array" | "object" | undefined = undefined;

          if (typeof textOrConfig === "string") {
            text = textOrConfig;
            params = Array.isArray(values) ? values : [];
          } else if (textOrConfig && typeof textOrConfig === "object") {
            text = textOrConfig.text;
            params =
              Array.isArray(values) && values.length > 0
                ? values
                : Array.isArray(textOrConfig.values)
                  ? textOrConfig.values
                  : [];
            if (textOrConfig.rowMode === "array") {
              rowMode = "array";
            }
          } else {
            text = String(textOrConfig);
            params = Array.isArray(values) ? values : [];
          }

          const res = await pg.query(text, params, rowMode ? { rowMode } : undefined);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
            command: "SELECT",
            oid: 0,
            fields: res.fields
              ? res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }))
              : [],
          } as unknown as QueryResult;
        },
        release: () => {},
      };

      const pool: QueryableTransactionPool = {
        connect: async () => pgliteClient,
      };

      const db = drizzle(pgliteClient as unknown as NodePgClient, {
        schema,
      }) as unknown as AureliaAwsDb;

      const userUuid = "aaaaaaaa-1111-4111-8111-111111111111";
      await pg.query(
        `INSERT INTO users (id, email, full_name, status, is_platform_admin)
         VALUES ($1, 'admin@alpha.example.com', 'Aarav Admin', 'active', false);`,
        [userUuid],
      );

      return { pg, db, pool, userUuid };
    }

    it("stores only SHA-256 session token hashes in PostgreSQL, survives backend restarts, and works across concurrent backend instances", async () => {
      const { pg, db, userUuid } = await setupPostgresForSessions();

      // Backend Instance 1 creates a session
      const instance1 = new SessionManager({ db });
      const { rawToken, session } = await instance1.createSessionInDb(
        userUuid,
        "admin@alpha.example.com",
        { ipAddress: "10.0.1.15", userAgent: "Mozilla/5.0" },
      );

      // Verify rawToken is NEVER stored in PostgreSQL user_sessions table; only SHA-256 token_hash
      const dbRows = await pg.query<{ token_hash: string }>(
        "SELECT token_hash FROM user_sessions WHERE session_id = $1;",
        [session.sessionId],
      );
      expect(dbRows.rows).toHaveLength(1);
      expect(dbRows.rows[0]?.token_hash).toBe(instance1.hashToken(rawToken));
      expect(dbRows.rows[0]?.token_hash).not.toBe(rawToken);

      // Simulate Backend Restart / Concurrent Backend Instance 2 (fresh SessionManager with empty memory)
      const instance2 = new SessionManager({ db });
      const validatedOnInstance2 = await instance2.validateSessionInDb(rawToken);
      expect(validatedOnInstance2).not.toBeNull();
      expect(validatedOnInstance2?.userId).toBe(userUuid);
      expect(validatedOnInstance2?.sessionId).toBe(session.sessionId);

      // Instance 2 rotates the session token
      const rotatedOnInstance2 = await instance2.rotateSessionInDb(rawToken);
      expect(rotatedOnInstance2).not.toBeNull();
      const newToken = rotatedOnInstance2!.newRawToken;
      expect(newToken).not.toBe(rawToken);

      // Old token is immediately invalid on Instance 1 as well
      expect(await instance1.validateSessionInDb(rawToken)).toBeNull();
      // New token is valid on Instance 1
      const validatedNewOnInstance1 = await instance1.validateSessionInDb(newToken);
      expect(validatedNewOnInstance1?.userId).toBe(userUuid);

      // Instance 1 revokes all user sessions -> Instance 2 immediately rejects the session
      await instance1.destroyAllUserSessionsInDb(userUuid);
      expect(await instance2.validateSessionInDb(newToken)).toBeNull();

      await pg.close();
    });

    it("rejects expired and idle-timed-out sessions with HTTP 401", async () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      // Artificially age the session beyond idle timeout (2 hours)
      sessionManager.simulateSessionAging(rawToken, 2 * 60 * 60 * 1000 + 1000);

      expect(sessionManager.validateSession(rawToken)).toBeNull();

      const res = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/team`, {
          headers: { cookie: `aurelia_session=${rawToken}` },
        }),
        { store },
      );
      expect(res?.status).toBe(401);
    });

    it("rotates session tokens safely and immediately invalidates the old token", () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      const rotated = sessionManager.rotateSession(rawToken, { secure: true });
      expect(rotated).not.toBeNull();
      expect(rotated?.newRawToken).not.toBe(rawToken);

      expect(sessionManager.validateSession(rawToken)).toBeNull();
      expect(sessionManager.validateSession(rotated!.newRawToken)?.userId).toBe(adminUser.id);
    });

    it("destroys session on logout and returns clearing cookie", async () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      const logoutRes = await authService.logout(rawToken);
      expect(logoutRes.setCookieHeader).toContain("Max-Age=0");
      expect(sessionManager.validateSession(rawToken)).toBeNull();
    });
  });

  describe("5. Multi-Tenant Authorization & RBAC Privilege Isolation", () => {
    it("blocks Employee from approving timesheets (missing timesheet:approve:team)", async () => {
      const empLogin = await authService.login(
        { email: employeeUser.email, password: defaultPassword },
        { store },
      );

      const approveRes = await handleApiRequest(
        new Request(
          `http://localhost/api/v1/tenants/${tenantAlphaId}/timesheets/ts_alpha_01/approve`,
          {
            method: "POST",
            headers: {
              cookie: `aurelia_session=${empLogin.sessionToken}`,
            },
          },
        ),
        { store },
      );

      expect(approveRes?.status).toBe(403);
      const data = (await approveRes?.json()) as { error: string; message: string };
      expect(data.error).toBe("INSUFFICIENT_PERMISSIONS");
      expect(data.message).toContain("timesheet:approve:team");
    });

    it("allows Manager to approve timesheets", async () => {
      const mgrLogin = await authService.login(
        { email: managerUser.email, password: defaultPassword },
        { store },
      );

      const approveRes = await handleApiRequest(
        new Request(
          `http://localhost/api/v1/tenants/${tenantAlphaId}/timesheets/ts_alpha_01/approve`,
          {
            method: "POST",
            headers: {
              cookie: `aurelia_session=${mgrLogin.sessionToken}`,
            },
            body: JSON.stringify({ comment: "Looks great, approved!" }),
          },
        ),
        { store },
      );

      expect(approveRes?.status).toBe(200);
      const data = (await approveRes?.json()) as { timesheet: { status: string } };
      expect(data.timesheet.status).toBe("approved");
    });

    it("blocks Manager from accessing Admin-only user invitation API (unauthorized role escalation)", async () => {
      const mgrLogin = await authService.login(
        { email: managerUser.email, password: defaultPassword },
        { store },
      );

      const inviteRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/invitations/bulk-csv`, {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${mgrLogin.sessionToken}`,
          },
          body: JSON.stringify({
            csvText: "newuser@alpha.example.com,New Dev,Developer,Engineering,business_admin,",
          }),
        }),
        { store },
      );

      expect(inviteRes?.status).toBe(403);
      const data = (await inviteRes?.json()) as { error: string };
      expect(data.error).toBe("INSUFFICIENT_PERMISSIONS");
    });

    it("allows Admin to access Admin-only APIs", async () => {
      const adminLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      const inviteRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/invitations/bulk-csv`, {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${adminLogin.sessionToken}`,
          },
          body: JSON.stringify({
            csvText: "dev1@alpha.example.com,Dev One,Software Engineer,Engineering,employee,",
          }),
        }),
        { store },
      );

      expect(inviteRes?.status).toBe(201);
      const data = (await inviteRes?.json()) as { importedCount: number };
      expect(data.importedCount).toBe(1);
    });
  });

  describe("6. Cross-Tenant Access & Forged Tenant ID Protection", () => {
    it("strictly blocks user in Tenant Alpha from accessing Tenant Beta endpoints", async () => {
      const alphaLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      const crossRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantBetaId}/team`, {
          headers: {
            cookie: `aurelia_session=${alphaLogin.sessionToken}`,
          },
        }),
        { store },
      );

      expect(crossRes?.status).toBe(403);
      const data = (await crossRes?.json()) as { error: string };
      expect(data.error).toBe("TENANT_ISOLATION_VIOLATION");
    });

    it("rejects forged body tenantId that does not match authenticated URL tenantId", async () => {
      const alphaLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      const forgedRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/invitations/bulk-csv`, {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${alphaLogin.sessionToken}`,
          },
          body: JSON.stringify({
            tenantId: tenantBetaId,
            csvText: "attacker@example.com,Attacker,Hacker,Security,employee,",
          }),
        }),
        { store },
      );

      expect(forgedRes?.status).toBe(403);
      const data = (await forgedRes?.json()) as { error: string; message: string };
      expect(data.error).toBe("TENANT_ISOLATION_VIOLATION");
      expect(data.message).toContain("Rejected untrusted frontend tenant_id");
    });
  });

  describe("7. Secure Password Reset (Non-Exposure in HTTP Responses, Out-of-Band Email & Session Revocation)", () => {
    it("never exposes resetToken in HTTP API responses, delivers via EmailDeliveryProvider, enforces single-use, and revokes sessions", async () => {
      // 1. Employee logs in and gets active session
      const initialLogin = await authService.login(
        { email: employeeUser.email, password: defaultPassword },
        { store },
      );
      expect(sessionManager.validateSession(initialLogin.sessionToken)).not.toBeNull();

      // 2. Request password reset via HTTP endpoint
      const httpResetReq = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/password-reset/request", {
          method: "POST",
          body: JSON.stringify({ email: employeeUser.email }),
        }),
        { store },
      );
      expect(httpResetReq?.status).toBe(200);
      const resetBody = (await httpResetReq?.json()) as Record<string, unknown>;
      expect(resetBody["success"]).toBe(true);
      // Security Invariant: resetToken MUST NOT be present in the HTTP response
      expect(resetBody["resetToken"]).toBeUndefined();

      // Non-existent email returns the exact same generic response (no email enumeration)
      const unknownEmailReq = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/password-reset/request", {
          method: "POST",
          body: JSON.stringify({ email: "nobody@unknown.example.com" }),
        }),
        { store },
      );
      expect(unknownEmailReq?.status).toBe(200);
      const unknownBody = (await unknownEmailReq?.json()) as Record<string, unknown>;
      expect(unknownBody).toEqual(resetBody);

      // 3. Retrieve reset token from secure EmailDeliveryProvider outbox
      const emailRecord = defaultEmailDeliveryProvider.getLatestEmailFor(
        employeeUser.email,
        "password_reset",
      );
      expect(emailRecord).toBeDefined();
      expect(emailRecord?.token).toHaveLength(64);

      // 4. Confirm password reset with new password via HTTP endpoint
      const newPassword = "BrandNewPassword2026!@#";
      const confirmHttpRes = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/password-reset/confirm", {
          method: "POST",
          body: JSON.stringify({
            token: emailRecord!.token,
            newPassword,
          }),
        }),
        { store },
      );
      expect(confirmHttpRes?.status).toBe(200);

      // 5. Initial session is now revoked
      expect(sessionManager.validateSession(initialLogin.sessionToken)).toBeNull();

      // 6. Old password no longer works
      await expect(
        authService.login({ email: employeeUser.email, password: defaultPassword }, { store }),
      ).rejects.toThrow("Invalid email or password.");

      // 7. New password works
      const newLogin = await authService.login(
        { email: employeeUser.email, password: newPassword },
        { store },
      );
      expect(newLogin.sessionToken).toBeTruthy();

      // 8. Reset token cannot be reused (single-use enforcement)
      await expect(
        authService.confirmPasswordReset(emailRecord!.token, "AnotherPass123!@#", { store }),
      ).rejects.toThrow(/Invalid or expired password reset token/);
    });
  });

  describe("8. Secure Email Verification (Random Token, SHA-256 Hash in PostgreSQL, Single-Use & Forgery Rejection)", () => {
    it("generates cryptographically random verification tokens in PostgreSQL, stores only SHA-256 hashes, activates tenant only after verification, and blocks replay or forgery", async () => {
      const pg = new PGlite();
      const migration1 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0001_initial_multi_tenant.sql"),
        "utf8",
      );
      await pg.exec(migration1);

      const pgliteClient: QueryableTransactionClient = {
        query: async (text: string, values?: unknown[]) => {
          const res = await pg.query(text, values);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          } as unknown as QueryResult;
        },
        release: () => {},
      };
      const pool: QueryableTransactionPool = {
        connect: async () => pgliteClient,
      };

      const registration = await registerCompanyInDb(
        { pool },
        {
          companyName: "Quantum Secure Systems",
          slug: "quantum-secure",
          adminEmail: "founder@quantum.example.com",
          adminFullName: "Meera Founder",
        },
      );

      // 1. Tenant starts in 'onboarding' status (NOT active before email verification)
      expect(registration.tenant.status).toBe("onboarding");
      // Token is a 64-hex-char (256-bit) cryptographically random string, NOT predictable vtok_...
      expect(registration.verificationToken).toMatch(/^[a-f0-9]{64}$/);
      expect(registration.verificationToken.startsWith("vtok_")).toBe(false);

      // 2. Verify PostgreSQL stores ONLY the SHA-256 hash, never the raw token
      const tokenRows = await pg.query<{ token_hash: string; used_at: string | null }>(
        "SELECT token_hash, used_at FROM email_verification_tokens WHERE tenant_id = $1;",
        [registration.tenant.id],
      );
      expect(tokenRows.rows).toHaveLength(1);
      const expectedHash = crypto
        .createHash("sha256")
        .update(registration.verificationToken)
        .digest("hex");
      expect(tokenRows.rows[0]?.token_hash).toBe(expectedHash);
      expect(tokenRows.rows[0]?.used_at).toBeNull();

      // 3. Forged predictable token is rejected
      await expect(
        verifyCompanyAdminEmailInDb(
          { pool },
          `vtok_${registration.tenant.id}_${registration.adminUser.id}`,
        ),
      ).rejects.toThrow(/Invalid, expired, or already used email verification token/);

      // 4. First verification with genuine token activates the tenant
      const verified = await verifyCompanyAdminEmailInDb({ pool }, registration.verificationToken);
      expect(verified.tenant.status).toBe("active");
      expect(verified.user.emailVerifiedAt).toBeTruthy();

      // 5. Repeated verification attempt with the same token is rejected (single-use)
      await expect(
        verifyCompanyAdminEmailInDb({ pool }, registration.verificationToken),
      ).rejects.toThrow(/Invalid, expired, or already used email verification token/);

      await pg.close();
    });
  });

  describe("9. Account Activation, Suspension & Deactivation", () => {
    it("deactivating account immediately revokes sessions and blocks future logins", async () => {
      const empLogin = await authService.login(
        { email: employeeUser.email, password: defaultPassword },
        { store },
      );
      expect(sessionManager.validateSession(empLogin.sessionToken)).not.toBeNull();

      const adminLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      const statusRes = await handleApiRequest(
        new Request(
          `http://localhost/api/v1/tenants/${tenantAlphaId}/users/${employeeUser.id}/status`,
          {
            method: "POST",
            headers: {
              cookie: `aurelia_session=${adminLogin.sessionToken}`,
            },
            body: JSON.stringify({ status: "deactivated" }),
          },
        ),
        { store },
      );

      expect(statusRes?.status).toBe(200);
      expect(sessionManager.validateSession(empLogin.sessionToken)).toBeNull();

      await expect(
        authService.login({ email: employeeUser.email, password: defaultPassword }, { store }),
      ).rejects.toThrow(/account has been deactivated/);
    });
  });

  describe("10. SSO Architecture Preparation (OIDC, RS256 ID Token Signature Verification & SAML 2.0)", () => {
    it("generates OIDC authorization URL with cryptographic HMAC state, nonce, and PKCE", () => {
      const oidcReq = ssoService.prepareGoogleOidcRequest({
        provider: "google_oidc",
        clientId: "google-client-id",
        issuerUrl: "https://accounts.google.com",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        redirectUri: "https://timeflow.aurelia.com/api/v1/auth/oidc/google/callback",
        tenantId: tenantAlphaId,
      });

      expect(oidcReq.authorizationUrl).toContain("response_type=code");
      expect(oidcReq.authorizationUrl).toContain("code_challenge=");
      expect(oidcReq.authorizationUrl).toContain("code_challenge_method=S256");
      expect(oidcReq.state).toBeTruthy();
      expect(oidcReq.nonce).toBeTruthy();
    });

    it("verifies RS256 OIDC ID token cryptographic signature, issuer, audience, expiry, and nonce", () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          iss: "https://accounts.google.com",
          sub: "google_user_123",
          aud: "google-client-id",
          exp: nowSec + 3600,
          iat: nowSec,
          nonce: "nonce_xyz",
          email: "admin@alpha.example.com",
          email_verified: true,
        }),
      ).toString("base64url");

      const signer = crypto.createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      signer.end();
      const signature = signer.sign(privateKey).toString("base64url");
      const jwt = `${header}.${payload}.${signature}`;

      const claims = ssoService.verifyOidcIdTokenSignature(jwt, publicKey, {
        issuer: "https://accounts.google.com",
        audience: "google-client-id",
        nonce: "nonce_xyz",
        nowSeconds: nowSec,
      });
      expect(claims.email).toBe("admin@alpha.example.com");

      // Tampered payload fails cryptographic signature verification
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          iss: "https://accounts.google.com",
          sub: "attacker",
          aud: "google-client-id",
          exp: nowSec + 3600,
          iat: nowSec,
          nonce: "nonce_xyz",
        }),
      ).toString("base64url");
      expect(() =>
        ssoService.verifyOidcIdTokenSignature(
          `${header}.${tamperedPayload}.${signature}`,
          publicKey,
          {
            issuer: "https://accounts.google.com",
            audience: "google-client-id",
            nonce: "nonce_xyz",
          },
        ),
      ).toThrow(/Invalid OIDC ID token cryptographic signature/);

      // Loads OIDC credentials from AWS Secrets Manager JSON
      const loadedCfg = loadOidcConfigFromAwsSecrets(
        JSON.stringify({
          clientId: "secret-client-id",
          clientSecret: "secret-client-secret",
          issuerUrl: "https://accounts.google.com",
          redirectUri: "https://timeflow.aurelia.com/api/v1/auth/oidc/google/callback",
          tenantId: tenantAlphaId,
        }),
        "google_oidc",
      );
      expect(loadedCfg.clientId).toBe("secret-client-id");
    });

    it("rejects forged or tampered state in OIDC callback", () => {
      const result = ssoService.validateOidcCallback({
        code: "auth_code_123",
        state: "tampered_forged_state",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid.*state/i);
    });

    it("validates SAML 2.0 AuthnRequest and rejects tampered RelayState", () => {
      const samlReq = ssoService.prepareSamlAuthnRequest({
        connectionId: "conn_saml_01",
        tenantId: tenantAlphaId,
        idpSsoUrl: "https://idp.example.com/saml/sso",
        spEntityId: "https://timeflow.aurelia.com/saml/sp",
        acsUrl: "https://timeflow.aurelia.com/api/v1/auth/saml/conn_saml_01/acs",
      });

      expect(samlReq.authnRequestXml).toContain("samlp:AuthnRequest");
      expect(samlReq.relayState).toBeTruthy();

      const validation = ssoService.validateSamlResponse({
        samlResponse: "PHNhbWxwOlJlc3BvbnNlPjwvc2FtbHA6UmVzcG9uc2U+",
        relayState: "tampered_relay_state",
      });
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Invalid SAML RelayState");
    });
  });

  describe("11. Phase 2.1: Production Email Delivery via AWS SES (Success, Failure & Token Redaction)", () => {
    it("loads AWS SES configuration from environment variables and AWS_SES_SECRET_JSON and signs SES v2 requests", async () => {
      const sesEnv = {
        AWS_SES_REGION: "ap-south-1",
        AWS_SES_FROM_EMAIL: "no-reply@timeflow.aurelia.com",
        AWS_SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        APP_PUBLIC_URL: "https://timeflow.aurelia.com",
      };
      const cfg = loadAwsSesConfig(sesEnv);
      expect(cfg.region).toBe("ap-south-1");
      expect(cfg.fromEmail).toBe("no-reply@timeflow.aurelia.com");
      expect(cfg.credentialSource).toBe("environment");

      const secretJsonCfg = loadAwsSesConfig({
        AWS_SES_SECRET_JSON: JSON.stringify({
          region: "ap-south-1",
          fromEmail: "security@timeflow.aurelia.com",
          accessKeyId: "AKIASECRETEXAMPLE",
          secretAccessKey: "SecretManagerSesKey!2026",
          appPublicUrl: "https://timeflow.aurelia.com",
        }),
      });
      expect(secretJsonCfg.fromEmail).toBe("security@timeflow.aurelia.com");
      expect(secretJsonCfg.credentialSource).toBe("aws_secrets_manager_json");

      // Mock AWS SES v2 HTTP endpoint confirming delivery acceptance with MessageId
      let capturedAuthHeader = "";
      let capturedUrl = "";
      const sesProvider = new AwsSesEmailProvider({
        config: cfg,
        fetchFn: async (input, init) => {
          capturedUrl = String(input);
          const headers = init?.headers as Record<string, string>;
          capturedAuthHeader = headers["authorization"] ?? "";
          return new Response(JSON.stringify({ MessageId: "ses_msg_mumbai_001" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const resetToken = crypto.randomBytes(32).toString("hex");
      const res = await sesProvider.sendPasswordResetEmail({
        to: "admin@alpha.example.com",
        resetToken,
        expiresAt: Date.now() + 3600_000,
      });

      expect(res.accepted).toBe(true);
      expect(res.messageId).toBe("ses_msg_mumbai_001");
      expect(res.provider).toBe("aws_ses");
      expect(capturedUrl).toBe("https://email.ap-south-1.amazonaws.com/v2/outbound-emails");
      expect(capturedAuthHeader).toContain("AWS4-HMAC-SHA256");
      expect(capturedAuthHeader).toContain("ap-south-1/ses/aws4_request");
    });

    it("fails safely when AWS SES rejects delivery or omits MessageId, never logs or leaks raw tokens, and blocks in-memory fallback in production", async () => {
      const cfg = loadAwsSesConfig({
        AWS_SES_REGION: "ap-south-1",
        AWS_SES_FROM_EMAIL: "no-reply@timeflow.aurelia.com",
        AWS_SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      });

      const secretVerifyToken = crypto.randomBytes(32).toString("hex");

      // Case 1: AWS SES returns HTTP 500 and echoes back part of the request containing the token
      const failingProvider = new AwsSesEmailProvider({
        config: cfg,
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              message: `SES upstream throttling for token=${secretVerifyToken}`,
            }),
            { status: 500 },
          ),
      });

      let caughtError: Error | null = null;
      try {
        await failingProvider.sendEmailVerificationEmail({
          to: "founder@alpha.example.com",
          companyName: "Alpha Corp",
          tenantId: tenantAlphaId,
          verificationToken: secretVerifyToken,
          expiresAt: Date.now() + 3600_000,
        });
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).not.toBeNull();
      // Raw verification token MUST be redacted from any error message
      expect(caughtError?.message).not.toContain(secretVerifyToken);
      expect(caughtError?.message).toContain("[REDACTED_TOKEN]");

      // Case 2: Self-service registration via HTTP API fails safely and does NOT report verificationEmailDispatched: true when SES fails
      const failedRegRes = await handleApiRequest(
        new Request("http://localhost/api/v1/onboarding/self-service/register-company", {
          method: "POST",
          body: JSON.stringify({
            companyName: "FailSafe Corp",
            slug: "failsafe-corp",
            adminEmail: "admin@failsafe.example.com",
            adminFullName: "Fail Safe Admin",
          }),
        }),
        { store, emailProvider: failingProvider },
      );
      expect(failedRegRes?.status).toBe(502);
      const failedRegBody = (await failedRegRes?.json()) as Record<string, unknown>;
      expect(failedRegBody["error"]).toBe("EMAIL_DELIVERY_FAILED");
      expect(failedRegBody["verificationEmailDispatched"]).toBeUndefined();

      // Case 3: Production mode without AWS SES configured refuses to fall back to in-memory email provider
      expect(() => resolveEmailDeliveryProvider({ APP_ENV: "production" })).toThrow(
        /Missing or invalid AWS_SES_FROM_EMAIL/,
      );
    });
  });

  describe("12. Phase 2.1: Atomic PostgreSQL Session Rotation Under Concurrency", () => {
    it("executes session rotation in a single PostgreSQL transaction so concurrent rotation requests cannot rotate the same old token twice", async () => {
      const pg = new PGlite();
      const migration1 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0001_initial_multi_tenant.sql"),
        "utf8",
      );
      const migration2 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0002_auth_persistence.sql"),
        "utf8",
      );
      await pg.exec(migration1);
      await pg.exec(migration2);

      const pgliteClient: QueryableTransactionClient = {
        query: async (
          textOrConfig: string | { text: string; values?: unknown[] },
          values?: unknown[],
        ) => {
          const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
          const params =
            Array.isArray(values) && values.length > 0
              ? values
              : typeof textOrConfig === "object" && Array.isArray(textOrConfig.values)
                ? textOrConfig.values
                : [];
          const res = await pg.query(text, params);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          } as unknown as QueryResult;
        },
        release: () => {},
      };
      const db = drizzle(pgliteClient as unknown as NodePgClient, {
        schema,
      }) as unknown as AureliaAwsDb;

      const userUuid = "aaaaaaaa-1111-4111-8111-111111111111";
      await pg.query(
        `INSERT INTO users (id, email, full_name, status, is_platform_admin)
         VALUES ($1, 'admin@alpha.example.com', 'Aarav Admin', 'active', false);`,
        [userUuid],
      );

      const manager = new SessionManager({ db });
      const { rawToken, session: originalSession } = await manager.createSessionInDb(
        userUuid,
        "admin@alpha.example.com",
        { ipAddress: "10.20.30.40", userAgent: "AureliaClient/2.1" },
      );

      // Fire 5 concurrent rotation requests with the exact same old token
      const rotationResults = await Promise.all([
        manager.rotateSessionInDb(rawToken),
        manager.rotateSessionInDb(rawToken),
        manager.rotateSessionInDb(rawToken),
        manager.rotateSessionInDb(rawToken),
        manager.rotateSessionInDb(rawToken),
      ]);

      const successfulRotations = rotationResults.filter(
        (r): r is NonNullable<typeof r> => r !== null,
      );
      const rejectedRotations = rotationResults.filter((r) => r === null);

      // Strictly 1 rotation succeeds; all 4 concurrent duplicates fail with null
      expect(successfulRotations).toHaveLength(1);
      expect(rejectedRotations).toHaveLength(4);

      const winner = successfulRotations[0]!;
      expect(winner.newRawToken).not.toBe(rawToken);
      expect(winner.session.userId).toBe(userUuid);
      expect(winner.session.email).toBe("admin@alpha.example.com");
      expect(winner.session.ipAddress).toBe("10.20.30.40");
      expect(winner.session.userAgent).toBe("AureliaClient/2.1");
      expect(winner.session.createdAt).toBe(originalSession.createdAt);

      // Old token is revoked in PostgreSQL; new token is active
      expect(await manager.validateSessionInDb(rawToken)).toBeNull();
      const validatedWinner = await manager.validateSessionInDb(winner.newRawToken);
      expect(validatedWinner?.sessionId).toBe(winner.session.sessionId);

      // Verify exactly 1 active session row exists in PostgreSQL for the user
      const activeDbRows = await pg.query(
        "SELECT session_id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL;",
        [userUuid],
      );
      expect(activeDbRows.rows).toHaveLength(1);

      await pg.close();
    });
  });

  describe("13. Phase 2.1: Fail-Closed Production Authentication & Database Outage Handling", () => {
    it("never falls back to in-memory sessions, user records, or tenant memberships in production when PostgreSQL is unavailable", async () => {
      // Seed an active in-memory session and user in `store`
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);
      expect(sessionManager.validateSession(rawToken)).not.toBeNull();

      const prodEnv = {
        APP_ENV: "production",
        NODE_ENV: "production",
      };

      // 1. Login in production without PostgreSQL fails closed with 503 DATABASE_UNAVAILABLE
      //    even though `store` has the user and valid password hash
      const prodLoginRes = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: adminUser.email,
            password: defaultPassword,
          }),
        }),
        { store, env: prodEnv },
      );
      expect(prodLoginRes?.status).toBe(503);
      const prodLoginBody = (await prodLoginRes?.json()) as { error: string; message: string };
      expect(prodLoginBody.error).toBe("DATABASE_UNAVAILABLE");
      expect(prodLoginBody.message).toContain("In-memory fallback is disabled");

      // 2. Protected session endpoint in production rejects valid in-memory session token with 503
      const prodSessionRes = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/session", {
          headers: { cookie: `aurelia_session=${rawToken}` },
        }),
        { store, env: prodEnv },
      );
      expect(prodSessionRes?.status).toBe(503);
      const prodSessionBody = (await prodSessionRes?.json()) as { error: string };
      expect(prodSessionBody.error).toBe("DATABASE_UNAVAILABLE");

      // 3. Tenant-scoped endpoint in production rejects valid in-memory session and store membership with 503
      const prodTeamRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/team`, {
          headers: { cookie: `aurelia_session=${rawToken}` },
        }),
        { store, env: prodEnv },
      );
      expect(prodTeamRes?.status).toBe(503);
      const prodTeamBody = (await prodTeamRes?.json()) as { error: string };
      expect(prodTeamBody.error).toBe("DATABASE_UNAVAILABLE");
    });

    it("returns a safe, credential-redacted 503 DATABASE_UNAVAILABLE error during a PostgreSQL connection outage in production", async () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      const brokenClient: QueryableTransactionClient = {
        query: async () => {
          throw new Error(
            "connect ECONNREFUSED 10.0.1.50:5432 for user=aurelia_app password=SuperSecretDbPass!99",
          );
        },
        release: () => {},
      };
      const brokenPool: QueryableTransactionPool = {
        connect: async () => brokenClient,
      };
      const brokenDb = drizzle(brokenClient as unknown as NodePgClient, {
        schema,
      }) as unknown as AureliaAwsDb;

      const outageRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/projects`, {
          headers: { cookie: `aurelia_session=${rawToken}` },
        }),
        {
          pool: brokenPool,
          db: brokenDb,
          store,
          env: { APP_ENV: "production", NODE_ENV: "production" },
        },
      );

      expect(outageRes?.status).toBe(503);
      const outageBody = (await outageRes?.json()) as { error: string; message: string };
      expect(outageBody.error).toBe("DATABASE_UNAVAILABLE");
      expect(outageBody.message).not.toContain("SuperSecretDbPass!99");
      expect(outageBody.message).toContain("********");
    });
  });

  describe("14. Phase 2.1: Concurrent Password Reset & Concurrent Email Verification Token Consumption", () => {
    it("enforces atomic single-use password reset token consumption, transactional password update, and session revocation under concurrent requests", async () => {
      const pg = new PGlite();
      const migration1 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0001_initial_multi_tenant.sql"),
        "utf8",
      );
      const migration2 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0002_auth_persistence.sql"),
        "utf8",
      );
      await pg.exec(migration1);
      await pg.exec(migration2);

      const pgliteClient: QueryableTransactionClient = {
        query: async (
          textOrConfig: string | { text: string; values?: unknown[]; rowMode?: string },
          values?: unknown[],
        ) => {
          const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
          const params =
            Array.isArray(values) && values.length > 0
              ? values
              : typeof textOrConfig === "object" && Array.isArray(textOrConfig.values)
                ? textOrConfig.values
                : [];
          const rowMode =
            typeof textOrConfig === "object" && textOrConfig.rowMode === "array"
              ? ("array" as const)
              : undefined;
          const res = await pg.query(text, params, rowMode ? { rowMode } : undefined);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          } as unknown as QueryResult;
        },
        release: () => {},
      };
      const db = drizzle(pgliteClient as unknown as NodePgClient, {
        schema,
      }) as unknown as AureliaAwsDb;

      const userUuid = "aaaaaaaa-2222-4222-8222-222222222222";
      const initialHash = await hashPassword("InitialPass123!@#");
      await pg.query(
        `INSERT INTO users (id, email, full_name, password_hash, status, is_platform_admin)
         VALUES ($1, 'reset-target@alpha.example.com', 'Reset User', $2, 'active', false);`,
        [userUuid, initialHash],
      );

      // Create an active session in PostgreSQL that must be revoked on password reset
      const activeSession = await sessionManager.createSessionInDb(
        userUuid,
        "reset-target@alpha.example.com",
        { db },
      );
      expect(
        await sessionManager.validateSessionInDb(activeSession.rawToken, { db }),
      ).not.toBeNull();

      // Request password reset
      await authService.requestPasswordReset("reset-target@alpha.example.com", { db });
      const emailRecord = defaultEmailDeliveryProvider.getLatestEmailFor(
        "reset-target@alpha.example.com",
        "password_reset",
      );
      expect(emailRecord?.token).toBeTruthy();

      // Fire 4 concurrent confirmPasswordReset requests using the same single-use token
      const concurrentOutcomes = await Promise.allSettled([
        authService.confirmPasswordReset(emailRecord!.token, "ConcurrentPassA1!@#", { db }),
        authService.confirmPasswordReset(emailRecord!.token, "ConcurrentPassB2!@#", { db }),
        authService.confirmPasswordReset(emailRecord!.token, "ConcurrentPassC3!@#", { db }),
        authService.confirmPasswordReset(emailRecord!.token, "ConcurrentPassD4!@#", { db }),
      ]);

      const fulfilled = concurrentOutcomes.filter((o) => o.status === "fulfilled");
      const rejected = concurrentOutcomes.filter((o) => o.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(3);

      // Existing session was atomically revoked in PostgreSQL
      expect(await sessionManager.validateSessionInDb(activeSession.rawToken, { db })).toBeNull();

      await pg.close();
    });

    it("enforces atomic single-use email verification under concurrent requests and prevents activating the wrong tenant or user", async () => {
      const pg = new PGlite();
      const migration1 = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0001_initial_multi_tenant.sql"),
        "utf8",
      );
      await pg.exec(migration1);

      const pgliteClient: QueryableTransactionClient = {
        query: async (text: string, values?: unknown[]) => {
          const res = await pg.query(text, values);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          } as unknown as QueryResult;
        },
        release: () => {},
      };
      const pool: QueryableTransactionPool = {
        connect: async () => pgliteClient,
      };

      const regA = await registerCompanyInDb(
        { pool },
        {
          companyName: "Tenant One Pvt Ltd",
          slug: "tenant-one",
          adminEmail: "admin@tenant-one.example.com",
          adminFullName: "Admin One",
        },
      );
      const regB = await registerCompanyInDb(
        { pool },
        {
          companyName: "Tenant Two Pvt Ltd",
          slug: "tenant-two",
          adminEmail: "admin@tenant-two.example.com",
          adminFullName: "Admin Two",
        },
      );

      // 1. Attempting to use Tenant One's verification token to activate Tenant Two is rejected
      //    and rolls back so neither Tenant Two nor Tenant One is wrongly activated!
      await expect(
        verifyCompanyAdminEmailInDb({ pool }, regA.verificationToken, {
          expectedTenantId: regB.tenant.id,
        }),
      ).rejects.toThrow(/does not belong to requested tenant/);

      const statusCheckB = await pg.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1;",
        [regB.tenant.id],
      );
      expect(statusCheckB.rows[0]?.status).toBe("onboarding");

      // 2. Attempting to verify with a mismatched email is rejected and rolled back
      await expect(
        verifyCompanyAdminEmailInDb({ pool }, regA.verificationToken, {
          expectedEmail: "wrong-user@tenant-two.example.com",
        }),
      ).rejects.toThrow(/does not belong to the specified email address/);

      // 3. Fire 4 concurrent verification requests with Tenant One's genuine token:
      //    strictly 1 succeeds, 3 fail!
      const verifyOutcomes = await Promise.allSettled([
        verifyCompanyAdminEmailInDb({ pool }, regA.verificationToken),
        verifyCompanyAdminEmailInDb({ pool }, regA.verificationToken),
        verifyCompanyAdminEmailInDb({ pool }, regA.verificationToken),
        verifyCompanyAdminEmailInDb({ pool }, regA.verificationToken),
      ]);

      const verifyFulfilled = verifyOutcomes.filter((o) => o.status === "fulfilled");
      const verifyRejected = verifyOutcomes.filter((o) => o.status === "rejected");

      expect(verifyFulfilled).toHaveLength(1);
      expect(verifyRejected).toHaveLength(3);

      // Tenant One is now active; Tenant Two remains in onboarding
      const finalStatusA = await pg.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1;",
        [regA.tenant.id],
      );
      const finalStatusB = await pg.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1;",
        [regB.tenant.id],
      );
      expect(finalStatusA.rows[0]?.status).toBe("active");
      expect(finalStatusB.rows[0]?.status).toBe("onboarding");

      await pg.close();
    });
  });

  describe("15. Phase 2.1: Complete End-to-End OIDC Authentication & Security Validation", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = {
      ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: "google_key_2026_01",
      alg: "RS256",
      use: "sig",
      kty: "RSA",
    };

    function signTestIdToken(
      claims: Record<string, unknown>,
      options?: { kid?: string; alg?: string; signingKey?: crypto.KeyObject },
    ): string {
      const header = Buffer.from(
        JSON.stringify({
          alg: options?.alg ?? "RS256",
          typ: "JWT",
          kid: options?.kid ?? "google_key_2026_01",
        }),
      ).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      signer.end();
      const sig = signer.sign(options?.signingKey ?? privateKey).toString("base64url");
      return `${header}.${payload}.${sig}`;
    }

    const oidcConfig: OidcProviderConfig = {
      connectionId: "google",
      provider: "google_oidc",
      clientId: "aurelia-google-prod-client",
      clientSecret: "aurelia-google-prod-secret",
      issuerUrl: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      redirectUri: "http://localhost/api/v1/auth/oidc/google/callback",
      tenantId: tenantAlphaId,
    };

    it("completes end-to-end OIDC code exchange, JWKS key lookup, RS256 verification, and issues an authenticated Aurelia session", async () => {
      ssoService.registerOidcConnection("google", oidcConfig);
      const authReq = ssoService.prepareGoogleOidcRequest(oidcConfig);
      const nowSec = Math.floor(Date.now() / 1000);

      let tokenEndpointCalled = false;
      let jwksEndpointCalled = false;
      let receivedCodeVerifier = "";

      const mockOidcFetch: typeof fetch = async (input, init) => {
        const urlStr = String(input);
        if (urlStr === oidcConfig.tokenEndpoint) {
          tokenEndpointCalled = true;
          const form = new URLSearchParams(String(init?.body ?? ""));
          receivedCodeVerifier = form.get("code_verifier") ?? "";
          const idToken = signTestIdToken({
            iss: oidcConfig.issuerUrl,
            sub: "google_sub_admin_01",
            aud: oidcConfig.clientId,
            exp: nowSec + 3600,
            iat: nowSec,
            nonce: authReq.nonce,
            email: adminUser.email,
            email_verified: true,
            name: adminUser.fullName,
          });
          return new Response(
            JSON.stringify({
              id_token: idToken,
              access_token: "ya29.mock_access_token",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (urlStr === oidcConfig.jwksUri) {
          jwksEndpointCalled = true;
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const callbackRes = await handleApiRequest(
        new Request(
          `http://localhost/api/v1/auth/oidc/google/callback?code=valid_auth_code_999&state=${encodeURIComponent(authReq.state)}`,
        ),
        {
          store,
          oidcConfig,
          oidcFetchFn: mockOidcFetch,
        },
      );

      expect(callbackRes?.status).toBe(200);
      expect(tokenEndpointCalled).toBe(true);
      expect(jwksEndpointCalled).toBe(true);
      expect(receivedCodeVerifier).toBe(authReq.codeVerifier);

      const setCookie = callbackRes?.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("aurelia_session=");
      expect(setCookie).toContain("HttpOnly");

      const callbackBody = (await callbackRes?.json()) as {
        authenticated: boolean;
        tenantId: string;
        sessionToken: string;
        user: { id: string; email: string };
      };
      expect(callbackBody.authenticated).toBe(true);
      expect(callbackBody.tenantId).toBe(tenantAlphaId);
      expect(callbackBody.user.id).toBe(adminUser.id);

      // Verify the issued OIDC session works on protected tenant API endpoints
      const projectsRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/projects`, {
          headers: { cookie: `aurelia_session=${callbackBody.sessionToken}` },
        }),
        { store },
      );
      expect(projectsRes?.status).toBe(200);
    });

    it("rejects OIDC callbacks with invalid signature, wrong issuer, wrong audience, wrong/missing nonce, expired token, replayed state, wrong redirect_uri, or invalid PKCE", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });

      function buildMockFetchWithToken(idTokenFactory: (nonce: string) => string): typeof fetch {
        const currentNonce = "";
        return async (input) => {
          const urlStr = String(input);
          if (urlStr === oidcConfig.tokenEndpoint) {
            return new Response(
              JSON.stringify({
                id_token: idTokenFactory(currentNonce),
                token_type: "Bearer",
              }),
              { status: 200 },
            );
          }
          if (urlStr === oidcConfig.jwksUri) {
            return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
          }
          return new Response("Not Found", { status: 404 });
        };
      }

      // 1. Invalid cryptographic signature (signed with wrong RSA private key)
      const req1 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_1",
          state: req1.state,
          config: oidcConfig,
          fetchFn: buildMockFetchWithToken(() =>
            signTestIdToken(
              {
                iss: oidcConfig.issuerUrl,
                sub: "sub_1",
                aud: oidcConfig.clientId,
                exp: nowSec + 3600,
                iat: nowSec,
                nonce: req1.nonce,
                email: adminUser.email,
              },
              { signingKey: wrongPrivateKey },
            ),
          ),
        }),
      ).rejects.toThrow(/Invalid OIDC ID token cryptographic signature/);

      // 2. State replay (reusing req1.state after it was already consumed)
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_1_replay",
          state: req1.state,
          config: oidcConfig,
        }),
      ).rejects.toThrow(/already been consumed/);

      // 3. Wrong issuer
      const req2 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_2",
          state: req2.state,
          config: oidcConfig,
          fetchFn: buildMockFetchWithToken(() =>
            signTestIdToken({
              iss: "https://evil-issuer.example.com",
              sub: "sub_2",
              aud: oidcConfig.clientId,
              exp: nowSec + 3600,
              iat: nowSec,
              nonce: req2.nonce,
              email: adminUser.email,
            }),
          ),
        }),
      ).rejects.toThrow(/OIDC issuer mismatch/);

      // 4. Wrong audience
      const req3 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_3",
          state: req3.state,
          config: oidcConfig,
          fetchFn: buildMockFetchWithToken(() =>
            signTestIdToken({
              iss: oidcConfig.issuerUrl,
              sub: "sub_3",
              aud: "other-unrelated-client-id",
              exp: nowSec + 3600,
              iat: nowSec,
              nonce: req3.nonce,
              email: adminUser.email,
            }),
          ),
        }),
      ).rejects.toThrow(/OIDC audience mismatch/);

      // 5. Wrong or missing nonce
      const req4 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_4",
          state: req4.state,
          config: oidcConfig,
          fetchFn: buildMockFetchWithToken(() =>
            signTestIdToken({
              iss: oidcConfig.issuerUrl,
              sub: "sub_4",
              aud: oidcConfig.clientId,
              exp: nowSec + 3600,
              iat: nowSec,
              nonce: "forged_wrong_nonce",
              email: adminUser.email,
            }),
          ),
        }),
      ).rejects.toThrow(/OIDC ID token nonce mismatch/);

      // 6. Expired ID token
      const req5 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_5",
          state: req5.state,
          config: oidcConfig,
          fetchFn: buildMockFetchWithToken(() =>
            signTestIdToken({
              iss: oidcConfig.issuerUrl,
              sub: "sub_5",
              aud: oidcConfig.clientId,
              exp: nowSec - 60,
              iat: nowSec - 3600,
              nonce: req5.nonce,
              email: adminUser.email,
            }),
          ),
        }),
      ).rejects.toThrow(/OIDC ID token has expired/);

      // 7. Unauthorized redirect_uri mismatch
      const req6 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_6",
          state: req6.state,
          redirectUri: "https://attacker.example.com/callback",
          config: oidcConfig,
        }),
      ).rejects.toThrow(/OIDC redirect_uri mismatch/);

      // 8. Invalid PKCE code_verifier
      const req7 = ssoService.prepareGoogleOidcRequest(oidcConfig);
      await expect(
        ssoService.completeOidcCallbackExchange({
          code: "code_7",
          state: req7.state,
          codeVerifierOverride: "wrong_pkce_code_verifier_that_does_not_match_s256_challenge_0000",
          config: oidcConfig,
        }),
      ).rejects.toThrow(/PKCE verification failed/);
    });
  });

  describe("18. Development Mode Email Outbox, Optional AWS SES & Production Fail-Closed Validation", () => {
    it("allows AWS_SES_FROM_EMAIL and SES credentials to remain unset in development and routes password-reset and email-verification to the development outbox", async () => {
      defaultEmailDeliveryProvider.clearOutbox();

      const previewUrl =
        "https://ais-dev-bsok7auxatxjzbrbx5nsra-808876545987.asia-northeast1.run.app";
      const devEnv: Record<string, string | undefined> = {
        APP_ENV: "development",
        NODE_ENV: "development",
        APP_PUBLIC_URL: previewUrl,
        EMAIL_DELIVERY_MODE: "development_outbox",
        AWS_SES_ENABLED: "false",
        AWS_SES_FROM_EMAIL: "",
      };

      const validation = validateEmailDeliveryEnvironment(devEnv);
      expect(validation.valid).toBe(true);
      expect(validation.mode).toBe("development_outbox");
      expect(validation.isProduction).toBe(false);
      expect(validation.appPublicUrl).toBe(previewUrl);
      expect(validation.fromEmail).toBeNull();

      // 1. Self-service company registration succeeds without AWS SES or a purchased domain
      const regRes = await handleApiRequest(
        new Request(`${previewUrl}/api/v1/onboarding/self-service/register-company`, {
          method: "POST",
          body: JSON.stringify({
            companyName: "Stealth Dev Labs",
            slug: "stealth-dev-labs",
            adminEmail: "founder@stealth-dev.test",
            adminFullName: "Dev Founder",
          }),
        }),
        { store, env: devEnv },
      );

      expect(regRes?.status).toBe(201);
      const regBody = (await regRes?.json()) as Record<string, unknown>;
      expect(regBody["verificationEmailDispatched"]).toBe(true);
      // Production/API response invariant: verificationToken is NEVER returned in the API response
      expect(regBody["verificationToken"]).toBeUndefined();

      // 2. Password reset request succeeds without AWS SES and NEVER returns resetToken in the API response
      const resetRes = await handleApiRequest(
        new Request(`${previewUrl}/api/v1/auth/password-reset/request`, {
          method: "POST",
          body: JSON.stringify({ email: adminUser.email }),
        }),
        { store, env: devEnv },
      );

      expect(resetRes?.status).toBe(200);
      const resetBody = (await resetRes?.json()) as Record<string, unknown>;
      expect(resetBody["success"]).toBe(true);
      expect(resetBody["resetToken"]).toBeUndefined();
      expect(resetBody["token"]).toBeUndefined();

      // 3. Development tokens and preview actionUrls are accessible ONLY through the isolated development mechanism
      const outboxAccessor = getDevelopmentEmailOutbox(devEnv);
      expect(outboxAccessor.mode).toBe("development_outbox");

      const verifyRecord = outboxAccessor.getLatestEmailFor(
        "founder@stealth-dev.test",
        "email_verification",
      );
      expect(verifyRecord).toBeDefined();
      expect(verifyRecord?.token).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyRecord?.actionUrl).toContain(`${previewUrl}/verify-email?token=`);

      const resetRecord = outboxAccessor.getLatestEmailFor(adminUser.email, "password_reset");
      expect(resetRecord).toBeDefined();
      expect(resetRecord?.token).toMatch(/^[a-f0-9]{64}$/);
      expect(resetRecord?.actionUrl).toContain(`${previewUrl}/reset-password?token=`);

      // 4. Isolated development HTTP endpoint (/api/v1/dev/email-outbox) returns outbox items in development
      const devOutboxHttpRes = await handleApiRequest(
        new Request(
          `${previewUrl}/api/v1/dev/email-outbox?recipient=${encodeURIComponent(adminUser.email)}&type=password_reset`,
          { method: "GET" },
        ),
        { store, env: devEnv },
      );
      expect(devOutboxHttpRes?.status).toBe(200);
      const devOutboxHttpBody = (await devOutboxHttpRes?.json()) as {
        mode: string;
        count: number;
        emails: Array<{ to: string; token: string; actionUrl: string; type: string }>;
      };
      expect(devOutboxHttpBody.mode).toBe("development_outbox");
      expect(devOutboxHttpBody.count).toBe(1);
      expect(devOutboxHttpBody.emails[0]?.token).toBe(resetRecord?.token);
      expect(devOutboxHttpBody.emails[0]?.actionUrl).toContain(previewUrl);
    });

    it("enforces fail-closed validation in production when AWS SES, verified sender, or APP_PUBLIC_URL is missing, and blocks development outbox access in production", async () => {
      const prodEnvMissingSes: Record<string, string | undefined> = {
        APP_ENV: "production",
        NODE_ENV: "production",
      };

      // 1. Production environment validation fails closed when SES and APP_PUBLIC_URL are unset
      const prodValidation = validateEmailDeliveryEnvironment(prodEnvMissingSes);
      expect(prodValidation.valid).toBe(false);
      expect(prodValidation.isProduction).toBe(true);
      expect(prodValidation.errors.length).toBeGreaterThan(0);

      // 2. Production rejects EMAIL_DELIVERY_MODE=development_outbox or AWS_SES_ENABLED=false
      expect(() =>
        resolveEmailDeliveryProvider({
          APP_ENV: "production",
          EMAIL_DELIVERY_MODE: "development_outbox",
          AWS_SES_ENABLED: "false",
        }),
      ).toThrow(/Email delivery cannot be disabled/);

      // 3. Production requires an explicit https:// APP_PUBLIC_URL (no hardcoded domain fallback)
      expect(() =>
        loadAwsSesConfig({
          APP_ENV: "production",
          AWS_SES_REGION: "ap-south-1",
          AWS_SES_FROM_EMAIL: "verified@company.example.com",
          AWS_SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          // APP_PUBLIC_URL intentionally omitted
        }),
      ).toThrow(/Missing required APP_PUBLIC_URL/);

      expect(() =>
        resolveAppPublicUrl({
          APP_ENV: "production",
          APP_PUBLIC_URL: "http://localhost:3000",
        }),
      ).toThrow(/Production APP_PUBLIC_URL must use https:\/\//);

      // 4. Rejects placeholder sender email addresses containing angle brackets
      expect(() =>
        loadAwsSesConfig({
          APP_ENV: "production",
          APP_PUBLIC_URL: "https://app.company.example.com",
          AWS_SES_FROM_EMAIL: "<replace-with-verified-ses-sender@your-domain.com>",
          AWS_SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        }),
      ).toThrow(/Missing or invalid AWS_SES_FROM_EMAIL/);

      // 5. Development email outbox helper and HTTP endpoint fail closed (403) in production
      expect(() => getDevelopmentEmailOutbox({ APP_ENV: "production" })).toThrow(
        /Development email outbox is strictly disabled in production/,
      );

      const prodOutboxHttpRes = await handleApiRequest(
        new Request("https://app.company.example.com/api/v1/dev/email-outbox", {
          method: "GET",
        }),
        { store, env: { APP_ENV: "production", NODE_ENV: "production" } },
      );
      expect(prodOutboxHttpRes?.status).toBe(403);
      const prodOutboxBody = (await prodOutboxHttpRes?.json()) as Record<string, unknown>;
      expect(prodOutboxBody["error"]).toBe("DEVELOPMENT_ONLY_ENDPOINT");
    });

    it("supports EMAIL_DELIVERY_MODE=development and AWS_SES_ENABLED=false with APP_PUBLIC_URL and AWS_SES_FROM_EMAIL omitted, and never initializes AWS SES when disabled", async () => {
      defaultEmailDeliveryProvider.clearOutbox();

      const devConfigWithoutOptionalVars: Record<string, string | undefined> = {
        APP_ENV: "development",
        NODE_ENV: "development",
        EMAIL_DELIVERY_MODE: "development",
        AWS_SES_ENABLED: "false",
        AWS_SES_REGION: "ap-south-1",
        AWS_SES_FROM_NAME: "Aurelia TimeFlow",
        // APP_PUBLIC_URL and AWS_SES_FROM_EMAIL intentionally omitted
      };

      // 1. Validation succeeds with APP_PUBLIC_URL and AWS_SES_FROM_EMAIL completely omitted
      const validation = validateEmailDeliveryEnvironment(devConfigWithoutOptionalVars);
      expect(validation.valid).toBe(true);
      expect(validation.mode).toBe("development_outbox");
      expect(validation.isProduction).toBe(false);
      expect(validation.appPublicUrl).toBe("http://localhost:3000");
      expect(validation.fromEmail).toBeNull();
      expect(validation.errors).toHaveLength(0);

      // 2. When AWS_SES_ENABLED=false, isAwsSesConfigured returns false and loadAwsSesConfig refuses to initialize SES even if credentials exist
      const disabledWithCreds: Record<string, string | undefined> = {
        ...devConfigWithoutOptionalVars,
        AWS_SES_FROM_EMAIL: "sender@example.com",
        AWS_SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      };
      expect(isAwsSesConfigured(disabledWithCreds)).toBe(false);
      expect(() => loadAwsSesConfig(disabledWithCreds)).toThrow(
        /AWS SES email delivery is disabled/,
      );

      // 3. resolveEmailDeliveryProvider returns the development outbox and never instantiates AwsSesEmailProvider
      const resolvedProvider = resolveEmailDeliveryProvider(disabledWithCreds);
      expect(resolvedProvider).toBe(defaultEmailDeliveryProvider);
      expect(resolvedProvider).not.toBeInstanceOf(AwsSesEmailProvider);

      // 4. End-to-end password-reset and verification work using the development outbox when APP_PUBLIC_URL and AWS_SES_FROM_EMAIL are omitted
      const regRes = await handleApiRequest(
        new Request("http://localhost:3000/api/v1/onboarding/self-service/register-company", {
          method: "POST",
          body: JSON.stringify({
            companyName: "NoDomain Startup",
            slug: "nodomain-startup",
            adminEmail: "founder@nodomain.local",
            adminFullName: "Founder One",
          }),
        }),
        { store, env: devConfigWithoutOptionalVars },
      );
      expect(regRes?.status).toBe(201);

      const outbox = getDevelopmentEmailOutbox(devConfigWithoutOptionalVars);
      const email = outbox.getLatestEmailFor("founder@nodomain.local", "email_verification");
      expect(email).toBeDefined();
      expect(email?.actionUrl).toContain("http://localhost:3000/verify-email?token=");
    });

    it("enforces CSRF protection on cookie-authenticated state-changing requests and blocks cross-origin attacks", async () => {
      const store = new MultiTenantDataStore();
      const adminUser: UserRecord = {
        id: "usr_csrf_test_01",
        email: "csrf-target@company.example.com",
        fullName: "CSRF Target",
        status: "active",
        isPlatformAdmin: false,
        emailVerifiedAt: "2026-03-01T00:00:00.000Z",
      };
      store.registerUser(adminUser, "dummy_hash");
      const { rawToken } = defaultSessionManager.createSession(adminUser.id, adminUser.email);

      // 1. Cross-site request with cookie but attacker origin is rejected with 403 CSRF_DETECTED
      const crossSiteReq = new Request("http://localhost:3000/api/v1/auth/session/rotate", {
        method: "POST",
        headers: {
          cookie: `aurelia_session=${rawToken}`,
          origin: "https://evil-attacker.example.com",
          "sec-fetch-site": "cross-site",
        },
      });
      const crossSiteRes = await handleApiRequest(crossSiteReq, { store });
      expect(crossSiteRes?.status).toBe(403);
      const crossSiteBody = (await crossSiteRes?.json()) as { error?: string };
      expect(crossSiteBody.error).toBe("CSRF_DETECTED");

      // 2. Same-origin request with cookie succeeds (or proceeds past CSRF guard)
      const sameOriginReq = new Request("http://localhost:3000/api/v1/auth/session/rotate", {
        method: "POST",
        headers: {
          cookie: `aurelia_session=${rawToken}`,
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        },
      });
      const sameOriginRes = await handleApiRequest(sameOriginReq, { store });
      expect(sameOriginRes?.status).not.toBe(403);

      // 3. Bearer token request is immune to ambient credential CSRF and bypasses CSRF check
      const bearerReq = new Request("http://localhost:3000/api/v1/auth/session/rotate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${rawToken}`,
          origin: "https://external-client.example.com",
        },
      });
      const bearerRes = await handleApiRequest(bearerReq, { store });
      expect(bearerRes?.status).not.toBe(403);
    });

    it("verifies auth persistence tables are exported in Drizzle schema", async () => {
      const dbSchema = await import("../server/db/schema");
      expect(dbSchema.userSessions).toBeDefined();
      expect(dbSchema.passwordResetTokens).toBeDefined();
      expect(dbSchema.emailVerificationTokens).toBeDefined();
    });
  });
});
