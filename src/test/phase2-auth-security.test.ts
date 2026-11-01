import { describe, expect, it, beforeEach } from "vitest";
import { defaultAuthService } from "../server/auth/auth-service";
import { defaultSessionManager } from "../server/auth/session-manager";
import { defaultSsoService } from "../server/auth/sso-service";
import { hashPassword, verifyPassword, validatePasswordComplexity } from "../server/auth/password";
import { handleApiRequest } from "../server/api/routes";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";

describe("Phase 2: Production Authentication & Security", () => {
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

  const defaultPassword = "SecurePass123!@#";

  beforeEach(async () => {
    // Reset session store & rate limiter
    sessionManager.clear();
    authService.getRateLimiter().reset();

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

  describe("2. Valid and Invalid Login & Rate Limiting", () => {
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

      // 5 consecutive failed attempts
      for (let i = 0; i < 5; i++) {
        await expect(
          authService.login({ email, password: "BadPassword!", ipAddress: ip }, { store }),
        ).rejects.toThrow("Invalid email or password.");
      }

      // 6th attempt must be locked out
      await expect(
        authService.login({ email, password: defaultPassword, ipAddress: ip }, { store }),
      ).rejects.toThrow(/Too many failed login attempts/);
    });
  });

  describe("3. Session Expiration, Idle Timeout & Token Rotation", () => {
    it("validates session tokens with SHA-256 hash lookup", () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);
      expect(rawToken).toHaveLength(64); // 256-bit hex

      const validated = sessionManager.validateSession(rawToken);
      expect(validated?.userId).toBe(adminUser.id);
      expect(validated?.email).toBe(adminUser.email);
    });

    it("rejects expired sessions and inactive sessions beyond idle timeout", () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      // Artificially age the session beyond idle timeout (2 hours)
      sessionManager.simulateSessionAging(rawToken, 2 * 60 * 60 * 1000 + 1000);

      const validated = sessionManager.validateSession(rawToken);
      expect(validated).toBeNull();
    });

    it("rotates session tokens safely and immediately invalidates the old token", () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      const rotated = sessionManager.rotateSession(rawToken, { secure: true });
      expect(rotated).not.toBeNull();
      expect(rotated?.newRawToken).not.toBe(rawToken);

      // Old token is immediately revoked
      expect(sessionManager.validateSession(rawToken)).toBeNull();

      // New token is active
      expect(sessionManager.validateSession(rotated!.newRawToken)?.userId).toBe(adminUser.id);
    });
  });

  describe("4. Logout & Session Invalidation", () => {
    it("destroys session on logout and returns clearing cookie", async () => {
      const { rawToken } = sessionManager.createSession(adminUser.id, adminUser.email);

      const logoutRes = await authService.logout(rawToken);
      expect(logoutRes.setCookieHeader).toContain("Max-Age=0");

      // Validating destroyed token returns null
      expect(sessionManager.validateSession(rawToken)).toBeNull();
    });

    it("invalidates all sessions for a user when account is deactivated or password is reset", () => {
      const s1 = sessionManager.createSession(adminUser.id, adminUser.email);
      const s2 = sessionManager.createSession(adminUser.id, adminUser.email);

      expect(sessionManager.validateSession(s1.rawToken)).not.toBeNull();
      expect(sessionManager.validateSession(s2.rawToken)).not.toBeNull();

      sessionManager.destroyAllUserSessions(adminUser.id);

      expect(sessionManager.validateSession(s1.rawToken)).toBeNull();
      expect(sessionManager.validateSession(s2.rawToken)).toBeNull();
    });
  });

  describe("5. Multi-Tenant Authorization & RBAC Privilege Isolation", () => {
    it("blocks Employee from approving timesheets (missing timesheet:approve:team)", async () => {
      // 1. Employee logs in
      const empLogin = await authService.login(
        { email: employeeUser.email, password: defaultPassword },
        { store },
      );

      // 2. Employee attempts to call approve timesheet API
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
      // 1. Manager logs in
      const mgrLogin = await authService.login(
        { email: managerUser.email, password: defaultPassword },
        { store },
      );

      // 2. Manager approves timesheet
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

    it("blocks Manager from accessing Admin-only user invitation API", async () => {
      // 1. Manager logs in
      const mgrLogin = await authService.login(
        { email: managerUser.email, password: defaultPassword },
        { store },
      );

      // 2. Manager attempts bulk CSV import (requires tenant:members:manage)
      const inviteRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/invitations/bulk-csv`, {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${mgrLogin.sessionToken}`,
          },
          body: JSON.stringify({
            csvText: "newuser@alpha.example.com,New Dev,Developer,Engineering,employee,",
          }),
        }),
        { store },
      );

      expect(inviteRes?.status).toBe(403);
      const data = (await inviteRes?.json()) as { error: string };
      expect(data.error).toBe("INSUFFICIENT_PERMISSIONS");
    });

    it("allows Admin to access Admin-only APIs", async () => {
      // 1. Admin logs in
      const adminLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      // 2. Admin performs bulk CSV import
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

    it("rejects unauthenticated requests to protected endpoints with 401", async () => {
      const res = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/team`),
        { store },
      );
      expect(res?.status).toBe(401);
      const data = (await res?.json()) as { error: string };
      expect(data.error).toBe("UNAUTHENTICATED");
    });
  });

  describe("6. Cross-Tenant Access & Forged Tenant ID Protection", () => {
    it("strictly blocks user in Tenant Alpha from accessing Tenant Beta endpoints", async () => {
      // 1. Alpha Admin logs in
      const alphaLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      // 2. Alpha Admin attempts to access Tenant Beta's team endpoint
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
      // 1. Alpha Admin logs in
      const alphaLogin = await authService.login(
        { email: adminUser.email, password: defaultPassword },
        { store },
      );

      // 2. Post to Alpha URL but send claimed tenantId = Beta in body
      const forgedRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${tenantAlphaId}/invitations/bulk-csv`, {
          method: "POST",
          headers: {
            cookie: `aurelia_session=${alphaLogin.sessionToken}`,
          },
          body: JSON.stringify({
            tenantId: tenantBetaId, // Forged!
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

  describe("7. Password Reset Workflow & Session Revocation", () => {
    it("executes password reset, updates password hash, and invalidates all existing sessions", async () => {
      // 1. Employee logs in and gets active session
      const initialLogin = await authService.login(
        { email: employeeUser.email, password: defaultPassword },
        { store },
      );
      expect(sessionManager.validateSession(initialLogin.sessionToken)).not.toBeNull();

      // 2. Request password reset
      const resetReq = await authService.requestPasswordReset(employeeUser.email, { store });
      expect(resetReq.success).toBe(true);
      expect(resetReq.resetToken).toBeTruthy();

      // 3. Confirm password reset with new password
      const newPassword = "BrandNewPassword2026!@#";
      const confirmRes = await authService.confirmPasswordReset(resetReq.resetToken!, newPassword, {
        store,
      });
      expect(confirmRes.success).toBe(true);
      expect(confirmRes.userId).toBe(employeeUser.id);

      // 4. Initial session is now revoked
      expect(sessionManager.validateSession(initialLogin.sessionToken)).toBeNull();

      // 5. Old password no longer works
      await expect(
        authService.login({ email: employeeUser.email, password: defaultPassword }, { store }),
      ).rejects.toThrow("Invalid email or password.");

      // 6. New password works
      const newLogin = await authService.login(
        { email: employeeUser.email, password: newPassword },
        { store },
      );
      expect(newLogin.sessionToken).toBeTruthy();

      // 7. Reset token cannot be reused
      await expect(
        authService.confirmPasswordReset(resetReq.resetToken!, "AnotherPass123!@#", { store }),
      ).rejects.toThrow(/Invalid or expired password reset token/);
    });
  });

  describe("8. Account Activation, Suspension & Deactivation", () => {
    it("deactivating account immediately revokes sessions and blocks future logins", async () => {
      // 1. Employee logs in
      const empLogin = await authService.login(
        { email: employeeUser.email, password: defaultPassword },
        { store },
      );
      expect(sessionManager.validateSession(empLogin.sessionToken)).not.toBeNull();

      // 2. Admin deactivates employee account
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

      // 3. Active session is destroyed
      expect(sessionManager.validateSession(empLogin.sessionToken)).toBeNull();

      // 4. Subsequent login attempt is blocked
      await expect(
        authService.login({ email: employeeUser.email, password: defaultPassword }, { store }),
      ).rejects.toThrow(/account has been deactivated/);
    });
  });

  describe("9. SSO Architecture Preparation (OIDC & SAML 2.0)", () => {
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

    it("rejects forged or tampered state in OIDC callback", () => {
      const result = ssoService.validateOidcCallback({
        code: "auth_code_123",
        state: "tampered_forged_state",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid.*state/i);
    });

    it("validates OIDC callback with valid signed state and enforces token exchange requirement", async () => {
      const oidcReq = ssoService.prepareGoogleOidcRequest({
        provider: "google_oidc",
        clientId: "google-client-id",
        issuerUrl: "https://accounts.google.com",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        redirectUri: "http://localhost/api/v1/auth/oidc/google/callback",
        tenantId: tenantAlphaId,
      });

      // API route callback validation
      const callbackRes = await handleApiRequest(
        new Request(
          `http://localhost/api/v1/auth/oidc/google/callback?code=mock_code_123&state=${oidcReq.state}`,
        ),
        { store },
      );

      expect(callbackRes?.status).toBe(200);
      const data = (await callbackRes?.json()) as { status: string; codeReceived: boolean };
      expect(data.status).toBe("oidc_callback_validated");
      expect(data.codeReceived).toBe(true);
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

      // Tampered RelayState validation
      const validation = ssoService.validateSamlResponse({
        samlResponse: "PHNhbWxwOlJlc3BvbnNlPjwvc2FtbHA6UmVzcG9uc2U+",
        relayState: "tampered_relay_state",
      });
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Invalid SAML RelayState");
    });
  });
});
