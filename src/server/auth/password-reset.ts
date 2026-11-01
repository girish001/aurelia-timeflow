import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { AureliaAwsDb } from "../db/aws-postgres";
import { hashPassword, validatePasswordStrength } from "./password";
import { defaultSessionManager, SessionManager } from "./session-manager";

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
   * Consumes token (single-use), hashes new password, and revokes all active sessions for that user.
   */
  public async executePasswordReset(
    rawToken: string,
    newPassword: string,
    options?: { db?: AureliaAwsDb; now?: number },
  ): Promise<{ userId: string; newPasswordHash: string }> {
    const now = options?.now ?? Date.now();
    const validation = validatePasswordStrength(newPassword);
    if (!validation.valid) {
      throw new Error(validation.reason ?? "Password does not meet complexity requirements.");
    }

    const tokenHash = this.hashToken(rawToken || "");

    if (options?.db) {
      await ensurePasswordResetTableInDb(options.db);
      const res = await options.db.execute(sql`
        SELECT token_hash, user_id, email, created_at, expires_at, used_at
        FROM password_reset_tokens
        WHERE token_hash = ${tokenHash}
        LIMIT 1
      `);
      const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const row = rows[0];
      if (!row) {
        throw new Error("Invalid or expired password reset token.");
      }
      if (row["used_at"] !== null && row["used_at"] !== undefined) {
        throw new Error("Invalid or expired password reset token.");
      }
      const expiresAt = new Date(String(row["expires_at"])).getTime();
      if (expiresAt <= now) {
        throw new Error("Invalid or expired password reset token.");
      }

      const nowIso = new Date(now).toISOString();
      await options.db.execute(sql`
        UPDATE password_reset_tokens
        SET used_at = ${nowIso}::timestamptz
        WHERE token_hash = ${tokenHash} AND used_at IS NULL
      `);

      const userId = String(row["user_id"]);
      const newPasswordHash = await hashPassword(newPassword);

      // Update in-memory record if present
      const memRecord = this.resetTokens.get(tokenHash);
      if (memRecord) {
        memRecord.usedAt = now;
      }

      // Security invariant: Invalidate all existing sessions on password change
      await this.sessionManager.destroyAllUserSessionsInDb(userId, { db: options.db, now });

      return { userId, newPasswordHash };
    }

    const record = this.validateToken(rawToken, now);
    if (!record) {
      throw new Error("Invalid or expired password reset token.");
    }

    const newPasswordHash = await hashPassword(newPassword);

    // Mark token as used
    record.usedAt = now;
    this.resetTokens.set(record.tokenHash, record);

    // Security invariant: Invalidate all existing sessions on password change
    this.sessionManager.destroyAllUserSessions(record.userId);

    return {
      userId: record.userId,
      newPasswordHash,
    };
  }

  /**
   * Resets all in-memory reset tokens (for test suite isolation).
   */
  public reset(): void {
    this.resetTokens.clear();
  }
}

export const defaultPasswordResetService = new PasswordResetService();
