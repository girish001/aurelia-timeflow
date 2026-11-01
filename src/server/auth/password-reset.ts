import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { AureliaAwsDb } from "../db/aws-postgres";
import { hashPassword, validatePasswordStrength } from "./password";
import {
  defaultSessionManager,
  ensureSessionTableInDb,
  SessionManager,
  withDbTransactionLock,
} from "./session-manager";

export const DEFAULT_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PasswordResetRecord {
  tokenHash: string;
  userId: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number | undefined;
}

const initializedResetDbs = new WeakSet<object>();

export async function ensurePasswordResetTableInDb(db: AureliaAwsDb): Promise<void> {
  if (initializedResetDbs.has(db)) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash VARCHAR(64) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id)
  `);
  initializedResetDbs.add(db);
}

export class PasswordResetService {
  private readonly resetTokens = new Map<string, PasswordResetRecord>(); // tokenHash -> record
  private readonly tokenTtlMs: number;
  private readonly sessionManager: SessionManager;

  constructor(options?: { tokenTtlMs?: number; sessionManager?: SessionManager }) {
    this.tokenTtlMs = options?.tokenTtlMs ?? DEFAULT_RESET_TOKEN_TTL_MS;
    this.sessionManager = options?.sessionManager ?? defaultSessionManager;
  }

  public hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  /**
   * Initiates a password reset request for a user.
   * Generates a single-use cryptographically secure reset token and stores only its SHA-256 hash.
   */
  public createResetToken(
    userId: string,
    email: string,
    now = Date.now(),
  ): { rawToken: string; expiresAt: number; tokenHash: string } {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = now + this.tokenTtlMs;

    this.resetTokens.set(tokenHash, {
      tokenHash,
      userId,
      email: email.toLowerCase().trim(),
      createdAt: now,
      expiresAt,
    });

    return { rawToken, expiresAt, tokenHash };
  }

  /**
   * Initiates a password reset request and persists the SHA-256 token hash in PostgreSQL.
   */
  public async createResetTokenInDb(
    userId: string,
    email: string,
    options?: { db?: AureliaAwsDb; now?: number },
  ): Promise<{ rawToken: string; expiresAt: number; tokenHash: string }> {
    const now = options?.now ?? Date.now();
    const created = this.createResetToken(userId, email, now);
    if (options?.db) {
      await ensurePasswordResetTableInDb(options.db);
      const createdAtIso = new Date(now).toISOString();
      const expiresAtIso = new Date(created.expiresAt).toISOString();
      await options.db.execute(sql`
        INSERT INTO password_reset_tokens (
          token_hash, user_id, email, created_at, expires_at, used_at
        ) VALUES (
          ${created.tokenHash},
          ${userId}::uuid,
          ${email.toLowerCase().trim()},
          ${createdAtIso}::timestamptz,
          ${expiresAtIso}::timestamptz,
          NULL
        )
      `);
    }
    return created;
  }

  /**
   * Validates a password reset token without consuming it.
   */
  public validateToken(rawToken: string, now = Date.now()): PasswordResetRecord | null {
    if (!rawToken || typeof rawToken !== "string") return null;
    const tokenHash = this.hashToken(rawToken);
    const record = this.resetTokens.get(tokenHash);

    if (!record) return null;
    if (record.usedAt !== undefined) return null; // Already consumed
    if (record.expiresAt <= now) {
      this.resetTokens.delete(tokenHash);
      return null;
    }

    return record;
  }

  /**
   * Completes a password reset.
   *
   * Security Invariants:
   * - Enforces single-use and expiration atomically under concurrent requests.
   * - In PostgreSQL mode, executes token consumption, user password hash update,
   *   and active session revocation inside a single database transaction.
   * - In in-memory mode, claims the single-use token synchronously before async scrypt hashing
   *   so concurrent in-memory callers cannot consume the same token twice.
   */
  public async executePasswordReset(
    rawToken: string,
    newPassword: string,
    options?: { db?: AureliaAwsDb | undefined; now?: number | undefined },
  ): Promise<{ userId: string; newPasswordHash: string; updatedInDb: boolean }> {
    const now = options?.now ?? Date.now();
    const validation = validatePasswordStrength(newPassword);
    if (!validation.valid) {
      throw new Error(validation.reason ?? "Password does not meet complexity requirements.");
    }

    if (!rawToken || typeof rawToken !== "string") {
      throw new Error("Invalid or expired password reset token.");
    }

    const tokenHash = this.hashToken(rawToken.trim());

    if (options?.db) {
      const db = options.db;
      await ensurePasswordResetTableInDb(db);
      await ensureSessionTableInDb(db);

      const newPasswordHash = await hashPassword(newPassword);
      const nowIso = new Date(now).toISOString();

      return withDbTransactionLock(db, async () => {
        await db.execute(sql`BEGIN`);
        try {
          // 1. Atomically consume single-use token ONLY if unused and unexpired
          const consumeRes = await db.execute(sql`
            UPDATE password_reset_tokens
            SET used_at = ${nowIso}::timestamptz
            WHERE token_hash = ${tokenHash}
              AND used_at IS NULL
              AND expires_at > ${nowIso}::timestamptz
            RETURNING user_id, email
          `);
          const rows =
            (consumeRes as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
          const consumedRow = rows[0];
          if (!consumedRow) {
            await db.execute(sql`ROLLBACK`);
            throw new Error("Invalid or expired password reset token.");
          }

          const userId = String(consumedRow["user_id"]);
          const tokenEmail = String(consumedRow["email"]);

          // 2. Update user's password hash inside the same transaction
          const updateUserRes = await db.execute(sql`
            UPDATE users
            SET password_hash = ${newPasswordHash},
                updated_at = ${nowIso}::timestamptz
            WHERE id = ${userId}::uuid
              AND LOWER(email) = LOWER(${tokenEmail})
            RETURNING id
          `);
          const updatedUsers =
            (updateUserRes as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
          if (updatedUsers.length === 0) {
            await db.execute(sql`ROLLBACK`);
            throw new Error("Password reset failed: target user account does not match token.");
          }

          // 3. Revoke all active sessions for the user inside the same transaction
          await db.execute(sql`
            UPDATE user_sessions
            SET revoked_at = ${nowIso}::timestamptz
            WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
          `);

          await db.execute(sql`COMMIT`);

          // Synchronize in-memory cache
          const memRecord = this.resetTokens.get(tokenHash);
          if (memRecord) {
            memRecord.usedAt = now;
          }
          this.sessionManager.destroyAllUserSessions(userId);

          return { userId, newPasswordHash, updatedInDb: true };
        } catch (err) {
          try {
            await db.execute(sql`ROLLBACK`);
          } catch {
            // Ignore rollback error
          }
          throw err;
        }
      });
    }

    // In-memory mode: claim single-use token synchronously BEFORE async scrypt hashing
    // so concurrent Promise.all requests cannot both pass validateToken()
    const record = this.validateToken(rawToken.trim(), now);
    if (!record) {
      throw new Error("Invalid or expired password reset token.");
    }
    record.usedAt = now;
    this.resetTokens.set(record.tokenHash, record);

    try {
      const newPasswordHash = await hashPassword(newPassword);
      // Security invariant: Invalidate all existing sessions on password change
      this.sessionManager.destroyAllUserSessions(record.userId);
      return {
        userId: record.userId,
        newPasswordHash,
        updatedInDb: false,
      };
    } catch (err) {
      record.usedAt = undefined;
      this.resetTokens.set(record.tokenHash, record);
      throw err;
    }
  }

  /**
   * Resets all in-memory reset tokens (for test suite isolation).
   */
  public reset(): void {
    this.resetTokens.clear();
  }
}

export const defaultPasswordResetService = new PasswordResetService();
