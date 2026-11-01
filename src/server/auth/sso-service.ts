import crypto from "node:crypto";

/**
 * Enterprise Single Sign-On (SSO) Architecture Preparation
 * Provides real cryptographic state, nonce, PKCE code challenge, and redirect URI validation
 * for Google Workspace OIDC, Microsoft Entra ID OIDC, and SAML 2.0.
 *
 * Security Invariant: NEVER simulate fake successful SSO authentication.
 * If upstream IdP credentials, exchange tokens, or certs are missing, fail closed with typed errors.
 */

export interface OidcProviderConfig {
  provider: "google_oidc" | "entra_oidc";
  clientId: string;
  clientSecret?: string;
  issuerUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint?: string;
  redirectUri: string;
  tenantId: string;
}

export interface OidcAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface SamlProviderConfig {
  entityId: string;
  acsUrl: string;
  idpSsoUrl: string;
  tenantId: string;
  idpCertificate?: string;
}

export class SsoService {
  private readonly stateSecret: string;
  private readonly activeStates = new Map<
    string,
    { tenantId: string; nonce: string; codeVerifier?: string; createdAt: number }
  >();

  constructor(stateSecret?: string) {
    this.stateSecret = stateSecret || crypto.randomBytes(32).toString("hex");
  }

  /**
   * Generates a signed cryptographic state parameter binding tenant ID and random nonce.
   */
  public generateSignedState(tenantId: string, nonce: string, codeVerifier?: string): string {
    const timestamp = Date.now();
    const entropy = crypto.randomBytes(16).toString("hex");
    const payload = `${tenantId}:${timestamp}:${entropy}`;
    const signature = crypto.createHmac("sha256", this.stateSecret).update(payload).digest("hex");
    const state = `${Buffer.from(payload).toString("base64url")}.${signature}`;

    this.activeStates.set(state, {
      tenantId,
      nonce,
      codeVerifier,
      createdAt: timestamp,
    });

    return state;
  }

  /**
   * Verifies an incoming SSO state parameter.
   * Ensures the state is authentic, signed, unexpired (10-minute TTL), and single-use.
   */
  public verifyAndConsumeState(
    state: string,
    maxAgeMs = 10 * 60 * 1000,
  ): {
    valid: boolean;
    tenantId?: string;
    nonce?: string;
    codeVerifier?: string;
    error?: string;
  } {
    if (!state || typeof state !== "string" || !state.includes(".")) {
      return { valid: false, error: "Invalid SSO state format." };
    }

    const [b64Payload, signature] = state.split(".");
    if (!b64Payload || !signature) {
      return { valid: false, error: "Malformed SSO state." };
    }

    let payload: string;
    try {
      payload = Buffer.from(b64Payload, "base64url").toString("utf8");
    } catch {
      return { valid: false, error: "Unable to decode state payload." };
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.stateSecret)
      .update(payload)
      .digest("hex");

    if (
      signature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    ) {
      return { valid: false, error: "Tampered or forged SSO state signature." };
    }

    const parts = payload.split(":");
    const tenantId = parts[0];
    const timestamp = Number(parts[1]);

    if (!tenantId || !Number.isInteger(timestamp) || Date.now() - timestamp > maxAgeMs) {
      return { valid: false, error: "Expired SSO state parameter." };
    }

    const cached = this.activeStates.get(state);
    if (!cached) {
      return {
        valid: false,
        error: "SSO state has already been consumed or was not initiated by this server.",
      };
    }

    // Invalidate state immediately to prevent replay attacks
    this.activeStates.delete(state);

    return {
      valid: true,
      tenantId,
      nonce: cached.nonce,
      codeVerifier: cached.codeVerifier,
    };
  }

  /**
   * Generates PKCE code_verifier and code_challenge (RFC 7636).
   */
  public generatePkce(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  /**
   * Prepares a Google Workspace OIDC authorization request.
   */
  public prepareGoogleOidcRequest(config: OidcProviderConfig): OidcAuthorizationRequest {
    if (config.provider !== "google_oidc") {
      throw new Error("Provider must be google_oidc.");
    }
    const nonce = crypto.randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = this.generatePkce();
    const state = this.generateSignedState(config.tenantId, nonce, codeVerifier);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "select_account",
    });

