// @vitest-environment node
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/node-postgres";
import type { QueryResult } from "pg";
import { describe, expect, it, beforeEach } from "vitest";

import { defaultAuthService } from "../server/auth/auth-service";
import { defaultEmailDeliveryProvider } from "../server/auth/email-provider";
import { hashPassword, verifyPassword, validatePasswordComplexity } from "../server/auth/password";
import { defaultSessionManager, SessionManager } from "../server/auth/session-manager";
import { defaultSsoService, loadOidcConfigFromAwsSecrets } from "../server/auth/sso-service";
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

      const db = drizzle(pgliteClient as unknown as Parameters<typeof drizzle>[0], {
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
});
