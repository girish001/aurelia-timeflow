import crypto from "node:crypto";

/**
 * Secure Email Delivery Provider Interface & Production AWS SES v2 Implementation
 *
 * Security Invariants:
 * - Password reset tokens and email verification tokens MUST be delivered out-of-band
 *   via a verified email transport (AWS SES in ap-south-1) and NEVER returned
 *   in HTTP API responses.
 * - Sensitive tokens are NEVER written to application stdout/stderr logs or error messages.
 * - An email is NEVER reported as dispatched unless the provider confirms delivery acceptance
 *   with a non-empty MessageId.
 * - In production (`APP_ENV=production` or `NODE_ENV=production`), in-memory email fallback
 *   is disabled and a real configured AWS SES provider is required.
 */

export interface PasswordResetEmailPayload {
  to: string;
  resetToken: string;
  expiresAt: number;
  resetUrl?: string | undefined;
}

export interface EmailVerificationPayload {
  to: string;
  companyName: string;
  tenantId: string;
  verificationToken: string;
  expiresAt: number;
  verificationUrl?: string | undefined;
}

export interface EmailDeliveryResult {
  messageId: string;
  accepted: boolean;
  provider: "aws_ses" | "in_memory";
}

export interface DispatchedEmailRecord {
  id: string;
  type: "password_reset" | "email_verification";
  to: string;
  token: string;
  actionUrl: string;
  expiresAt: number;
  dispatchedAt: string;
  metadata?: Record<string, string> | undefined;
}

export interface EmailDeliveryProvider {
  sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<EmailDeliveryResult>;
  sendEmailVerificationEmail(payload: EmailVerificationPayload): Promise<EmailDeliveryResult>;
}

export class EmailDeliveryError extends Error {
  public readonly code = "EMAIL_DELIVERY_FAILED";
  public readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "EmailDeliveryError";
    this.statusCode = statusCode;
  }
}

/**
 * Redacts raw tokens and credentials from any log or error string.
 */
export function redactSensitiveEmailTokens(
  message: string,
  sensitiveValues: ReadonlyArray<string | undefined> = [],
): string {
  let sanitized = message;
  for (const val of sensitiveValues) {
    if (val && val.trim().length >= 8) {
      sanitized = sanitized.split(val).join("[REDACTED_TOKEN]");
    }
  }
  sanitized = sanitized.replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED_TOKEN_HEX]");
  sanitized = sanitized.replace(
    /(token|resetToken|verificationToken|secretAccessKey|password)=(?!\[REDACTED|\*{4})([^\s&"']+)/gi,
    "$1=[REDACTED]",
  );
  return sanitized;
}

export function isProductionEmailEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const appEnv = env["APP_ENV"]?.trim().toLowerCase();
  const nodeEnv = env["NODE_ENV"]?.trim().toLowerCase();

  if (env === process.env) {
    if (
      env["VITEST"] === "true" ||
      nodeEnv === "test" ||
      (nodeEnv === "development" && env["AWS_PRIVATE_VPC_EXECUTION"] !== "true")
    ) {
      return false;
    }
  }

  if (appEnv === "production") {
    return true;
  }
  if (appEnv && appEnv !== "production") {
    return false;
  }
  return nodeEnv === "production";
}

const VALID_EMAIL_REGEX = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isValidSenderEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed || trimmed.includes("<") || trimmed.includes(">")) {
    return false;
  }
  return VALID_EMAIL_REGEX.test(trimmed);
}

/**
 * Resolves and validates `APP_PUBLIC_URL`.
 * - In development/test: does not require a permanent custom domain. Allows any valid
 *   `http://` or `https://` development/preview URL (e.g. Cloud Run `.run.app` preview URL
 *   or `http://localhost:3000`). Defaults to `http://localhost:3000` when unset.
 * - In production: requires `APP_PUBLIC_URL` (or `appPublicUrl` in `AWS_SES_SECRET_JSON`)
 *   to be explicitly configured with a valid `https://` URL and non-localhost hostname.
 *   Never falls back to a hardcoded domain.
 */
