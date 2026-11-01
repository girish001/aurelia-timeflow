import crypto from "node:crypto";

/**
 * Production Session Management Engine
 * - Generates 256-bit cryptographically secure session tokens
 * - Tracks user identity, IP, user-agent, creation time, last active time, and expiration
 * - Supports token rotation (issuing new token and revoking previous token)
 * - Formats and parses HttpOnly, Secure, SameSite cookies
 * - Enforces session invalidation upon logout and password changes
 */

export const SESSION_COOKIE_NAME = "aurelia_session";
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours idle timeout

export interface UserSession {
  sessionId: string;
  tokenHash: string; // SHA-256 of session token for safe lookup
  userId: string;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

export interface SessionCookieOptions {
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  maxAgeSeconds?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, UserSession>(); // tokenHash -> UserSession
  private readonly userSessions = new Map<string, Set<string>>(); // userId -> Set<tokenHash>
  private readonly sessionTtlMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options?: { sessionTtlMs?: number; idleTimeoutMs?: number }) {
    this.sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Hashes a raw session token using SHA-256 for secure in-memory indexing.
   */
  private hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  /**
   * Generates a 256-bit cryptographically secure session token.
   */
  public generateRawToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Creates a new session for an authenticated user and stores it.
   */
  public createSession(
    userId: string,
    email: string,
    metadata?: { ipAddress?: string; userAgent?: string; now?: number },
  ): { rawToken: string; session: UserSession } {
    const now = metadata?.now ?? Date.now();
    const rawToken = this.generateRawToken();
    const tokenHash = this.hashToken(rawToken);

    const session: UserSession = {
      sessionId: `sess_${crypto.randomUUID()}`,
      tokenHash,
      userId,
      email: email.toLowerCase().trim(),
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + this.sessionTtlMs,
    };

    this.sessions.set(tokenHash, session);

    let userSet = this.userSessions.get(userId);
    if (!userSet) {
      userSet = new Set<string>();
      this.userSessions.set(userId, userSet);
    }
    userSet.add(tokenHash);

    return { rawToken, session };
  }

  /**
   * Validates a raw session token.
   * Checks absolute expiration and idle timeout, updates lastActiveAt on success.
   */
  public validateSession(rawToken: string, now = Date.now()): UserSession | null {
    if (!rawToken || typeof rawToken !== "string") return null;
    const tokenHash = this.hashToken(rawToken);
    const session = this.sessions.get(tokenHash);

    if (!session) return null;

    // Check absolute expiration
    if (session.expiresAt <= now) {
      this.destroySession(rawToken);
      return null;
    }

    // Check idle timeout
    if (now - session.lastActiveAt > this.idleTimeoutMs) {
      this.destroySession(rawToken);
      return null;
    }

    // Update last activity
    session.lastActiveAt = now;
    return session;
  }

  /**
   * Rotates a session token (token rotation).
   * Generates a new raw token, transfers session metadata, and invalidates the old token.
   */
  public rotateSession(
    oldRawToken: string,
    now = Date.now(),
  ): { newRawToken: string; session: UserSession } | null {
    const existing = this.validateSession(oldRawToken, now);
    if (!existing) return null;

    // Remove old token
    this.destroySession(oldRawToken);

    // Issue new token with preserved creation time
    const newRawToken = this.generateRawToken();
    const newTokenHash = this.hashToken(newRawToken);

    const updatedSession: UserSession = {
      ...existing,
      tokenHash: newTokenHash,
      lastActiveAt: now,
      expiresAt: now + this.sessionTtlMs,
    };

    this.sessions.set(newTokenHash, updatedSession);

    let userSet = this.userSessions.get(updatedSession.userId);
    if (!userSet) {
      userSet = new Set<string>();
      this.userSessions.set(updatedSession.userId, userSet);
    }
    userSet.add(newTokenHash);

    return { newRawToken, session: updatedSession };
  }

  /**
   * Destroys a single session by raw token.
   */
  public destroySession(rawToken: string): boolean {
    if (!rawToken) return false;
    const tokenHash = this.hashToken(rawToken);
    const session = this.sessions.get(tokenHash);
    if (!session) return false;

    this.sessions.delete(tokenHash);
    const userSet = this.userSessions.get(session.userId);
    if (userSet) {
      userSet.delete(tokenHash);
      if (userSet.size === 0) {
        this.userSessions.delete(session.userId);
      }
    }
    return true;
  }

  /**
   * Invalidates all active sessions for a user (e.g. on password reset or account deactivation).
   */
  public destroyAllUserSessions(userId: string): number {
    const userSet = this.userSessions.get(userId);
    if (!userSet) return 0;

    let count = 0;
    for (const tokenHash of userSet) {
      this.sessions.delete(tokenHash);
      count++;
    }
    this.userSessions.delete(userId);
    return count;
  }

  public clear(): void {
    this.sessions.clear();
    this.userSessions.clear();
  }

  /**
   * Diagnostic/testing helper to simulate time passing for a session.
   */
  public simulateSessionAging(rawToken: string, ageMs: number): boolean {
    const tokenHash = this.hashToken(rawToken);
    const session = this.sessions.get(tokenHash);
    if (!session) return false;
    session.lastActiveAt = Date.now() - ageMs;
    return true;
  }

  /**
   * Builds the Set-Cookie header for an authenticated session.
   */
  public buildSessionCookie(rawToken: string, options?: SessionCookieOptions): string {
    const secure = options?.secure ?? process.env["NODE_ENV"] === "production";
    const sameSite = options?.sameSite ?? "Lax";
    const path = options?.path ?? "/";
    const maxAge = options?.maxAgeSeconds ?? Math.floor(this.sessionTtlMs / 1000);

    const parts = [
      `${SESSION_COOKIE_NAME}=${rawToken}`,
      `Path=${path}`,
      `Max-Age=${maxAge}`,
      `SameSite=${sameSite}`,
      "HttpOnly",
    ];

    if (secure) {
      parts.push("Secure");
    }

    return parts.join("; ");
  }

  /**
   * Builds the deletion Set-Cookie header to clear session cookies on logout.
   */
  public buildLogoutCookie(options?: { secure?: boolean; path?: string }): string {
    const secure = options?.secure ?? process.env["NODE_ENV"] === "production";
    const path = options?.path ?? "/";

    const parts = [
      `${SESSION_COOKIE_NAME}=`,
      `Path=${path}`,
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "SameSite=Lax",
      "HttpOnly",
    ];

    if (secure) {
      parts.push("Secure");
    }

    return parts.join("; ");
  }

  /**
   * Extracts a session token from HTTP Request headers (Cookie header or Authorization Bearer).
   */
  public extractTokenFromRequest(request: Request): string | null {
    // 1. Check Cookie header
    const cookieHeader = request.headers.get("cookie");
    if (cookieHeader) {
      const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`).exec(cookieHeader);
      if (match?.[1]) {
        return decodeURIComponent(match[1].trim());
      }
    }

    // 2. Check Authorization: Bearer <sessionToken>
    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice("bearer ".length).trim();
      // Ignore legacy non-session format "user:*"
      if (!token.startsWith("user:")) {
        return token;
      }
    }

    return null;
  }

  /**
   * Resets all in-memory sessions (for test suite isolation).
   */
  public reset(): void {
    this.sessions.clear();
    this.userSessions.clear();
  }
}

export const defaultSessionManager = new SessionManager();
