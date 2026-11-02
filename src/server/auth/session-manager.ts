import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { AureliaAwsDb } from "../db/aws-postgres";

/**
 * Production Session Management Engine (PostgreSQL-Persisted + In-Memory Cache)
 * - Generates 256-bit cryptographically secure session tokens
 * - Stores ONLY SHA-256 token hashes (`token_hash`) — never raw tokens
 * - Persists sessions in PostgreSQL (`user_sessions` table) so sessions survive
 *   backend restarts and work across multiple concurrent backend instances
 * - Tracks user identity, IP, user-agent, creation time, last active time, expiration, and revocation
 * - Supports atomic token rotation (issuing new token and revoking previous token)
 * - Formats and parses HttpOnly, Secure, SameSite cookies
 * - Enforces session invalidation upon logout, password reset, and account deactivation
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
  revokedAt?: number | undefined;
}

export interface SessionCookieOptions {
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  maxAgeSeconds?: number;
}

export interface RotateSessionOptions {
  now?: number;
  secure?: boolean;
}

const initializedDbs = new WeakSet<object>();
const dbTransactionLocks = new WeakMap<object, Promise<void>>();

export async function withDbTransactionLock<T>(
  db: AureliaAwsDb,
  operation: () => Promise<T>,
): Promise<T> {
  const prev = dbTransactionLocks.get(db) ?? Promise.resolve();
  let releaseLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  dbTransactionLocks.set(
    db,
    prev.then(
      () => current,
      () => current,
    ),
  );
  await prev;
  try {
    return await operation();
  } finally {
    releaseLock();
  }
}

export async function ensureSessionTableInDb(db: AureliaAwsDb): Promise<void> {
  if (initializedDbs.has(db)) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_id VARCHAR(128) PRIMARY KEY,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      ip_address VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id)
  `);
  initializedDbs.add(db);
}

function parseDbTimestampMs(val: unknown): number {
  if (val instanceof Date) return val.getTime();
  if (typeof val === "number") return val;
  if (
    typeof val === "object" &&
    val !== null &&
    "getTime" in val &&
    typeof (val as { getTime: unknown }).getTime === "function"
  ) {
    return (val as { getTime: () => number }).getTime();
  }
  return new Date(String(val)).getTime();
}

export class SessionManager {
  private readonly sessions = new Map<string, UserSession>(); // tokenHash -> UserSession
  private readonly userSessions = new Map<string, Set<string>>(); // userId -> Set<tokenHash>
  private readonly sessionTtlMs: number;
  private readonly idleTimeoutMs: number;
  private readonly defaultDb?: AureliaAwsDb | undefined;

  constructor(options?: { sessionTtlMs?: number; idleTimeoutMs?: number; db?: AureliaAwsDb }) {
    this.sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.defaultDb = options?.db;
  }

  /**
   * Hashes a raw session token using SHA-256. Raw tokens are never stored.
   */
  public hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  /**
   * Generates a 256-bit cryptographically secure session token.
   */
  public generateRawToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  private indexSessionInMemory(session: UserSession): void {
    this.sessions.set(session.tokenHash, session);
    let userSet = this.userSessions.get(session.userId);
    if (!userSet) {
      userSet = new Set<string>();
      this.userSessions.set(session.userId, userSet);
    }
    userSet.add(session.tokenHash);
  }

  /**
   * Creates a new session for an authenticated user in memory.
   */
  public createSession(
    userId: string,
    email: string,
    metadata?: {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
      now?: number | undefined;
    },
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

    this.indexSessionInMemory(session);
    return { rawToken, session };
  }

  /**
   * Creates a new session and persists its SHA-256 token hash in PostgreSQL (`user_sessions`).
   */
  public async createSessionInDb(
    userId: string,
    email: string,
    metadata?: {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
      now?: number | undefined;
      db?: AureliaAwsDb | undefined;
    },
  ): Promise<{ rawToken: string; session: UserSession }> {
    const { rawToken, session } = this.createSession(userId, email, metadata);
    const db = metadata?.db ?? this.defaultDb;
    if (db) {
      await ensureSessionTableInDb(db);
      const createdAtIso = new Date(session.createdAt).toISOString();
      const lastActiveAtIso = new Date(session.lastActiveAt).toISOString();
      const expiresAtIso = new Date(session.expiresAt).toISOString();
      await db.execute(sql`
        INSERT INTO user_sessions (
          session_id, token_hash, user_id, email, ip_address, user_agent,
          created_at, last_active_at, expires_at, revoked_at
        ) VALUES (
          ${session.sessionId},
          ${session.tokenHash},
          ${session.userId}::uuid,
          ${session.email},
          ${session.ipAddress ?? null},
          ${session.userAgent ?? null},
          ${createdAtIso}::timestamptz,
          ${lastActiveAtIso}::timestamptz,
          ${expiresAtIso}::timestamptz,
          NULL
        )
      `);
    }
    return { rawToken, session };
  }

  /**
   * Validates a raw session token against in-memory storage.
   * Checks absolute expiration and idle timeout, updates lastActiveAt on success.
   */
  public validateSession(rawToken: string, now = Date.now()): UserSession | null {
    if (!rawToken || typeof rawToken !== "string") return null;
    const tokenHash = this.hashToken(rawToken);
    const session = this.sessions.get(tokenHash);

    if (!session) return null;
    if (session.revokedAt !== undefined) {
      this.destroySession(rawToken);
      return null;
    }

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
   * Validates a raw session token using PostgreSQL persistence (`user_sessions`).
   * Survives backend restarts and works across concurrent backend instances.
   */
  public async validateSessionInDb(
    rawToken: string,
    options?: { db?: AureliaAwsDb; now?: number },
  ): Promise<UserSession | null> {
    if (!rawToken || typeof rawToken !== "string") return null;
    const now = options?.now ?? Date.now();
    const db = options?.db ?? this.defaultDb;

    if (!db) {
      return this.validateSession(rawToken, now);
    }

    await ensureSessionTableInDb(db);
    const tokenHash = this.hashToken(rawToken);
    const res = await db.execute(sql`
      SELECT
        session_id,
        token_hash,
        user_id,
        email,
        ip_address,
        user_agent,
        created_at,
        last_active_at,
        expires_at,
        revoked_at
      FROM user_sessions
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `);

    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const row = rows[0];
    if (!row) {
      // Remove stale in-memory entry if revoked on another instance
      this.sessions.delete(tokenHash);
      return null;
    }

    if (row["revoked_at"] !== null && row["revoked_at"] !== undefined) {
      this.sessions.delete(tokenHash);
      return null;
    }

    const createdAt = parseDbTimestampMs(row["created_at"]);
    const lastActiveAt = parseDbTimestampMs(row["last_active_at"]);
    const expiresAt = parseDbTimestampMs(row["expires_at"]);

    if (expiresAt <= now || now - lastActiveAt > this.idleTimeoutMs) {
      await this.destroySessionInDb(rawToken, { db, now });
      return null;
    }

    const nowIso = new Date(now).toISOString();
    await db.execute(sql`
      UPDATE user_sessions
      SET last_active_at = ${nowIso}::timestamptz
      WHERE token_hash = ${tokenHash}
    `);

    const session: UserSession = {
      sessionId: String(row["session_id"]),
      tokenHash: String(row["token_hash"]),
      userId: String(row["user_id"]),
      email: String(row["email"]),
      ipAddress: row["ip_address"] ? String(row["ip_address"]) : undefined,
      userAgent: row["user_agent"] ? String(row["user_agent"]) : undefined,
      createdAt,
      lastActiveAt: now,
      expiresAt,
    };

    this.indexSessionInMemory(session);
    return session;
  }

  /**
   * Rotates a session token (token rotation).
   * Generates a new raw token, transfers session metadata, and invalidates the old token.
   */
  public rotateSession(
    oldRawToken: string,
    nowOrOptions?: number | RotateSessionOptions,
  ): { newRawToken: string; session: UserSession } | null {
    const now = typeof nowOrOptions === "number" ? nowOrOptions : (nowOrOptions?.now ?? Date.now());
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

    this.indexSessionInMemory(updatedSession);
    return { newRawToken, session: updatedSession };
  }

  /**
   * Rotates a session token in PostgreSQL (`user_sessions`) inside a single atomic
   * PostgreSQL transaction.
   *
   * Security Invariants:
   * - Executes inside a single transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`).
   * - Uses a data-modifying CTE (`WITH revoked_session AS (UPDATE ... WHERE token_hash = $old AND revoked_at IS NULL ...) INSERT INTO user_sessions ... SELECT ... FROM revoked_session`)
   *   so revoking the old token and inserting the new token happen atomically.
   * - Concurrent requests attempting to rotate the same old token cannot both succeed:
   *   at most one caller matches `revoked_at IS NULL`, and all others receive `null`.
   * - Preserves original session metadata (`user_id`, `email`, `ip_address`, `user_agent`, `created_at`)
   *   and enforces absolute and idle expiration rules.
   */
  public async rotateSessionInDb(
    oldRawToken: string,
    options?: { db?: AureliaAwsDb; now?: number },
  ): Promise<{ newRawToken: string; session: UserSession } | null> {
    if (!oldRawToken || typeof oldRawToken !== "string") return null;
    const now = options?.now ?? Date.now();
    const db = options?.db ?? this.defaultDb;
    if (!db) {
      return this.rotateSession(oldRawToken, now);
    }

    await ensureSessionTableInDb(db);

    const oldTokenHash = this.hashToken(oldRawToken);
    const newRawToken = this.generateRawToken();
    const newTokenHash = this.hashToken(newRawToken);
    const newSessionId = `sess_${crypto.randomUUID()}`;
    const nowIso = new Date(now).toISOString();
    const idleCutoffIso = new Date(now - this.idleTimeoutMs).toISOString();
    const newExpiresAt = now + this.sessionTtlMs;
    const newExpiresAtIso = new Date(newExpiresAt).toISOString();

    return db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        WITH revoked_session AS (
          UPDATE user_sessions
          SET revoked_at = ${nowIso}::timestamptz
          WHERE token_hash = ${oldTokenHash}
            AND revoked_at IS NULL
            AND expires_at > ${nowIso}::timestamptz
            AND last_active_at >= ${idleCutoffIso}::timestamptz
          RETURNING
            session_id,
            user_id,
            email,
            ip_address,
            user_agent,
            created_at
        )
        INSERT INTO user_sessions (
          session_id,
          token_hash,
          user_id,
          email,
          ip_address,
          user_agent,
          created_at,
          last_active_at,
          expires_at,
          revoked_at
        )
        SELECT
          ${newSessionId},
          ${newTokenHash},
          user_id,
          email,
          ip_address,
          user_agent,
          created_at,
          ${nowIso}::timestamptz,
          ${newExpiresAtIso}::timestamptz,
          NULL
        FROM revoked_session
        RETURNING
          session_id,
          token_hash,
          user_id,
          email,
          ip_address,
          user_agent,
          created_at,
          last_active_at,
          expires_at
      `);

      const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const inserted = rows[0];

      if (!inserted) {
        // Ensure any expired/idle session with this token hash is marked revoked
        await tx.execute(sql`
          UPDATE user_sessions
          SET revoked_at = ${nowIso}::timestamptz
          WHERE token_hash = ${oldTokenHash} AND revoked_at IS NULL
        `);
        this.destroySession(oldRawToken);
        return null;
      }

      this.destroySession(oldRawToken);

      const updatedSession: UserSession = {
        sessionId: String(inserted["session_id"]),
        tokenHash: String(inserted["token_hash"]),
        userId: String(inserted["user_id"]),
        email: String(inserted["email"]),
        ipAddress: inserted["ip_address"] ? String(inserted["ip_address"]) : undefined,
        userAgent: inserted["user_agent"] ? String(inserted["user_agent"]) : undefined,
        createdAt: parseDbTimestampMs(inserted["created_at"]),
        lastActiveAt: now,
        expiresAt: newExpiresAt,
      };

      this.indexSessionInMemory(updatedSession);
      return { newRawToken, session: updatedSession };
    });
  }

  /**
   * Destroys a single session by raw token in memory.
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
   * Revokes a single session by raw token in PostgreSQL (`user_sessions`) and in memory.
   */
  public async destroySessionInDb(
    rawToken: string,
    options?: { db?: AureliaAwsDb; now?: number },
  ): Promise<boolean> {
    if (!rawToken) return false;
    const inMem = this.destroySession(rawToken);
    const db = options?.db ?? this.defaultDb;
    if (!db) return inMem;

    await ensureSessionTableInDb(db);
    const tokenHash = this.hashToken(rawToken);
    const revokedAtIso = new Date(options?.now ?? Date.now()).toISOString();
    await db.execute(sql`
      UPDATE user_sessions
      SET revoked_at = ${revokedAtIso}::timestamptz
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `);
    return true;
  }

  /**
   * Invalidates all active sessions for a user in memory.
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

  /**
   * Invalidates all active sessions for a user in PostgreSQL (`user_sessions`) and in memory.
   */
  public async destroyAllUserSessionsInDb(
    userId: string,
    options?: { db?: AureliaAwsDb; now?: number },
  ): Promise<number> {
    const memCount = this.destroyAllUserSessions(userId);
    const db = options?.db ?? this.defaultDb;
    if (!db) return memCount;

    await ensureSessionTableInDb(db);
    const revokedAtIso = new Date(options?.now ?? Date.now()).toISOString();
    const res = await db.execute(sql`
      UPDATE user_sessions
      SET revoked_at = ${revokedAtIso}::timestamptz
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
      RETURNING session_id
    `);
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? [];
    return Math.max(memCount, rows.length);
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
   * Diagnostic/testing helper to age a PostgreSQL-persisted session.
   */
  public async simulateSessionAgingInDb(
    rawToken: string,
    ageMs: number,
    options?: { db?: AureliaAwsDb; expireAbsolute?: boolean },
  ): Promise<void> {
    this.simulateSessionAging(rawToken, ageMs);
    const db = options?.db ?? this.defaultDb;
    if (!db) return;

    await ensureSessionTableInDb(db);
    const tokenHash = this.hashToken(rawToken);
    const pastIso = new Date(Date.now() - ageMs).toISOString();
    if (options?.expireAbsolute) {
      await db.execute(sql`
        UPDATE user_sessions
        SET expires_at = ${pastIso}::timestamptz, last_active_at = ${pastIso}::timestamptz
        WHERE token_hash = ${tokenHash}
      `);
    } else {
      await db.execute(sql`
        UPDATE user_sessions
        SET last_active_at = ${pastIso}::timestamptz
        WHERE token_hash = ${tokenHash}
      `);
    }
  }

  /**
   * Builds the Set-Cookie header for an authenticated session.
   */
  public buildSessionCookie(rawToken: string, options?: SessionCookieOptions): string {
    const secure =
      options?.secure ??
      (process.env["APP_ENV"] === "production" || process.env["NODE_ENV"] === "production");
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
    const secure =
      options?.secure ??
      (process.env["APP_ENV"] === "production" || process.env["NODE_ENV"] === "production");
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
   * Explicitly rejects legacy forged user:<id> bearer tokens.
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
      // Never accept legacy non-session format "user:*"
      if (token && !token.startsWith("user:")) {
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
