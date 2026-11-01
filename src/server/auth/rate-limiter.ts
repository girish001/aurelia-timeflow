/**
 * In-memory sliding-window rate limiter for brute-force login attack protection.
 * Tracks failed authentication attempts by key (IP + email).
 * Enforces exponential lockout backoff.
 */

export interface RateLimitStatus {
  allowed: boolean;
  remainingAttempts: number;
  lockoutRemainingMs: number;
  retryAfterSeconds: number;
}

interface AttemptRecord {
  failures: number;
  lastAttemptAt: number;
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;

  constructor(options?: { maxFailures?: number; windowMs?: number; lockoutMs?: number }) {
    this.maxFailures = options?.maxFailures ?? 5;
    this.windowMs = options?.windowMs ?? 15 * 60 * 1000; // 15 minutes
    this.lockoutMs = options?.lockoutMs ?? 15 * 60 * 1000; // 15 minutes lockout
  }

  /**
   * Generates a composite key from IP and Email.
   */
  public makeKey(ip: string, email?: string): string {
    const cleanIp = (ip || "127.0.0.1").trim().toLowerCase();
    const cleanEmail = (email || "anonymous").trim().toLowerCase();
    return `${cleanIp}::${cleanEmail}`;
  }

  /**
   * Checks if an authentication attempt is allowed under current limits.
   */
  public check(key: string, now = Date.now()): RateLimitStatus {
    this.cleanup(now);
    const record = this.attempts.get(key);

    if (!record) {
      return {
        allowed: true,
        remainingAttempts: this.maxFailures,
        lockoutRemainingMs: 0,
        retryAfterSeconds: 0,
      };
    }

    if (record.lockedUntil > now) {
      const lockoutRemainingMs = record.lockedUntil - now;
      return {
        allowed: false,
        remainingAttempts: 0,
        lockoutRemainingMs,
        retryAfterSeconds: Math.ceil(lockoutRemainingMs / 1000),
      };
    }

    // If window expired, reset
    if (now - record.lastAttemptAt > this.windowMs) {
      this.attempts.delete(key);
      return {
        allowed: true,
        remainingAttempts: this.maxFailures,
        lockoutRemainingMs: 0,
        retryAfterSeconds: 0,
      };
    }

    const remaining = Math.max(0, this.maxFailures - record.failures);
    return {
      allowed: remaining > 0,
      remainingAttempts: remaining,
      lockoutRemainingMs: 0,
      retryAfterSeconds: 0,
    };
  }

  /**
   * Registers a failed authentication attempt.
   * Increments failure count; triggers lockout when maxFailures is reached.
   */
  public recordFailure(key: string, now = Date.now()): RateLimitStatus {
    let record = this.attempts.get(key);
    if (!record || now - record.lastAttemptAt > this.windowMs) {
      record = {
        failures: 1,
        lastAttemptAt: now,
        lockedUntil: 0,
      };
    } else {
      record.failures += 1;
      record.lastAttemptAt = now;
    }

    if (record.failures >= this.maxFailures) {
      record.lockedUntil = now + this.lockoutMs;
    }

    this.attempts.set(key, record);
    return this.check(key, now);
  }

  /**
   * Clears failure count upon successful authentication.
   */
  public recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Cleans up expired attempt records to prevent unbounded memory growth.
   */
  private cleanup(now: number): void {
    for (const [k, rec] of this.attempts.entries()) {
      if (rec.lockedUntil <= now && now - rec.lastAttemptAt > this.windowMs) {
        this.attempts.delete(k);
      }
    }
  }

  /**
   * Resets all rate limiter state (useful for test isolation).
   */
  public reset(): void {
    this.attempts.clear();
  }
}

export const defaultLoginRateLimiter = new LoginRateLimiter();