export function resolveAppPublicUrl(
  env: Record<string, string | undefined> = process.env,
  options?: {
    secretJsonAppPublicUrl?: string | undefined;
    fallbackOrigin?: string | undefined;
  },
): string {
  const isProd = isProductionEmailEnvironment(env);
  const rawConfigured =
    options?.secretJsonAppPublicUrl?.trim() ||
    env["APP_PUBLIC_URL"]?.trim() ||
    (!isProd ? env["VITE_APP_URL"]?.trim() : "") ||
    "";

  if (!rawConfigured) {
    if (isProd) {
      throw new EmailDeliveryError(
        "Missing required APP_PUBLIC_URL environment variable for production email delivery.",
        500,
      );
    }
    return (options?.fallbackOrigin?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawConfigured);
  } catch {
    throw new EmailDeliveryError(
      `Invalid APP_PUBLIC_URL "${rawConfigured}": must be a valid HTTP/HTTPS URL.`,
      500,
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new EmailDeliveryError(
      `Invalid APP_PUBLIC_URL protocol "${parsedUrl.protocol}": must be http: or https:.`,
      500,
    );
  }

  if (isProd) {
    if (parsedUrl.protocol !== "https:") {
      throw new EmailDeliveryError("Production APP_PUBLIC_URL must use https://.", 500);
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      throw new EmailDeliveryError(
        "Production APP_PUBLIC_URL must not point to localhost or loopback addresses.",
        500,
      );
    }
  }

  return parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, "");
}

export interface AwsSesConfig {
  region: string;
  fromEmail: string;
  fromName: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  configurationSetName?: string | undefined;
  appPublicUrl: string;
  endpointUrl: string;
  credentialSource: "environment" | "aws_secrets_manager_json";
}

/**
 * Determines whether AWS SES delivery is explicitly disabled in non-production via
 * `AWS_SES_ENABLED=false` or `EMAIL_DELIVERY_MODE=development` / `development_outbox`.
 */
export function isEmailDeliveryDisabledInEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const sesEnabled = env["AWS_SES_ENABLED"]?.trim().toLowerCase();
  const deliveryMode = env["EMAIL_DELIVERY_MODE"]?.trim().toLowerCase();
  return (
    sesEnabled === "false" ||
    sesEnabled === "0" ||
    deliveryMode === "development" ||
    deliveryMode === "development_outbox" ||
    deliveryMode === "disabled" ||
    deliveryMode === "outbox"
  );
}

/**
 * Loads and validates AWS SES configuration from `AWS_SES_SECRET_JSON` (AWS Secrets Manager)
 * or environment variables (`AWS_SES_REGION` / `AWS_REGION`, `AWS_SES_FROM_EMAIL`,
 * `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `AWS_SES_SESSION_TOKEN`).
 *
 * Never uses fake email addresses, hardcoded domains, or hardcoded AWS credentials.
 * Refuses to initialize AWS SES when `AWS_SES_ENABLED=false` or `EMAIL_DELIVERY_MODE=development`.
 */
