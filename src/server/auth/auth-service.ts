import { eq } from "drizzle-orm";
import { redactPostgresCredentials, type AureliaAwsDb } from "../db/aws-postgres";
import * as schema from "../db/schema";
import { MultiTenantDataStore } from "../repositories/tenant-scoped-store";
import {
  AuthorizationError,
  TenantIsolationError,
  type MembershipRecord,
  type ResolvedTenantContext,
  type TenantRecord,
  type UserRecord,
} from "../tenancy/tenant-context";
import {
  defaultEmailDeliveryProvider,
  EmailDeliveryError,
  resolveEmailDeliveryProvider,
  type EmailDeliveryProvider,
} from "./email-provider";
import { verifyPassword } from "./password";
import { defaultPasswordResetService, PasswordResetService } from "./password-reset";
import { defaultLoginRateLimiter, LoginRateLimiter } from "./rate-limiter";
import { defaultSessionManager, SessionManager, type UserSession } from "./session-manager";
import {
  defaultSsoService,
  loadOidcConfigFromAwsSecrets,
  SsoService,
  type OidcProviderConfig,
} from "./sso-service";

export class DatabaseUnavailableError extends Error {
  public readonly code = "DATABASE_UNAVAILABLE";
  public readonly statusCode = 503;

  constructor(
    message = "Production authentication and workspace operations require an active PostgreSQL connection. In-memory fallback is disabled in production.",
  ) {
    super(redactPostgresCredentials(message));
    this.name = "DatabaseUnavailableError";
  }
}

export function extractSafeDatabaseErrorMessage(
  err: unknown,
  fallback = "Database operation failed",
): string {
  if (!(err instanceof Error)) {
    return fallback;
  }
  const causeMsg =
    err.cause instanceof Error
      ? err.cause.message
      : typeof (err as { cause?: unknown }).cause === "string"
        ? String((err as { cause?: unknown }).cause)
        : "";
  const combined = causeMsg ? `${err.message} (${causeMsg})` : err.message;
  return redactPostgresCredentials(combined);
}

export function isProductionEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const appEnv = env["APP_ENV"]?.trim().toLowerCase();
  const nodeEnv = env["NODE_ENV"]?.trim().toLowerCase();

  if (env === process.env) {
    if (
      env["VITEST"] === "true" ||
      nodeEnv === "test" ||
      (nodeEnv === "development" && env["AWS_PRIVATE_VPC_EXECUTION"] !== "true")
    ) {
      return false;
    }
  }

  if (appEnv === "production") {
    return true;
  }
  if (appEnv && appEnv !== "production") {
    return false;
  }
  return nodeEnv === "production";
}

export interface LoginResult {
  user: UserRecord;
  session: UserSession;
  sessionToken: string;
  setCookieHeader: string;
  tenants: Array<{ tenant: TenantRecord; membership: MembershipRecord }>;
}

export interface AuthServiceOptions {
  sessionManager?: SessionManager | undefined;
  rateLimiter?: LoginRateLimiter | undefined;
  passwordResetService?: PasswordResetService | undefined;
  emailProvider?: EmailDeliveryProvider | undefined;
  ssoService?: SsoService | undefined;
}

export class AuthService {
  private readonly sessionManager: SessionManager;
  private readonly rateLimiter: LoginRateLimiter;
  private readonly passwordResetService: PasswordResetService;
  private readonly emailProvider: EmailDeliveryProvider;
  private readonly ssoService: SsoService;

  constructor(options?: AuthServiceOptions) {
    this.sessionManager = options?.sessionManager ?? defaultSessionManager;
    this.rateLimiter = options?.rateLimiter ?? defaultLoginRateLimiter;
    this.passwordResetService = options?.passwordResetService ?? defaultPasswordResetService;
    this.emailProvider = options?.emailProvider ?? defaultEmailDeliveryProvider;
    this.ssoService = options?.ssoService ?? defaultSsoService;
  }

