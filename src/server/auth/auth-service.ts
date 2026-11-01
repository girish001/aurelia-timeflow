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
import { hashPassword, verifyPassword } from "./password";
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
}

export class AuthService {
  private readonly sessionManager: SessionManager;
  private readonly rateLimiter: LoginRateLimiter;
  private readonly passwordResetService: PasswordResetService;

  constructor(options?: AuthServiceOptions) {
    this.sessionManager = options?.sessionManager ?? defaultSessionManager;
    this.rateLimiter = options?.rateLimiter ?? defaultLoginRateLimiter;
    this.passwordResetService = options?.passwordResetService ?? defaultPasswordResetService;
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

  /**
   * Production Email & Password Authentication:
   * - Brute-force rate limiting by IP + email
   * - Constant-time scrypt password verification
   * - Account status verification (active / suspended / deactivated)
   * - Cryptographically secure 256-bit session token issuance
   * - HttpOnly, Secure, SameSite Set-Cookie generation
   * - Automatic discovery of authorized tenant workspaces
   */
  public async login(
    input: {
      email: string;
      password?: string;
      userId?: string; // Fallback for seeded test/demo users without passwords
      ipAddress?: string;
      userAgent?: string;
    },
    context: {
      db?: AureliaAwsDb;
      store?: MultiTenantDataStore;
      isSecureRequest?: boolean;
    },
  ): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const ip = input.ipAddress || "127.0.0.1";
    const rateLimitKey = this.rateLimiter.makeKey(ip, email);

    // 1. Check Rate Limiter
    const rateStatus = this.rateLimiter.check(rateLimitKey);
    if (!rateStatus.allowed) {
      throw new AuthorizationError(
        `Too many failed login attempts. Account temporarily locked. Please try again in ${rateStatus.retryAfterSeconds} seconds.`,
      );
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
      const found = allUsers.find(
        (u) => u.email.toLowerCase() === email || (input.userId && u.id === input.userId),
      );
      if (found) {
        user = found;
        storedPasswordHash = context.store.getUserPasswordHash
          ? context.store.getUserPasswordHash(found.id)
          : null;
      }
    }

    if (!user) {
      this.rateLimiter.recordFailure(rateLimitKey);
      throw new AuthorizationError("Invalid email or password.");
    }

    // 3. Verify Account Status
    if (user.status === "deactivated") {
      throw new AuthorizationError(
        "This account has been deactivated. Please contact your workspace administrator.",
      );
    }
    if (user.status === "suspended") {
      throw new AuthorizationError("This account is currently suspended. Please contact support.");
    }

    // 4. Verify Password (if password is provided or password hash is set)
    if (input.password || storedPasswordHash) {
      if (!input.password || !storedPasswordHash) {
        this.rateLimiter.recordFailure(rateLimitKey);
        throw new AuthorizationError("Invalid email or password.");
      }

      const isValid = await verifyPassword(input.password, storedPasswordHash);
      if (!isValid) {
        this.rateLimiter.recordFailure(rateLimitKey);
        throw new AuthorizationError("Invalid email or password.");
      }
    }

    // 5. Authentication Succeeded -> Reset Rate Limiter
    this.rateLimiter.recordSuccess(rateLimitKey);

    // 6. Issue Session & HttpOnly Cookie
    const { rawToken, session } = this.sessionManager.createSession(user.id, user.email, {
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
    if (context.store) {
      tenants = context.store.listUserTenants(user.id);
    } else if (context.db) {
      const { listUserTenantsFromDb } = await import("../repositories/postgres-tenant-store");
      tenants = await listUserTenantsFromDb(context.db, user.id);
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
   * Log out and invalidate the session.
   */
  public logout(
    sessionToken: string,
    isSecure = false,
  ): { success: boolean; clearCookieHeader: string; setCookieHeader: string } {
    if (sessionToken) {
      this.sessionManager.destroySession(sessionToken);
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
  public rotateSession(
    oldToken: string,
    isSecure = false,
  ): { sessionToken: string; setCookieHeader: string; session: UserSession } | null {
    const rotated = this.sessionManager.rotateSession(oldToken);
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
   * 1. Resolves caller's user identity from session
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
    const session = this.sessionManager.validateSession(sessionToken);
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

    const { rawToken } = this.passwordResetService.createResetToken(userId, cleanEmail);
    return { success: true, resetToken: rawToken };
  }

  /**
   * Confirms password reset with reset token.
   */
  public async confirmPasswordReset(
    rawToken: string,
    newPassword: string,
    context: { db?: AureliaAwsDb; store?: MultiTenantDataStore },
  ): Promise<{ success: boolean; userId: string }> {
    const result = await this.passwordResetService.executePasswordReset(rawToken, newPassword);

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
      this.sessionManager.destroyAllUserSessions(userId);
    }
  }
}

export const defaultAuthService = new AuthService();