export function loadAwsSesConfig(
  env: Record<string, string | undefined> = process.env,
): AwsSesConfig {
  if (isEmailDeliveryDisabledInEnv(env)) {
    throw new EmailDeliveryError(
      "AWS SES email delivery is disabled (AWS_SES_ENABLED=false or EMAIL_DELIVERY_MODE=development). AWS SES must not be initialized when disabled.",
      500,
    );
  }

  const secretJson = env["AWS_SES_SECRET_JSON"]?.trim();
  if (secretJson) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(secretJson) as Record<string, unknown>;
    } catch {
      throw new EmailDeliveryError("Invalid AWS_SES_SECRET_JSON: must be valid JSON.", 500);
    }

    const region =
      (typeof parsed["region"] === "string" ? parsed["region"].trim() : "") ||
      env["AWS_SES_REGION"]?.trim() ||
      env["AWS_REGION"]?.trim() ||
      "ap-south-1";
    const fromEmail = typeof parsed["fromEmail"] === "string" ? parsed["fromEmail"].trim() : "";
    const fromName =
      (typeof parsed["fromName"] === "string" ? parsed["fromName"].trim() : "") ||
      env["AWS_SES_FROM_NAME"]?.trim() ||
      "Aurelia TimeFlow";
    const accessKeyId =
      typeof parsed["accessKeyId"] === "string" ? parsed["accessKeyId"].trim() : "";
    const secretAccessKey =
      typeof parsed["secretAccessKey"] === "string" ? parsed["secretAccessKey"].trim() : "";
    const sessionToken =
      typeof parsed["sessionToken"] === "string" && parsed["sessionToken"].trim()
        ? parsed["sessionToken"].trim()
        : undefined;
    const configurationSetName =
      typeof parsed["configurationSetName"] === "string" && parsed["configurationSetName"].trim()
        ? parsed["configurationSetName"].trim()
        : undefined;
    const secretJsonAppPublicUrl =
      typeof parsed["appPublicUrl"] === "string" ? parsed["appPublicUrl"].trim() : undefined;
    const appPublicUrl = resolveAppPublicUrl(env, { secretJsonAppPublicUrl });
    const endpointUrl = (
      (typeof parsed["endpointUrl"] === "string" ? parsed["endpointUrl"].trim() : "") ||
      env["AWS_SES_ENDPOINT"]?.trim() ||
      `https://email.${region}.amazonaws.com`
    ).replace(/\/+$/, "");

    if (!isValidSenderEmail(fromEmail)) {
      throw new EmailDeliveryError(
        "AWS_SES_SECRET_JSON is missing a valid 'fromEmail' sender address.",
        500,
      );
    }
    if (
      !accessKeyId ||
      !secretAccessKey ||
      accessKeyId.includes("<") ||
      secretAccessKey.includes("<")
    ) {
      throw new EmailDeliveryError(
        "AWS_SES_SECRET_JSON is missing required 'accessKeyId' or 'secretAccessKey'.",
        500,
      );
    }

    return {
      region,
      fromEmail,
      fromName,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      configurationSetName,
      appPublicUrl,
      endpointUrl,
      credentialSource: "aws_secrets_manager_json",
    };
  }

  const region = env["AWS_SES_REGION"]?.trim() || env["AWS_REGION"]?.trim() || "ap-south-1";
  const fromEmail = env["AWS_SES_FROM_EMAIL"]?.trim() || "";
  const fromName = env["AWS_SES_FROM_NAME"]?.trim() || "Aurelia TimeFlow";
  const accessKeyId =
    env["AWS_SES_ACCESS_KEY_ID"]?.trim() || env["AWS_ACCESS_KEY_ID"]?.trim() || "";
  const secretAccessKey =
    env["AWS_SES_SECRET_ACCESS_KEY"]?.trim() || env["AWS_SECRET_ACCESS_KEY"]?.trim() || "";
  const sessionToken =
    env["AWS_SES_SESSION_TOKEN"]?.trim() || env["AWS_SESSION_TOKEN"]?.trim() || undefined;
  const configurationSetName = env["AWS_SES_CONFIGURATION_SET"]?.trim() || undefined;
  const endpointUrl = (
    env["AWS_SES_ENDPOINT"]?.trim() || `https://email.${region}.amazonaws.com`
  ).replace(/\/+$/, "");

  if (!isValidSenderEmail(fromEmail)) {
    throw new EmailDeliveryError(
      "Missing or invalid AWS_SES_FROM_EMAIL environment variable for email delivery.",
      500,
    );
  }
  if (
    !accessKeyId ||
    !secretAccessKey ||
    accessKeyId.includes("<") ||
    secretAccessKey.includes("<")
  ) {
    throw new EmailDeliveryError(
      "Missing AWS SES credentials (AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY).",
      500,
    );
  }

  const appPublicUrl = resolveAppPublicUrl(env);

  return {
    region,
    fromEmail,
    fromName,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    configurationSetName,
    appPublicUrl,
    endpointUrl,
    credentialSource: "environment",
  };
}

export function isAwsSesConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (isEmailDeliveryDisabledInEnv(env)) {
    return false;
  }
  try {
    loadAwsSesConfig(env);
    return true;
  } catch {
    return false;
  }
}

