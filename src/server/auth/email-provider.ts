/**
 * Secure Email Delivery Provider Interface
 *
 * Security Invariants:
 * - Password reset tokens and email verification tokens MUST be delivered out-of-band
 *   via a verified email transport (e.g. AWS SES in ap-south-1) and NEVER returned
 *   in HTTP API responses.
 * - Sensitive tokens are never written to application stdout/stderr logs.
 */

export interface PasswordResetEmailPayload {
  to: string;
  resetToken: string;
  expiresAt: number;
  resetUrl?: string;
}

export interface EmailVerificationPayload {
  to: string;
  companyName: string;
  tenantId: string;
  verificationToken: string;
  expiresAt: number;
  verificationUrl?: string;
}

export interface DispatchedEmailRecord {
  id: string;
  type: "password_reset" | "email_verification";
  to: string;
  token: string;
  expiresAt: number;
  dispatchedAt: string;
  metadata?: Record<string, string>;
}

export interface EmailDeliveryProvider {
  sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<{ messageId: string }>;
  sendEmailVerificationEmail(payload: EmailVerificationPayload): Promise<{ messageId: string }>;
}

/**
 * Default Transactional Email Provider with in-memory outbox for out-of-band verification
 * in automated tests and pluggable transport hook for AWS SES in production.
 */
export class TransactionalEmailService implements EmailDeliveryProvider {
  private readonly outbox: DispatchedEmailRecord[] = [];
  private transportHook?: (record: DispatchedEmailRecord) => Promise<void>;

  public setTransportHook(hook: (record: DispatchedEmailRecord) => Promise<void>): void {
    this.transportHook = hook;
  }

  public async sendPasswordResetEmail(
    payload: PasswordResetEmailPayload,
  ): Promise<{ messageId: string }> {
    const record: DispatchedEmailRecord = {
      id: `msg_rst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "password_reset",
      to: payload.to.toLowerCase().trim(),
      token: payload.resetToken,
      expiresAt: payload.expiresAt,
      dispatchedAt: new Date().toISOString(),
    };
    this.outbox.push(record);
    if (this.transportHook) {
      await this.transportHook(record);
    }
    return { messageId: record.id };
  }

  public async sendEmailVerificationEmail(
    payload: EmailVerificationPayload,
  ): Promise<{ messageId: string }> {
    const record: DispatchedEmailRecord = {
      id: `msg_ver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "email_verification",
      to: payload.to.toLowerCase().trim(),
      token: payload.verificationToken,
      expiresAt: payload.expiresAt,
      dispatchedAt: new Date().toISOString(),
      metadata: {
        companyName: payload.companyName,
        tenantId: payload.tenantId,
      },
    };
    this.outbox.push(record);
    if (this.transportHook) {
      await this.transportHook(record);
    }
    return { messageId: record.id };
  }

  public getOutbox(): ReadonlyArray<DispatchedEmailRecord> {
    return this.outbox;
  }

  public getLatestEmailFor(
    recipientEmail: string,
    type?: "password_reset" | "email_verification",
  ): DispatchedEmailRecord | undefined {
    const clean = recipientEmail.toLowerCase().trim();
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const item = this.outbox[i];
      if (item && item.to === clean && (!type || item.type === type)) {
        return item;
      }
    }
    return undefined;
  }

  public clearOutbox(): void {
    this.outbox.length = 0;
  }
}

export const defaultEmailDeliveryProvider = new TransactionalEmailService();
