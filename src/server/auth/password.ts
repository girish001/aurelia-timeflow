import crypto from "node:crypto";

/**
 * Production-grade password hashing engine using scrypt (RFC 7914 / OWASP recommended).
 * Format: scrypt$cost$blockSize$parallelization$saltHex$derivedKeyHex
 * Enforces 32-byte cryptographically secure random salts and constant-time equality.
 */

const DEFAULT_COST = 16384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;
const DEFAULT_KEY_LEN = 64;
const SALT_BYTES = 32;

export interface HashPasswordOptions {
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  keyLength?: number;
}

/**
 * Validates password complexity policy:
 * - At least 8 characters
 * - At least one uppercase or lowercase letter
 * - At least one number or special symbol
 */
export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  if (!password || typeof password !== "string") {
    return { valid: false, reason: "Password is required." };
  }
  if (password.length < 8) {
    return { valid: false, reason: "Password must be at least 8 characters long." };
  }
  if (password.length > 128) {
    return { valid: false, reason: "Password must not exceed 128 characters." };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one lowercase letter." };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one uppercase letter." };
  }
  if (!/\d/.test(password)) {
    return { valid: false, reason: "Password must contain at least one number." };
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one special character." };
  }
  return { valid: true };
}

export const validatePasswordComplexity = validatePasswordStrength;

/**
 * Hashes a plaintext password asynchronously into a standardized cryptographic format.
 */
export async function hashPassword(
  password: string,
  options?: HashPasswordOptions,
): Promise<string> {
  const validation = validatePasswordStrength(password);
  if (!validation.valid) {
    throw new Error(validation.reason ?? "Invalid password.");
  }

  const cost = options?.cost ?? DEFAULT_COST;
  const blockSize = options?.blockSize ?? DEFAULT_BLOCK_SIZE;
  const parallelization = options?.parallelization ?? DEFAULT_PARALLELIZATION;
  const keyLength = options?.keyLength ?? DEFAULT_KEY_LEN;

  const salt = crypto.randomBytes(SALT_BYTES);

  return new Promise<string>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keyLength,
      { cost, blockSize, parallelization },
      (err, derivedKey) => {
        if (err) return reject(err);
        const saltHex = salt.toString("hex");
        const keyHex = derivedKey.toString("hex");
        resolve(`scrypt$${cost}$${blockSize}$${parallelization}$${saltHex}$${keyHex}`);
      },
    );
  });
}

/**
 * Verifies a plaintext password against a stored hash using constant-time comparison.
 * Returns false on format mismatch, invalid salt, or bad password without throwing or leaking timing.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash || typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const saltHex = parts[4] ?? "";
  const keyHex = parts[5] ?? "";

  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelization) ||
    !saltHex ||
    !keyHex
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expectedKey = Buffer.from(keyHex, "hex");

  return new Promise<boolean>((resolve) => {
    crypto.scrypt(
      password,
      salt,
      expectedKey.length,
      { cost, blockSize, parallelization },
      (err, derivedKey) => {
        if (err) return resolve(false);
        if (derivedKey.length !== expectedKey.length) return resolve(false);
        try {
          const match = crypto.timingSafeEqual(derivedKey, expectedKey);
          resolve(match);
        } catch {
          resolve(false);
        }
      },
    );
  });
}