export interface EmailEnvironmentValidationResult {
  valid: boolean;
  mode: "aws_ses" | "development_outbox";
  isProduction: boolean;
  appPublicUrl: string | null;
  fromEmail: string | null;
  errors: string[];
}

/**
 * Validates email delivery environment variables for the current runtime mode.
 * - In development/test: AWS SES, `APP_PUBLIC_URL`, and `AWS_SES_FROM_EMAIL` are optional.
 *   When `AWS_SES_ENABLED=false` or `EMAIL_DELIVERY_MODE=development`, SES is not initialized.
 * - In production: requires a verified `AWS_SES_FROM_EMAIL`, valid `https://` `APP_PUBLIC_URL`,
 *   and valid AWS SES credentials; fails closed if email delivery is disabled or unconfigured.
 */
export function validateEmailDeliveryEnvironment(
  env: Record<string, string | undefined> = process.env,
): EmailEnvironmentValidationResult {
  const isProd = isProductionEmailEnvironment(env);
  const errors: string[] = [];

  if (isProd) {
    if (isEmailDeliveryDisabledInEnv(env)) {
      errors.push(
        "Email delivery cannot be disabled (AWS_SES_ENABLED=false or EMAIL_DELIVERY_MODE=development) in production.",
      );
      return {
        valid: false,
        mode: "aws_ses",
        isProduction: true,
        appPublicUrl: null,
        fromEmail: null,
        errors,
      };
    }
    try {
      const cfg = loadAwsSesConfig(env);
      return {
        valid: errors.length === 0,
        mode: "aws_ses",
        isProduction: true,
        appPublicUrl: cfg.appPublicUrl,
        fromEmail: cfg.fromEmail,
        errors,
      };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "Invalid AWS SES configuration.");
      return {
        valid: false,
        mode: "aws_ses",
        isProduction: true,
        appPublicUrl: null,
        fromEmail: null,
        errors,
      };
    }
  }

  // Development / test mode
  let appPublicUrl: string | null = null;
  try {
    appPublicUrl = resolveAppPublicUrl(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "Invalid APP_PUBLIC_URL.");
  }

  if (isEmailDeliveryDisabledInEnv(env)) {
    return {
      valid: errors.length === 0,
      mode: "development_outbox",
      isProduction: false,
      appPublicUrl,
      fromEmail: null,
      errors,
    };
  }

  const sesExplicitlyForced =
    env["AWS_SES_ENABLED"]?.trim().toLowerCase() === "true" ||
    env["EMAIL_DELIVERY_MODE"]?.trim().toLowerCase() === "aws_ses";

  if (sesExplicitlyForced || isAwsSesConfigured(env)) {
    try {
      const cfg = loadAwsSesConfig(env);
      return {
        valid: errors.length === 0,
        mode: "aws_ses",
        isProduction: false,
        appPublicUrl: cfg.appPublicUrl,
        fromEmail: cfg.fromEmail,
        errors,
      };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "Invalid AWS SES configuration.");
      return {
        valid: false,
        mode: "aws_ses",
        isProduction: false,
        appPublicUrl,
        fromEmail: null,
        errors,
      };
    }
  }

  return {
    valid: errors.length === 0,
    mode: "development_outbox",
    isProduction: false,
    appPublicUrl,
    fromEmail: null,
    errors,
  };
}

export interface AwsSesSendEmailRequest {
  FromEmailAddress: string;
  Destination: {
    ToAddresses: string[];
  };
  Content: {
    Simple: {
      Subject: { Data: string; Charset: string };
      Body: {
        Text: { Data: string; Charset: string };
        Html: { Data: string; Charset: string };
      };
    };
  };
  ConfigurationSetName?: string | undefined;
}

