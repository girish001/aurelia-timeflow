import crypto from "node:crypto";
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

export class PasswordResetService {
  private readonly resetTokens = new Map<string, PasswordResetRecord>(); // tokenHash -> record
  private readonly tokenTtlMs: number;
  private readonly sessionManager: SessionManager;

  constructor(options?: { tokenTtlMs?: number; sessionManager?: SessionManager }) {
    this.tokenTtlMs = options?.tokenTtlMs ?? DEFAULT_RESET_TOKEN_TTL_MS;
    this.sessionManager = options?.sessionManager ?? defaultSessionManager;
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  /**
   * Initiates a password reset request for a user.
   * Generates a single-use cryptographically secure reset token.
   */
  public createResetToken(
    userId: string,
    email: string,
    now = Date.now(),
  ): { rawToken: string; expiresAt: number } {
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

    return { rawToken, expiresAt };
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
   * Consumes token, hashes new password, and revokes all active sessions for that user.
   */
  public async executePasswordReset(
    rawToken: string,
    newPassword: string,
    now = Date.now(),
  ): Promise<{ userId: string; newPasswordHash: string }> {
    const record = this.validateToken(rawToken, now);
    if (!record) {
      throw new Error("Invalid or expired password reset token.");
    }

    const validation = validatePasswordStrength(newPassword);
    if (!validation.valid) {
      throw new Error(validation.reason ?? "Password does not meet complexity requirements.");
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