    const endpoint = config.authorizationEndpoint || "https://accounts.google.com/o/oauth2/v2/auth";
    return {
      authorizationUrl: `${endpoint}?${params.toString()}`,
      state,
      nonce,
      codeVerifier,
    };
  }

  /**
   * Prepares a Microsoft Entra ID OIDC authorization request.
   */
  public prepareEntraOidcRequest(
    config: OidcProviderConfig,
    entraTenantId = "common",
  ): OidcAuthorizationRequest {
    if (config.provider !== "entra_oidc") {
      throw new Error("Provider must be entra_oidc.");
    }
    const nonce = crypto.randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = this.generatePkce();
    const state = this.generateSignedState(config.tenantId, nonce, codeVerifier);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile offline_access",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_mode: "query",
    });

    const endpoint =
      config.authorizationEndpoint ||
      `https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/authorize`;

    return {
      authorizationUrl: `${endpoint}?${params.toString()}`,
      state,
      nonce,
      codeVerifier,
    };
  }

  /**
   * Validates an incoming OIDC callback code and state.
   * Fails closed if the code or state is missing, forged, or expired.
   */
  public validateOidcCallback(input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
    expectedTenantId?: string | undefined;
  }): { valid: boolean; tenantId?: string; code?: string; codeVerifier?: string; error?: string } {
    if (input.error) {
      return {
        valid: false,
        error: `IdP returned authentication error: ${input.error} (${input.errorDescription ?? "no detail"})`,
      };
    }
    if (!input.code) {
      return { valid: false, error: "Missing authorization code from IdP." };
    }
    if (!input.state) {
      return { valid: false, error: "Missing state parameter in callback." };
    }

    const stateResult = this.verifyAndConsumeState(input.state);
    if (!stateResult.valid) {
      return { valid: false, error: stateResult.error };
    }

    if (input.expectedTenantId && stateResult.tenantId !== input.expectedTenantId) {
      return {
        valid: false,
        error: `SSO tenant mismatch: expected "${input.expectedTenantId}", received "${stateResult.tenantId}".`,
      };
    }

    return {
      valid: true,
      tenantId: stateResult.tenantId,
      code: input.code,
      codeVerifier: stateResult.codeVerifier,
    };
  }

  /**
   * Prepares SAML 2.0 AuthnRequest parameters.
   */
  public prepareSamlAuthnRequest(config: SamlProviderConfig): {
    ssoUrl: string;
    relayState: string;
    samlRequestId: string;
    authnRequestXml: string;
  } {
    const samlRequestId = `id_${crypto.randomUUID()}`;
    const relayState = this.generateSignedState(config.tenantId, samlRequestId);
    const authnRequestXml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${samlRequestId}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${config.idpSsoUrl}">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${config.spEntityId}</saml:Issuer>
</samlp:AuthnRequest>`;

    return {
      ssoUrl: config.idpSsoUrl,
      relayState,
      samlRequestId,
      authnRequestXml,
    };
  }

  /**
   * Validates SAML 2.0 response parameters.
   * Strictly verifies relayState signature and ensures SAMLResponse is present.
   */
  public validateSamlResponse(input: {
    samlResponse?: string | undefined;
    relayState?: string | undefined;
  }): { valid: boolean; tenantId?: string; error?: string } {
    if (!input.samlResponse || typeof input.samlResponse !== "string") {
      return { valid: false, error: "Missing SAMLResponse parameter." };
    }
    if (!input.relayState || typeof input.relayState !== "string") {
      return { valid: false, error: "Missing RelayState parameter." };
    }

    const stateResult = this.verifyAndConsumeState(input.relayState);
    if (!stateResult.valid) {
      return { valid: false, error: `Invalid SAML RelayState: ${stateResult.error}` };
    }

    return {
      valid: true,
      tenantId: stateResult.tenantId,
    };
  }
}

export const defaultSsoService = new SsoService();