export interface AwsSesClientLike {
  sendEmail(params: AwsSesSendEmailRequest): Promise<{ MessageId?: string | undefined }>;
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Signs an AWS SES v2 HTTP request using AWS Signature Version 4 (`AWS4-HMAC-SHA256`).
 */
export function signAwsSesV2Request(params: {
  method: string;
  url: URL;
  body: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  now?: Date | undefined;
}): Record<string, string> {
  const now = params.now ?? new Date();
  const isoBasic = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = isoBasic.slice(0, 8);
  const service = "ses";
  const host = params.url.host;
  const payloadHash = sha256Hex(params.body);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": isoBasic,
  };

  if (params.sessionToken) {
    headers["x-amz-security-token"] = params.sessionToken;
  }

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    params.method.toUpperCase(),
    params.url.pathname || "/",
    params.url.search ? params.url.search.slice(1) : "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${params.region}/${service}/aws4_request`;
  const stringToSign = [algorithm, isoBasic, credentialScope, sha256Hex(canonicalRequest)].join(
    "\n",
  );

  const kDate = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers["authorization"] =
    `${algorithm} Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

/**
 * Production AWS SES v2 Email Delivery Provider.
 * - Dispatches emails via AWS SES v2 (`POST /v2/outbound-emails`) or an injected SES client.
 * - Never logs raw password reset or email verification tokens.
 * - Fails safely when SES rejects or fails to confirm acceptance with a non-empty `MessageId`.
 */
export class AwsSesEmailProvider implements EmailDeliveryProvider {
  private readonly config: AwsSesConfig;
  private readonly fetchFn: typeof fetch;
  private readonly sesClient?: AwsSesClientLike | undefined;

  constructor(options: {
    config: AwsSesConfig;
    fetchFn?: typeof fetch | undefined;
    sesClient?: AwsSesClientLike | undefined;
  }) {
    this.config = options.config;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sesClient = options.sesClient;
  }

  private async dispatchSesEmail(
    requestBody: AwsSesSendEmailRequest,
    sensitiveToken: string,
  ): Promise<EmailDeliveryResult> {
    try {
      if (this.sesClient) {
        const res = await this.sesClient.sendEmail(requestBody);
        const messageId = typeof res?.MessageId === "string" ? res.MessageId.trim() : "";
        if (!messageId) {
          throw new EmailDeliveryError(
            "AWS SES did not confirm email delivery acceptance (missing MessageId).",
            502,
          );
        }
        return {
          messageId,
          accepted: true,
          provider: "aws_ses",
        };
      }

      if (typeof this.fetchFn !== "function") {
        throw new EmailDeliveryError("Fetch transport is unavailable for AWS SES delivery.", 502);
      }

      const targetUrl = new URL(`${this.config.endpointUrl}/v2/outbound-emails`);
      const serializedBody = JSON.stringify(requestBody);
      const headers = signAwsSesV2Request({
        method: "POST",
        url: targetUrl,
        body: serializedBody,
        region: this.config.region,
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        sessionToken: this.config.sessionToken,
      });

      const response = await this.fetchFn(targetUrl.toString(), {
        method: "POST",
        headers,
        body: serializedBody,
      });

      let parsedBody: Record<string, unknown> = {};
      try {
        const rawText = await response.text();
        if (rawText.trim()) {
          parsedBody = JSON.parse(rawText) as Record<string, unknown>;
        }
      } catch {
        // Non-JSON response body handled below
      }

      if (!response.ok) {
        const errorMsg =
          typeof parsedBody["message"] === "string"
            ? parsedBody["message"]
            : typeof parsedBody["Message"] === "string"
              ? parsedBody["Message"]
              : `HTTP ${response.status}`;
        throw new EmailDeliveryError(
          `AWS SES rejected email delivery: ${redactSensitiveEmailTokens(errorMsg, [sensitiveToken, this.config.secretAccessKey])}`,
          502,
        );
      }

      const messageId =
        typeof parsedBody["MessageId"] === "string" ? parsedBody["MessageId"].trim() : "";
      if (!messageId) {
        throw new EmailDeliveryError(
          "AWS SES response did not include a valid MessageId confirming delivery acceptance.",
          502,
        );
      }

      return {
        messageId,
        accepted: true,
        provider: "aws_ses",
      };
    } catch (err) {
      if (err instanceof EmailDeliveryError) {
        throw new EmailDeliveryError(
          redactSensitiveEmailTokens(err.message, [sensitiveToken, this.config.secretAccessKey]),
          err.statusCode,
        );
      }
      const rawMessage = err instanceof Error ? err.message : "Unknown email transport error";
      throw new EmailDeliveryError(
        `AWS SES email delivery failed: ${redactSensitiveEmailTokens(rawMessage, [sensitiveToken, this.config.secretAccessKey])}`,
        502,
      );
    }
  }

  public async sendPasswordResetEmail(
    payload: PasswordResetEmailPayload,
  ): Promise<EmailDeliveryResult> {
    const recipient = payload.to.trim().toLowerCase();
    if (!recipient || !recipient.includes("@")) {
      throw new EmailDeliveryError("Invalid recipient email address for password reset.", 400);
    }
    if (!payload.resetToken || payload.resetToken.trim().length < 16) {
      throw new EmailDeliveryError("Invalid password reset token payload.", 500);
    }

    const resetLink =
      payload.resetUrl ||
      `${this.config.appPublicUrl}/reset-password?token=${encodeURIComponent(payload.resetToken)}`;
    const expiresMinutes = Math.max(1, Math.round((payload.expiresAt - Date.now()) / 60000));

    const requestBody: AwsSesSendEmailRequest = {
      FromEmailAddress: `${this.config.fromName} <${this.config.fromEmail}>`,
      Destination: {
        ToAddresses: [recipient],
      },
      Content: {
        Simple: {
          Subject: {
            Data: "Reset your Aurelia TimeFlow password",
            Charset: "UTF-8",
          },
          Body: {
            Text: {
              Data: [
                "A password reset was requested for your Aurelia TimeFlow account.",
                `Use the following link within ${expiresMinutes} minutes to reset your password:`,
                resetLink,
                "",
                "If you did not request this change, you can safely ignore this email.",
              ].join("\n"),
              Charset: "UTF-8",
            },
            Html: {
              Data: `<p>A password reset was requested for your <strong>Aurelia TimeFlow</strong> account.</p><p><a href="${resetLink}">Reset your password</a> (expires in ${expiresMinutes} minutes).</p><p>If you did not request this change, you can safely ignore this email.</p>`,
              Charset: "UTF-8",
            },
          },
        },
      },
      ...(this.config.configurationSetName
        ? { ConfigurationSetName: this.config.configurationSetName }
        : {}),
    };

    return this.dispatchSesEmail(requestBody, payload.resetToken);
  }

  public async sendEmailVerificationEmail(
    payload: EmailVerificationPayload,
  ): Promise<EmailDeliveryResult> {
    const recipient = payload.to.trim().toLowerCase();
    if (!recipient || !recipient.includes("@")) {
      throw new EmailDeliveryError("Invalid recipient email address for verification.", 400);
    }
    if (!payload.verificationToken || payload.verificationToken.trim().length < 16) {
      throw new EmailDeliveryError("Invalid email verification token payload.", 500);
    }

    const verifyLink =
      payload.verificationUrl ||
      `${this.config.appPublicUrl}/verify-email?token=${encodeURIComponent(payload.verificationToken)}&tenantId=${encodeURIComponent(payload.tenantId)}`;

    const requestBody: AwsSesSendEmailRequest = {
      FromEmailAddress: `${this.config.fromName} <${this.config.fromEmail}>`,
      Destination: {
        ToAddresses: [recipient],
      },
      Content: {
        Simple: {
          Subject: {
            Data: `Verify your email to activate ${payload.companyName} on Aurelia TimeFlow`,
            Charset: "UTF-8",
          },
          Body: {
            Text: {
              Data: [
                `Welcome to Aurelia TimeFlow!`,
                `Please verify your administrator email address to activate the workspace for ${payload.companyName}:`,
                verifyLink,
              ].join("\n"),
              Charset: "UTF-8",
            },
            Html: {
              Data: `<p>Welcome to <strong>Aurelia TimeFlow</strong>!</p><p>Please <a href="${verifyLink}">verify your administrator email address</a> to activate the workspace for <strong>${payload.companyName}</strong>.</p>`,
              Charset: "UTF-8",
            },
          },
        },
      },
      ...(this.config.configurationSetName
        ? { ConfigurationSetName: this.config.configurationSetName }
        : {}),
    };

    return this.dispatchSesEmail(requestBody, payload.verificationToken);
  }
}

/**
 * Development-Only Email Outbox (`TransactionalEmailService`) reserved strictly for
 * product development and automated testing when AWS SES is disabled or not yet configured.
 * - Executes any configured transportHook BEFORE recording or confirming acceptance.
 * - Computes `actionUrl` using the configured development/preview `APP_PUBLIC_URL`.
 * - Never logs raw tokens to stdout/stderr.
 * - Strictly blocked in production (`APP_ENV=production` or `NODE_ENV=production`).
 */
export class TransactionalEmailService implements EmailDeliveryProvider {
  private readonly outbox: DispatchedEmailRecord[] = [];
  private transportHook?: ((record: DispatchedEmailRecord) => Promise<void>) | undefined;
  private envContext?: Record<string, string | undefined> | undefined;

  public setTransportHook(hook?: (record: DispatchedEmailRecord) => Promise<void>): void {
    this.transportHook = hook;
  }

  public setEnvironmentContext(env?: Record<string, string | undefined>): void {
    this.envContext = env;
  }

  public async sendPasswordResetEmail(
    payload: PasswordResetEmailPayload,
  ): Promise<EmailDeliveryResult> {
    const activeEnv = this.envContext ?? process.env;
    if (isProductionEmailEnvironment(activeEnv)) {
      throw new EmailDeliveryError(
        "Development email outbox is disabled in production. Configure AWS SES.",
        500,
      );
    }

    const baseUrl = resolveAppPublicUrl(activeEnv);
    const actionUrl =
      payload.resetUrl ||
      `${baseUrl}/reset-password?token=${encodeURIComponent(payload.resetToken)}`;

    const record: DispatchedEmailRecord = {
      id: `msg_rst_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      type: "password_reset",
      to: payload.to.toLowerCase().trim(),
      token: payload.resetToken,
      actionUrl,
      expiresAt: payload.expiresAt,
      dispatchedAt: new Date().toISOString(),
    };

    if (this.transportHook) {
      try {
        await this.transportHook(record);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Email transport hook failed";
        throw new EmailDeliveryError(redactSensitiveEmailTokens(msg, [payload.resetToken]), 502);
      }
    }

    this.outbox.push(record);
    return { messageId: record.id, accepted: true, provider: "in_memory" };
  }

  public async sendEmailVerificationEmail(
    payload: EmailVerificationPayload,
  ): Promise<EmailDeliveryResult> {
    const activeEnv = this.envContext ?? process.env;
    if (isProductionEmailEnvironment(activeEnv)) {
      throw new EmailDeliveryError(
        "Development email outbox is disabled in production. Configure AWS SES.",
        500,
      );
    }

    const baseUrl = resolveAppPublicUrl(activeEnv);
    const actionUrl =
      payload.verificationUrl ||
      `${baseUrl}/verify-email?token=${encodeURIComponent(payload.verificationToken)}&tenantId=${encodeURIComponent(payload.tenantId)}`;

    const record: DispatchedEmailRecord = {
      id: `msg_ver_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      type: "email_verification",
      to: payload.to.toLowerCase().trim(),
      token: payload.verificationToken,
      actionUrl,
      expiresAt: payload.expiresAt,
      dispatchedAt: new Date().toISOString(),
      metadata: {
        companyName: payload.companyName,
        tenantId: payload.tenantId,
      },
    };

    if (this.transportHook) {
      try {
        await this.transportHook(record);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Email transport hook failed";
        throw new EmailDeliveryError(
          redactSensitiveEmailTokens(msg, [payload.verificationToken]),
          502,
        );
      }
    }

    this.outbox.push(record);
    return { messageId: record.id, accepted: true, provider: "in_memory" };
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

export interface DevelopmentEmailOutboxAccessor {
  readonly mode: "development_outbox";
  getOutbox(): ReadonlyArray<DispatchedEmailRecord>;
  getLatestEmailFor(
    recipientEmail: string,
    type?: "password_reset" | "email_verification",
  ): DispatchedEmailRecord | undefined;
  clearOutbox(): void;
}

/**
 * Isolated development/test mechanism for inspecting password-reset and email-verification
 * tokens when AWS SES is disabled or unconfigured during product development.
 * - Fails closed (`403`) in production so development tokens are never accessible in production.
 */
export function getDevelopmentEmailOutbox(
  env: Record<string, string | undefined> = process.env,
): DevelopmentEmailOutboxAccessor {
  if (isProductionEmailEnvironment(env)) {
    throw new EmailDeliveryError(
      "Development email outbox is strictly disabled in production.",
      403,
    );
  }
  return {
    mode: "development_outbox",
    getOutbox: () => defaultEmailDeliveryProvider.getOutbox(),
    getLatestEmailFor: (recipientEmail, type) =>
      defaultEmailDeliveryProvider.getLatestEmailFor(recipientEmail, type),
    clearOutbox: () => defaultEmailDeliveryProvider.clearOutbox(),
  };
}

/**
 * Resolves the appropriate `EmailDeliveryProvider` for the current environment.
 * - In production (`APP_ENV=production` or `NODE_ENV=production`):
 *   - Requires a verified AWS SES sender (`AWS_SES_FROM_EMAIL`), valid `https://` `APP_PUBLIC_URL`,
 *     and AWS SES credentials.
 *   - Rejects `AWS_SES_ENABLED=false` or `EMAIL_DELIVERY_MODE=development` / `development_outbox`.
 *   - Fails closed with `EmailDeliveryError` if email delivery is not configured.
 * - In development/test:
 *   - Makes `APP_PUBLIC_URL` and `AWS_SES_FROM_EMAIL` optional.
 *   - When `AWS_SES_ENABLED=false` or `EMAIL_DELIVERY_MODE=development` (or SES is unconfigured),
 *     does not initialize AWS SES and uses `defaultEmailDeliveryProvider` (development outbox).
 */
export function resolveEmailDeliveryProvider(
  env: Record<string, string | undefined> = process.env,
  explicitProvider?: EmailDeliveryProvider,
): EmailDeliveryProvider {
  const isProd = isProductionEmailEnvironment(env);

  if (isProd) {
    if (isEmailDeliveryDisabledInEnv(env)) {
      throw new EmailDeliveryError(
        "Email delivery cannot be disabled (AWS_SES_ENABLED=false or EMAIL_DELIVERY_MODE=development) in production.",
        500,
      );
    }
    if (explicitProvider instanceof TransactionalEmailService) {
      throw new EmailDeliveryError(
        "Development email outbox is disabled in production. Configure AWS SES.",
        500,
      );
    }
    if (explicitProvider) {
      return explicitProvider;
    }
    const config = loadAwsSesConfig(env);
    return new AwsSesEmailProvider({ config });
  }

  // Validate APP_PUBLIC_URL if set in development/test (optional; allows any valid http/https dev/preview URL)
  resolveAppPublicUrl(env);

  if (explicitProvider) {
    if (explicitProvider instanceof TransactionalEmailService) {
      explicitProvider.setEnvironmentContext(env);
    }
    return explicitProvider;
  }

  if (isEmailDeliveryDisabledInEnv(env)) {
    defaultEmailDeliveryProvider.setEnvironmentContext(env);
    return defaultEmailDeliveryProvider;
  }

  const sesExplicitlyForced =
    env["AWS_SES_ENABLED"]?.trim().toLowerCase() === "true" ||
    env["EMAIL_DELIVERY_MODE"]?.trim().toLowerCase() === "aws_ses";

  if (sesExplicitlyForced || isAwsSesConfigured(env)) {
    const config = loadAwsSesConfig(env);
    return new AwsSesEmailProvider({ config });
  }

  defaultEmailDeliveryProvider.setEnvironmentContext(env);
  return defaultEmailDeliveryProvider;
}