  public getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  public getRateLimiter(): LoginRateLimiter {
    return this.rateLimiter;
  }

  public getPasswordResetService(): PasswordResetService {
    return this.passwordResetService;
  }

  public getEmailProvider(): EmailDeliveryProvider {
    return this.emailProvider;
  }

  public getSsoService(): SsoService {
    return this.ssoService;
  }

  private assertProductionDatabaseAvailable(context: {
    db?: AureliaAwsDb | undefined;
    env?: Record<string, string | undefined> | undefined;
  }): void {
    if (isProductionEnvironment(context.env) && !context.db) {
      throw new DatabaseUnavailableError();
    }
  }

  private wrapDatabaseError(err: unknown): never {
    if (
      err instanceof AuthorizationError ||
      err instanceof TenantIsolationError ||
      err instanceof DatabaseUnavailableError ||
      err instanceof EmailDeliveryError
    ) {
      throw err;
    }
    const safeMsg = extractSafeDatabaseErrorMessage(err, "Database operation failed");
    throw new DatabaseUnavailableError(
      `PostgreSQL authentication store is unavailable: ${safeMsg}`,
    );
  }

  /**
   * Production Email & Password Authentication:
   * - In production mode, requires PostgreSQL (`context.db`) and NEVER falls back to in-memory `store`.
   * - Brute-force rate limiting by IP + email
   * - Constant-time scrypt password verification (never allows userId-only impersonation)
   * - Account status verification (active / suspended / deactivated / locked / disabled)
   * - Cryptographically secure 256-bit session token issuance persisted to PostgreSQL
   * - HttpOnly, Secure, SameSite Set-Cookie generation
   * - Automatic discovery of authorized tenant workspaces
   */
  public async login(
    input: {
      email: string;
      password?: string | undefined;
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
    context: {
      db?: AureliaAwsDb | undefined;
      store?: MultiTenantDataStore | undefined;
      isSecureRequest?: boolean | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<LoginResult> {
    this.assertProductionDatabaseAvailable(context);
    const isProd = isProductionEnvironment(context.env);

    const email = (input.email || "").trim().toLowerCase();
    const ip = input.ipAddress || "127.0.0.1";
    const rateLimitKey = this.rateLimiter.makeKey(ip, email);

    // 1. Check Rate Limiter
    const rateStatus = this.rateLimiter.check(rateLimitKey);
    if (!rateStatus.allowed) {
      throw new AuthorizationError(
        `Too many failed login attempts. Account temporarily locked. Please try again in ${rateStatus.retryAfterSeconds} seconds.`,
      );
    }

    if (!email || !input.password) {
      this.rateLimiter.recordFailure(rateLimitKey);
      throw new AuthorizationError("Invalid email or password.");
    }

    // 2. Fetch User from Database (required in production) or Store (only in non-production demo/tests)
    let user: UserRecord | null = null;
    let storedPasswordHash: string | null = null;

    if (context.db) {
      try {
        const userRows = await context.db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);

        const dbUser = userRows[0];
        if (dbUser) {
          user = {
            id: dbUser.id,
            email: dbUser.email,
            fullName: dbUser.fullName,
            emailVerifiedAt: dbUser.emailVerifiedAt ? dbUser.emailVerifiedAt.toISOString() : null,
            isPlatformAdmin: dbUser.isPlatformAdmin,
            status: dbUser.status as UserRecord["status"],
          };
          storedPasswordHash = dbUser.passwordHash;
        }
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else if (!isProd && context.store) {
      const allUsers = context.store.listAllUsers ? context.store.listAllUsers() : [];
      const found = allUsers.find((u) => u.email.toLowerCase() === email);
      if (found) {
        user = found;
        storedPasswordHash = context.store.getUserPasswordHash
          ? context.store.getUserPasswordHash(found.id)
          : null;
      }
    } else {
      throw new DatabaseUnavailableError();
    }

    if (!user || !storedPasswordHash) {
      this.rateLimiter.recordFailure(rateLimitKey);
      throw new AuthorizationError("Invalid email or password.");
    }

    // 3. Verify Account Status
    if (user.status === "deactivated" || user.status === "disabled") {
      throw new AuthorizationError(
        "This account has been deactivated. Please contact your workspace administrator.",
      );
    }
    if (user.status === "suspended" || user.status === "locked") {
      throw new AuthorizationError("This account is currently suspended. Please contact support.");
    }

    // 4. Verify Password using constant-time scrypt comparison
    const isValid = await verifyPassword(input.password, storedPasswordHash);
    if (!isValid) {
      this.rateLimiter.recordFailure(rateLimitKey);
      throw new AuthorizationError("Invalid email or password.");
    }

    // 5. Authentication Succeeded -> Reset Rate Limiter
    this.rateLimiter.recordSuccess(rateLimitKey);

    // 6. Issue Session (persisted in PostgreSQL when db is available) & HttpOnly Cookie
    let rawToken: string;
    let session: UserSession;
    if (context.db) {
      try {
        const created = await this.sessionManager.createSessionInDb(user.id, user.email, {
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          db: context.db,
        });
        rawToken = created.rawToken;
        session = created.session;
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else {
      const created = this.sessionManager.createSession(user.id, user.email, {
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      rawToken = created.rawToken;
      session = created.session;
    }

    const setCookieHeader = this.sessionManager.buildSessionCookie(rawToken, {
      secure: (context.isSecureRequest ?? false) || isProd,
      sameSite: "Lax",
      path: "/",
    });

    // 7. Resolve Tenant Memberships
    let tenants: Array<{ tenant: TenantRecord; membership: MembershipRecord }> = [];
    if (context.db) {
      try {
        const { listUserTenantsFromDb } = await import("../repositories/postgres-tenant-store");
        tenants = await listUserTenantsFromDb(context.db, user.id);
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else if (!isProd && context.store) {
      tenants = context.store.listUserTenants(user.id);
    }

    return {
      user,
      session,
      sessionToken: rawToken,
      setCookieHeader,
      tenants,
    };
  }

  /**
   * Completes OIDC Authentication after code exchange & JWKS ID token verification,
   * verifying the user and active tenant membership, and issuing a real Aurelia session.
   */
  public async authenticateWithOidcCallback(
    params: {
      code?: string | undefined;
      state?: string | undefined;
      error?: string | undefined;
      errorDescription?: string | undefined;
      redirectUri?: string | undefined;
      codeVerifierOverride?: string | undefined;
      connectionId?: string | undefined;
      config?: OidcProviderConfig | undefined;
      fetchFn?: typeof fetch | undefined;
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
      nowSeconds?: number | undefined;
    },
    context: {
      db?: AureliaAwsDb | undefined;
      store?: MultiTenantDataStore | undefined;
      isSecureRequest?: boolean | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<
    LoginResult & { tenantContext: ResolvedTenantContext; provider: "google_oidc" | "entra_oidc" }
  > {
    this.assertProductionDatabaseAvailable(context);
    const isProd = isProductionEnvironment(context.env);

    let effectiveConfig = params.config;
    if (!effectiveConfig && context.env?.["AWS_SSO_SECRET_JSON"]) {
      const providerHint = params.connectionId?.includes("entra") ? "entra_oidc" : "google_oidc";
      effectiveConfig = loadOidcConfigFromAwsSecrets(
        context.env["AWS_SSO_SECRET_JSON"],
        providerHint,
      );
    }

    const oidcResult = await this.ssoService.completeOidcCallbackExchange({
      code: params.code,
      state: params.state,
      error: params.error,
      errorDescription: params.errorDescription,
      redirectUri: params.redirectUri,
      codeVerifierOverride: params.codeVerifierOverride,
      connectionId: params.connectionId,
      config: effectiveConfig,
      fetchFn: params.fetchFn,
      nowSeconds: params.nowSeconds,
    });

    const email = (oidcResult.claims.email || "").trim().toLowerCase();
    const targetTenantId = oidcResult.tenantId;

    let user: UserRecord | null = null;
    let tenantContext: ResolvedTenantContext;
    let tenants: Array<{ tenant: TenantRecord; membership: MembershipRecord }> = [];

    if (context.db) {
      try {
        const userRows = await context.db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);
        const dbUser = userRows[0];
        if (!dbUser) {
          throw new AuthorizationError(
            `No active Aurelia TimeFlow user account found for OIDC identity "${email}".`,
          );
        }
        user = {
          id: dbUser.id,
          email: dbUser.email,
          fullName: dbUser.fullName,
          emailVerifiedAt: dbUser.emailVerifiedAt ? dbUser.emailVerifiedAt.toISOString() : null,
          isPlatformAdmin: dbUser.isPlatformAdmin,
          status: dbUser.status as UserRecord["status"],
        };
      } catch (err) {
        this.wrapDatabaseError(err);
      }

      if (user.status !== "active") {
        throw new AuthorizationError(`User account "${email}" is not active.`);
      }

      try {
        const { resolveTenantContextFromDb, listUserTenantsFromDb } =
          await import("../repositories/postgres-tenant-store");
        tenantContext = await resolveTenantContextFromDb(context.db, user.id, targetTenantId);
        tenants = await listUserTenantsFromDb(context.db, user.id);
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else if (!isProd && context.store) {
      const allUsers = context.store.listAllUsers ? context.store.listAllUsers() : [];
      const found = allUsers.find((u) => u.email.toLowerCase() === email);
      if (!found) {
        throw new AuthorizationError(
          `No active Aurelia TimeFlow user account found for OIDC identity "${email}".`,
        );
      }
      if (found.status !== "active") {
        throw new AuthorizationError(`User account "${email}" is not active.`);
      }
      user = found;
      tenantContext = context.store.resolveTenantContext(user.id, targetTenantId);
      tenants = context.store.listUserTenants(user.id);
    } else {
      throw new DatabaseUnavailableError();
    }

    let rawToken: string;
    let session: UserSession;
    if (context.db) {
      try {
        const created = await this.sessionManager.createSessionInDb(user.id, user.email, {
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          db: context.db,
        });
        rawToken = created.rawToken;
        session = created.session;
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else {
      const created = this.sessionManager.createSession(user.id, user.email, {
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });
      rawToken = created.rawToken;
      session = created.session;
    }

    const setCookieHeader = this.sessionManager.buildSessionCookie(rawToken, {
      secure: (context.isSecureRequest ?? false) || isProd,
      sameSite: "Lax",
      path: "/",
    });

    return {
      user,
      session,
      sessionToken: rawToken,
      setCookieHeader,
      tenants,
      tenantContext,
      provider: oidcResult.provider,
    };
  }

  /**
   * Log out and invalidate the session (in PostgreSQL and memory).
   */
  public async logout(
    sessionToken: string,
    isSecure = false,
    context?: {
      db?: AureliaAwsDb | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<{ success: boolean; clearCookieHeader: string; setCookieHeader: string }> {
    if (context && isProductionEnvironment(context.env) && !context.db) {
      throw new DatabaseUnavailableError();
    }
    if (sessionToken) {
      if (context?.db) {
        try {
          await this.sessionManager.destroySessionInDb(sessionToken, { db: context.db });
        } catch (err) {
          this.wrapDatabaseError(err);
        }
      } else {
        this.sessionManager.destroySession(sessionToken);
      }
    }
    const clearCookieHeader = this.sessionManager.buildLogoutCookie({
      secure: isSecure,
      path: "/",
    });
    return { success: true, clearCookieHeader, setCookieHeader: clearCookieHeader };
  }

  /**
   * Rotates an active session token atomically.
   */
  public async rotateSession(
    oldToken: string,
    isSecure = false,
    context?: {
      db?: AureliaAwsDb | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<{ sessionToken: string; setCookieHeader: string; session: UserSession } | null> {
    if (context && isProductionEnvironment(context.env) && !context.db) {
      throw new DatabaseUnavailableError();
    }

    let rotated: { newRawToken: string; session: UserSession } | null = null;
    if (context?.db) {
      try {
        rotated = await this.sessionManager.rotateSessionInDb(oldToken, { db: context.db });
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else {
      rotated = this.sessionManager.rotateSession(oldToken);
    }

    if (!rotated) return null;

    const setCookieHeader = this.sessionManager.buildSessionCookie(rotated.newRawToken, {
      secure: isSecure,
      sameSite: "Lax",
      path: "/",
    });

    return {
      sessionToken: rotated.newRawToken,
      setCookieHeader,
      session: rotated.session,
    };
  }

  /**
   * Resolves and verifies tenant execution context from an authenticated session.
   * STRICT SECURITY ENFORCEMENT:
   * 1. In production mode, requires PostgreSQL (`context.db`) and NEVER falls back to `context.store`
   * 2. Resolves caller's user identity from validated session
   * 3. Rejects any attempt by the caller to access a tenant they do not belong to
   * 4. Aggregates caller's roles and permissions inside THAT verified tenant
   */
  public async resolveAuthenticatedTenantContext(
    sessionToken: string,
    targetTenantId: string,
    context: {
      db?: AureliaAwsDb | undefined;
      store?: MultiTenantDataStore | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<ResolvedTenantContext> {
    this.assertProductionDatabaseAvailable(context);
    const isProd = isProductionEnvironment(context.env);

    let session: UserSession | null = null;
    if (context.db) {
      try {
        session = await this.sessionManager.validateSessionInDb(sessionToken, { db: context.db });
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else if (!isProd) {
      session = this.sessionManager.validateSession(sessionToken);
    } else {
      throw new DatabaseUnavailableError();
    }

    if (!session) {
      throw new AuthorizationError("UNAUTHENTICATED: Invalid or expired session.");
    }

    if (context.db) {
      const { resolveTenantContextFromDb } = await import("../repositories/postgres-tenant-store");
      try {
        return await resolveTenantContextFromDb(context.db, session.userId, targetTenantId);
      } catch (err) {
        if (err instanceof TenantIsolationError || err instanceof AuthorizationError) {
          throw err;
        }
        this.wrapDatabaseError(err);
      }
    }

    if (!isProd && context.store) {
      try {
        return context.store.resolveTenantContext(session.userId, targetTenantId);
      } catch (err) {
        if (err instanceof TenantIsolationError || err instanceof AuthorizationError) {
          throw err;
        }
        throw new AuthorizationError(
          `User does not hold an active membership in tenant workspace "${targetTenantId}".`,
        );
      }
    }

    throw new DatabaseUnavailableError();
  }

  /**
   * Initiates password reset request.
   * Generates a cryptographically random reset token, stores only its SHA-256 hash,
   * and delivers the token via the configured EmailDeliveryProvider.
   *
   * Security Invariants:
   * - Never returns the raw resetToken in the return payload.
   * - Confirms provider delivery acceptance (`delivery.accepted && delivery.messageId`) before
   *   reporting `emailDispatched: true`.
   */
  public async requestPasswordReset(
    email: string,
    context: {
      db?: AureliaAwsDb | undefined;
      store?: MultiTenantDataStore | undefined;
      env?: Record<string, string | undefined> | undefined;
      emailProvider?: EmailDeliveryProvider | undefined;
    },
  ): Promise<{ success: boolean; emailDispatched: boolean }> {
    this.assertProductionDatabaseAvailable(context);
    const isProd = isProductionEnvironment(context.env);
    const cleanEmail = email.trim().toLowerCase();
    let userId: string | null = null;

    if (context.db) {
      try {
        const rows = await context.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, cleanEmail))
          .limit(1);
        if (rows[0]) userId = rows[0].id;
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else if (!isProd && context.store) {
      const allUsers = context.store.listAllUsers ? context.store.listAllUsers() : [];
      const found = allUsers.find((u) => u.email.toLowerCase() === cleanEmail);
      if (found) userId = found.id;
    } else {
      throw new DatabaseUnavailableError();
    }

    if (!userId) {
      // Do not reveal whether user exists (prevent email enumeration)
      return { success: true, emailDispatched: false };
    }

    const customEmailProvider =
      context.emailProvider ??
      (this.emailProvider !== defaultEmailDeliveryProvider ? this.emailProvider : undefined);
    const emailProvider = resolveEmailDeliveryProvider(context.env, customEmailProvider);

    let rawToken: string;
    let expiresAt: number;
    if (context.db) {
      try {
        const created = await this.passwordResetService.createResetTokenInDb(userId, cleanEmail, {
          db: context.db,
        });
        rawToken = created.rawToken;
        expiresAt = created.expiresAt;
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else {
      const created = this.passwordResetService.createResetToken(userId, cleanEmail);
      rawToken = created.rawToken;
      expiresAt = created.expiresAt;
    }

    const delivery = await emailProvider.sendPasswordResetEmail({
      to: cleanEmail,
      resetToken: rawToken,
      expiresAt,
    });

    if (!delivery || !delivery.accepted || !delivery.messageId?.trim()) {
      throw new EmailDeliveryError(
        "Email provider did not confirm password reset email acceptance.",
        502,
      );
    }

    return { success: true, emailDispatched: true };
  }

  /**
   * Confirms password reset with reset token.
   * Validates and consumes the single-use token, updates the password hash,
   * and revokes all existing user sessions transactionally.
   */
  public async confirmPasswordReset(
    rawToken: string,
    newPassword: string,
    context: {
      db?: AureliaAwsDb | undefined;
      store?: MultiTenantDataStore | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<{ success: boolean; userId: string }> {
    this.assertProductionDatabaseAvailable(context);
    const isProd = isProductionEnvironment(context.env);

    const result = await this.passwordResetService.executePasswordReset(rawToken, newPassword, {
      db: context.db,
    });

    // Note: when context.db is present, executePasswordReset already updates users.password_hash
    // and revokes all user_sessions inside the same atomic PostgreSQL transaction.
    if (!result.updatedInDb && !isProd && context.store && context.store.setUserPasswordHash) {
      context.store.setUserPasswordHash(result.userId, result.newPasswordHash);
    }

    return { success: true, userId: result.userId };
  }

  /**
   * Updates user account status (e.g. active, suspended, deactivated).
   * Automatically invalidates all sessions when deactivated or suspended.
   */
  public async updateAccountStatus(
    userId: string,
    newStatus: "active" | "suspended" | "deactivated",
    context: {
      db?: AureliaAwsDb | undefined;
      store?: MultiTenantDataStore | undefined;
      env?: Record<string, string | undefined> | undefined;
    },
  ): Promise<void> {
    this.assertProductionDatabaseAvailable(context);
    const isProd = isProductionEnvironment(context.env);

    if (context.db) {
      try {
        const dbStatus: "active" | "locked" | "disabled" =
          newStatus === "active" ? "active" : newStatus === "suspended" ? "locked" : "disabled";
        await context.db
          .update(schema.users)
          .set({
            status: dbStatus,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, userId));
      } catch (err) {
        this.wrapDatabaseError(err);
      }
    } else if (!isProd && context.store) {
      const user = context.store.getUser(userId);
      if (user) {
        context.store.registerUser({ ...user, status: newStatus });
      }
    }

    if (newStatus === "deactivated" || newStatus === "suspended") {
      if (context.db) {
        try {
          await this.sessionManager.destroyAllUserSessionsInDb(userId, { db: context.db });
        } catch (err) {
          this.wrapDatabaseError(err);
        }
      } else {
        this.sessionManager.destroyAllUserSessions(userId);
      }
    }
  }
}

export const defaultAuthService = new AuthService();
