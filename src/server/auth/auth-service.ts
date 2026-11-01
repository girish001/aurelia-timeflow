import { eq } from "drizzle-orm";
import { type AureliaAwsDb } from "../db/aws-postgres";
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
import { defaultEmailDeliveryProvider, type EmailDeliveryProvider } from "./email-provider";
import { verifyPassword } from "./password";
import { defaultPasswordResetService, PasswordResetService } from "./password-reset";
import { defaultLoginRateLimiter, LoginRateLimiter } from "./rate-limiter";
import { defaultSessionManager, SessionManager, type UserSession } from "./session-manager";

export interface LoginResult {
  user: UserRecord;
  session: UserSession;
  sessionToken: string;
  setCookieHeader: string;
  tenants: Array<{ tenant: TenantRecord; membership: MembershipRecord }>;
}

export interface AuthServiceOptions {
  sessionManager?: SessionManager;
  rateLimiter?: LoginRateLimiter;
  passwordResetService?: PasswordResetService;
  emailProvider?: EmailDeliveryProvider;
}

export class AuthService {
  private readonly sessionManager: SessionManager;
  private readonly rateLimiter: LoginRateLimiter;
  private readonly passwordResetService: PasswordResetService;
  private readonly emailProvider: EmailDeliveryProvider;

  constructor(options?: AuthServiceOptions) {
    this.sessionManager = options?.sessionManager ?? defaultSessionManager;
    this.rateLimiter = options?.rateLimiter ?? defaultLoginRateLimiter;
    this.passwordResetService = options?.passwordResetService ?? defaultPasswordResetService;
    this.emailProvider = options?.emailProvider ?? defaultEmailDeliveryProvider;
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

  /**
   * Production Email & Password Authentication:
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
      password?: string;
      ipAddress?: string;
      userAgent?: string;
    },
    context: {
      db?: AureliaAwsDb;
      store?: MultiTenantDataStore;
      isSecureRequest?: boolean;
    },
  ): Promise<LoginResult> {
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

    // 2. Fetch User from Database or Store
    let user: UserRecord | null = null;
    let storedPasswordHash: string | null = null;

    if (context.db) {
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
    } else if (context.store) {
      const allUsers = context.store.listAllUsers ? context.store.listAllUsers() : [];
      const found = allUsers.find((u) => u.email.toLowerCase() === email);
      if (found) {
        user = found;
        storedPasswordHash = context.store.getUserPasswordHash
          ? context.store.getUserPasswordHash(found.id)
          : null;
      }
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
    const { rawToken, session } = context.db
      ? await this.sessionManager.createSessionInDb(user.id, user.email, {
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          db: context.db,
        })
      : this.sessionManager.createSession(user.id, user.email, {
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });

    const setCookieHeader = this.sessionManager.buildSessionCookie(rawToken, {
      secure: context.isSecureRequest ?? false,
      sameSite: "Lax",
      path: "/",
    });

    // 7. Resolve Tenant Memberships
    let tenants: Array<{ tenant: TenantRecord; membership: MembershipRecord }> = [];
    if (context.db) {
      const { listUserTenantsFromDb } = await import("../repositories/postgres-tenant-store");
      tenants = await listUserTenantsFromDb(context.db, user.id);
    } else if (context.store) {
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
   * Log out and invalidate the session (in PostgreSQL and memory).
   */
  public async logout(
    sessionToken: string,
    isSecure = false,
    context?: { db?: AureliaAwsDb },
  ): Promise<{ success: boolean; clearCookieHeader: string; setCookieHeader: string }> {
    if (sessionToken) {
      if (context?.db) {
        await this.sessionManager.destroySessionInDb(sessionToken, { db: context.db });
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
   * Rotates an active session token.
   */
  public async rotateSession(
    oldToken: string,
    isSecure = false,
    context?: { db?: AureliaAwsDb },
  ): Promise<{ sessionToken: string; setCookieHeader: string; session: UserSession } | null> {
    const rotated = context?.db
      ? await this.sessionManager.rotateSessionInDb(oldToken, { db: context.db })
      : this.sessionManager.rotateSession(oldToken);
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
   * 1. Resolves caller's user identity from validated session
   * 2. Rejects any attempt by the caller to access a tenant they do not belong to
   * 3. Aggregates caller's roles and permissions inside THAT verified tenant
   */
  public async resolveAuthenticatedTenantContext(
    sessionToken: string,
    targetTenantId: string,
    context: {
      db?: AureliaAwsDb;
      store?: MultiTenantDataStore;
    },
  ): Promise<ResolvedTenantContext> {
    const session = context.db
      ? await this.sessionManager.validateSessionInDb(sessionToken, { db: context.db })
      : this.sessionManager.validateSession(sessionToken);
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
        throw new AuthorizationError(
          `User does not hold an active membership in tenant workspace "${targetTenantId}".`,
        );
      }
    }

    if (context.store) {
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

    throw new AuthorizationError("No database or store context available.");
  }

  /**
   * Initiates password reset request.
   * Generates a cryptographically random reset token, stores only its SHA-256 hash,
   * and delivers the token via the configured EmailDeliveryProvider.
   */
  public async requestPasswordReset(
    email: string,
    context: { db?: AureliaAwsDb; store?: MultiTenantDataStore },
  ): Promise<{ success: boolean; resetToken?: string }> {
    const cleanEmail = email.trim().toLowerCase();
    let userId: string | null = null;

    if (context.db) {
      const rows = await context.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, cleanEmail))
        .limit(1);
      if (rows[0]) userId = rows[0].id;
    } else if (context.store) {
      const allUsers = context.store.listAllUsers ? context.store.listAllUsers() : [];
      const found = allUsers.find((u) => u.email.toLowerCase() === cleanEmail);
      if (found) userId = found.id;
    }

    if (!userId) {
      // Do not reveal whether user exists (prevent email enumeration)
      return { success: true };
    }

    const { rawToken, expiresAt } = context.db
      ? await this.passwordResetService.createResetTokenInDb(userId, cleanEmail, {
          db: context.db,
        })
      : this.passwordResetService.createResetToken(userId, cleanEmail);

    await this.emailProvider.sendPasswordResetEmail({
      to: cleanEmail,
      resetToken: rawToken,
      expiresAt,
    });

    return { success: true, resetToken: rawToken };
  }

  /**
   * Confirms password reset with reset token.
   * Validates and consumes the single-use token, updates the password hash,
   * and revokes all existing user sessions.
   */
  public async confirmPasswordReset(
    rawToken: string,
    newPassword: string,
    context: { db?: AureliaAwsDb; store?: MultiTenantDataStore },
  ): Promise<{ success: boolean; userId: string }> {
    const result = await this.passwordResetService.executePasswordReset(rawToken, newPassword, {
      db: context.db,
    });

    if (context.db) {
      await context.db
        .update(schema.users)
        .set({
          passwordHash: result.newPasswordHash,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, result.userId));
    } else if (context.store && context.store.setUserPasswordHash) {
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
    context: { db?: AureliaAwsDb; store?: MultiTenantDataStore },
  ): Promise<void> {
    if (context.db) {
      await context.db
        .update(schema.users)
        .set({
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, userId));
    } else if (context.store) {
      const user = context.store.getUser(userId);
      if (user) {
        context.store.registerUser({ ...user, status: newStatus });
      }
    }

    if (newStatus === "deactivated" || newStatus === "suspended") {
      await this.sessionManager.destroyAllUserSessionsInDb(userId, { db: context.db });
    }
  }
}

export const defaultAuthService = new AuthService();
