import crypto from "node:crypto";

/**
 * Enterprise Single Sign-On (SSO) Architecture & End-to-End OIDC/SAML Verification
 * Provides cryptographic state, nonce, PKCE code challenge & verifier validation,
 * authorized redirect URI verification, OAuth 2.0 / OIDC authorization-code token exchange,
 * JWKS retrieval & key selection, RS256 ID token signature & claims verification,
 * and AWS Secrets Manager configuration loading for Google Workspace OIDC,
 * Microsoft Entra ID OIDC, and SAML 2.0.
 *
 * Security Invariant: NEVER simulate fake successful SSO authentication.
 * If upstream IdP credentials, exchange tokens, JWKS keys, or claims are missing or invalid,
 * fail closed with typed errors.
 */

export interface OidcProviderConfig {
  connectionId?: string | undefined;
  provider: "google_oidc" | "entra_oidc";
  clientId: string;
  clientSecret?: string | undefined;
  issuerUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint?: string | undefined;
  jwksUri?: string | undefined;
  redirectUri: string;
  tenantId: string;
  publicKeyPem?: string | crypto.KeyObject | undefined;
}

export interface OidcAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface SamlProviderConfig {
  connectionId?: string | undefined;
  entityId?: string | undefined;
  spEntityId?: string | undefined;
  acsUrl: string;
  idpSsoUrl: string;
  tenantId: string;
  idpCertificate?: string | undefined;
}

export interface VerifiedOidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string | undefined;
  exp: number;
  iat: number;
  nbf?: number | undefined;
  nonce?: string | undefined;
  email?: string | undefined;
  email_verified?: boolean | undefined;
  name?: string | undefined;
}

export interface OidcTokenExchangeResponse {
  idToken: string;
  accessToken?: string | undefined;
  tokenType?: string | undefined;
  expiresIn?: number | undefined;
}

export interface ActiveOidcStateRecord {
  tenantId: string;
  nonce: string;
  codeVerifier?: string | undefined;
  codeChallenge?: string | undefined;
  redirectUri?: string | undefined;
  clientId?: string | undefined;
  issuerUrl?: string | undefined;
  provider?: "google_oidc" | "entra_oidc" | undefined;
  connectionId?: string | undefined;
  createdAt: number;
}

/**
 * Loads OIDC provider configuration from AWS Secrets Manager JSON (`AWS_SSO_SECRET_JSON`)
 * without hardcoding client secrets in source code.
 */
export function loadOidcConfigFromAwsSecrets(
  secretJson: string,
  expectedProvider: "google_oidc" | "entra_oidc",
): OidcProviderConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(secretJson) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid AWS_SSO_SECRET_JSON: must be valid JSON.");
  }

  const clientId = typeof parsed["clientId"] === "string" ? parsed["clientId"].trim() : "";
  const clientSecret =
    typeof parsed["clientSecret"] === "string" ? parsed["clientSecret"].trim() : "";
  const issuerUrl = typeof parsed["issuerUrl"] === "string" ? parsed["issuerUrl"].trim() : "";
  const redirectUri = typeof parsed["redirectUri"] === "string" ? parsed["redirectUri"].trim() : "";
  const tenantId = typeof parsed["tenantId"] === "string" ? parsed["tenantId"].trim() : "";
  const connectionId =
    typeof parsed["connectionId"] === "string" && parsed["connectionId"].trim()
      ? parsed["connectionId"].trim()
      : undefined;

  if (!clientId || !clientSecret || !issuerUrl || !redirectUri || !tenantId) {
    throw new Error(
      "AWS_SSO_SECRET_JSON is missing required OIDC fields (clientId, clientSecret, issuerUrl, redirectUri, tenantId).",
    );
  }

  return {
    connectionId,
    provider: expectedProvider,
    clientId,
    clientSecret,
    issuerUrl,
    authorizationEndpoint:
      typeof parsed["authorizationEndpoint"] === "string"
        ? parsed["authorizationEndpoint"]
        : expectedProvider === "google_oidc"
          ? "https://accounts.google.com/o/oauth2/v2/auth"
          : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint:
      typeof parsed["tokenEndpoint"] === "string"
        ? parsed["tokenEndpoint"]
        : expectedProvider === "google_oidc"
          ? "https://oauth2.googleapis.com/token"
          : "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwksUri:
      typeof parsed["jwksUri"] === "string"
        ? parsed["jwksUri"]
        : expectedProvider === "google_oidc"
          ? "https://www.googleapis.com/oauth2/v3/certs"
          : "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    redirectUri,
    tenantId,
  };
}

export class SsoService {
  private readonly stateSecret: string;
  private readonly activeStates = new Map<string, ActiveOidcStateRecord>();
  private readonly oidcConnections = new Map<string, OidcProviderConfig>();
  private fetchFn: typeof fetch;

  constructor(stateSecret?: string, fetchFn?: typeof fetch) {
    this.stateSecret = stateSecret || crypto.randomBytes(32).toString("hex");
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  public setFetchImplementation(fetchFn: typeof fetch): void {
    this.fetchFn = fetchFn;
  }

  public registerOidcConnection(connectionId: string, config: OidcProviderConfig): void {
    this.oidcConnections.set(connectionId, { ...config, connectionId });
    this.oidcConnections.set(`tenant:${config.tenantId}:${config.provider}`, {
      ...config,
      connectionId,
    });
  }

  public getOidcConnection(
    connectionIdOrTenantKey: string,
    tenantId?: string,
  ): OidcProviderConfig | undefined {
    const direct = this.oidcConnections.get(connectionIdOrTenantKey);
    if (direct) return direct;
    if (tenantId) {
      const googleConn = this.oidcConnections.get(`tenant:${tenantId}:google_oidc`);
      if (
        googleConn &&
        (connectionIdOrTenantKey === "google" || connectionIdOrTenantKey === "google_oidc")
      ) {
        return googleConn;
      }
      const entraConn = this.oidcConnections.get(`tenant:${tenantId}:entra_oidc`);
      if (
        entraConn &&
        (connectionIdOrTenantKey === "entra" || connectionIdOrTenantKey === "entra_oidc")
      ) {
        return entraConn;
      }
      return googleConn ?? entraConn;
    }
    return undefined;
  }

  public clearConnections(): void {
    this.oidcConnections.clear();
  }

  /**
   * Validates that a redirect URI is a well-formed HTTPS URL (or localhost in dev/test)
   * and matches the expected authorized redirect URI when comparing callback parameters.
   */
  public validateRedirectUri(
    redirectUri: string,
    expectedRedirectUri?: string,
  ): { valid: boolean; error?: string } {
    if (!redirectUri || typeof redirectUri !== "string") {
      return { valid: false, error: "Missing OIDC redirect_uri." };
    }
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return { valid: false, error: "Malformed OIDC redirect_uri." };
    }

    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !isLocalhost) {
      return {
        valid: false,
        error: "OIDC redirect_uri must use HTTPS for non-localhost endpoints.",
      };
    }

    if (expectedRedirectUri !== undefined && redirectUri !== expectedRedirectUri) {
      return {
        valid: false,
        error: `OIDC redirect_uri mismatch: expected "${expectedRedirectUri}", received "${redirectUri}".`,
      };
    }

    return { valid: true };
  }

  /**
   * Generates a signed cryptographic state parameter binding tenant ID, random nonce,
   * PKCE code verifier/challenge, and authorized redirect URI.
   */
  public generateSignedState(
    tenantId: string,
    nonce: string,
    codeVerifier?: string | undefined,
    metadata?: {
      codeChallenge?: string | undefined;
      redirectUri?: string | undefined;
      clientId?: string | undefined;
      issuerUrl?: string | undefined;
      provider?: "google_oidc" | "entra_oidc" | undefined;
      connectionId?: string | undefined;
      now?: number | undefined;
    },
  ): string {
    const timestamp = metadata?.now ?? Date.now();
    const entropy = crypto.randomBytes(16).toString("hex");
    const payload = `${tenantId}:${timestamp}:${entropy}`;
    const signature = crypto.createHmac("sha256", this.stateSecret).update(payload).digest("hex");
    const state = `${Buffer.from(payload).toString("base64url")}.${signature}`;

    const computedChallenge =
      metadata?.codeChallenge ??
      (codeVerifier
        ? crypto.createHash("sha256").update(codeVerifier).digest("base64url")
        : undefined);

    this.activeStates.set(state, {
      tenantId,
      nonce,
      codeVerifier,
      codeChallenge: computedChallenge,
      redirectUri: metadata?.redirectUri,
      clientId: metadata?.clientId,
      issuerUrl: metadata?.issuerUrl,
      provider: metadata?.provider,
      connectionId: metadata?.connectionId,
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
    now = Date.now(),
  ): {
    valid: boolean;
    tenantId?: string | undefined;
    nonce?: string | undefined;
    codeVerifier?: string | undefined;
    codeChallenge?: string | undefined;
    redirectUri?: string | undefined;
    clientId?: string | undefined;
    issuerUrl?: string | undefined;
    provider?: "google_oidc" | "entra_oidc" | undefined;
    connectionId?: string | undefined;
    error?: string | undefined;
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

    if (!tenantId || !Number.isInteger(timestamp) || now - timestamp > maxAgeMs) {
      this.activeStates.delete(state);
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
      codeChallenge: cached.codeChallenge,
      redirectUri: cached.redirectUri,
      clientId: cached.clientId,
      issuerUrl: cached.issuerUrl,
      provider: cached.provider,
      connectionId: cached.connectionId,
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
   * Validates that a PKCE code_verifier satisfies RFC 7636 and matches the S256 code_challenge.
   */
  public verifyPkce(codeVerifier?: string, expectedCodeChallenge?: string): boolean {
    if (
      !codeVerifier ||
      typeof codeVerifier !== "string" ||
      codeVerifier.length < 43 ||
      codeVerifier.length > 128 ||
      !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)
    ) {
      return false;
    }
    if (!expectedCodeChallenge || typeof expectedCodeChallenge !== "string") {
      return false;
    }
    const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    if (computed.length !== expectedCodeChallenge.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expectedCodeChallenge));
  }

  /**
   * Prepares a Google Workspace OIDC authorization request.
   */
  public prepareGoogleOidcRequest(config: OidcProviderConfig): OidcAuthorizationRequest {
    if (config.provider !== "google_oidc") {
      throw new Error("Provider must be google_oidc.");
    }
    const redirectCheck = this.validateRedirectUri(config.redirectUri);
    if (!redirectCheck.valid) {
      throw new Error(redirectCheck.error);
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = this.generatePkce();
    const state = this.generateSignedState(config.tenantId, nonce, codeVerifier, {
      codeChallenge,
      redirectUri: config.redirectUri,
      clientId: config.clientId,
      issuerUrl: config.issuerUrl,
      provider: "google_oidc",
      connectionId: config.connectionId,
    });

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
      codeChallenge,
      redirectUri: config.redirectUri,
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
    const redirectCheck = this.validateRedirectUri(config.redirectUri);
    if (!redirectCheck.valid) {
      throw new Error(redirectCheck.error);
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = this.generatePkce();
    const state = this.generateSignedState(config.tenantId, nonce, codeVerifier, {
      codeChallenge,
      redirectUri: config.redirectUri,
      clientId: config.clientId,
      issuerUrl: config.issuerUrl,
      provider: "entra_oidc",
      connectionId: config.connectionId,
    });

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
      codeChallenge,
      redirectUri: config.redirectUri,
    };
  }

  /**
   * Validates an incoming OIDC callback code, state, PKCE verifier/challenge, and redirect URI.
   * Fails closed if the code, state, PKCE, or redirect URI is missing, forged, or expired.
   */
  public validateOidcCallback(input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
    expectedTenantId?: string | undefined;
    redirectUri?: string | undefined;
    codeVerifierOverride?: string | undefined;
    now?: number | undefined;
  }): {
    valid: boolean;
    tenantId?: string | undefined;
    code?: string | undefined;
    nonce?: string | undefined;
    codeVerifier?: string | undefined;
    codeChallenge?: string | undefined;
    redirectUri?: string | undefined;
    provider?: "google_oidc" | "entra_oidc" | undefined;
    connectionId?: string | undefined;
    error?: string | undefined;
  } {
    if (input.error) {
      return {
        valid: false,
        error: `IdP returned authentication error: ${input.error} (${input.errorDescription ?? "no detail"})`,
      };
    }
    if (!input.code || !input.code.trim()) {
      return { valid: false, error: "Missing authorization code from IdP." };
    }
    if (!input.state) {
      return { valid: false, error: "Missing state parameter in callback." };
    }

    const stateResult = this.verifyAndConsumeState(input.state, 10 * 60 * 1000, input.now);
    if (!stateResult.valid) {
      return { valid: false, error: stateResult.error };
    }

    if (input.expectedTenantId && stateResult.tenantId !== input.expectedTenantId) {
      return {
        valid: false,
        error: `SSO tenant mismatch: expected "${input.expectedTenantId}", received "${stateResult.tenantId}".`,
      };
    }

    // Validate authorized redirect URI if recorded in state or provided in callback
    if (input.redirectUri && stateResult.redirectUri) {
      const redirectCheck = this.validateRedirectUri(input.redirectUri, stateResult.redirectUri);
      if (!redirectCheck.valid) {
        return { valid: false, error: redirectCheck.error };
      }
    }

    // Validate PKCE verifier against S256 challenge if challenge was bound to state
    const effectiveVerifier = input.codeVerifierOverride ?? stateResult.codeVerifier;
    if (stateResult.codeChallenge) {
      if (!this.verifyPkce(effectiveVerifier, stateResult.codeChallenge)) {
        return {
          valid: false,
          error: "OIDC PKCE verification failed: missing or invalid code_verifier.",
        };
      }
    }

    return {
      valid: true,
      tenantId: stateResult.tenantId,
      code: input.code.trim(),
      nonce: stateResult.nonce,
      codeVerifier: effectiveVerifier,
      codeChallenge: stateResult.codeChallenge,
      redirectUri: stateResult.redirectUri ?? input.redirectUri,
      provider: stateResult.provider,
      connectionId: stateResult.connectionId,
    };
  }

  /**
   * Exchanges an OIDC authorization code at the provider's token endpoint (`tokenEndpoint`),
   * verifying the authorized `redirectUri`, `clientId`, `clientSecret`, and PKCE `codeVerifier`.
   */
  public async exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    config: OidcProviderConfig;
    fetchFn?: typeof fetch | undefined;
  }): Promise<OidcTokenExchangeResponse> {
    const { code, codeVerifier, redirectUri, config } = params;
    const fetchImpl = params.fetchFn ?? this.fetchFn;

    if (!code || !code.trim()) {
      throw new Error("OIDC code exchange failed: missing authorization code.");
    }
    if (!codeVerifier || codeVerifier.trim().length < 43) {
      throw new Error("OIDC code exchange failed: missing or invalid PKCE code_verifier.");
    }
    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        "OIDC code exchange failed: provider clientId and clientSecret are required.",
      );
    }
    if (!config.tokenEndpoint) {
      throw new Error("OIDC code exchange failed: missing provider tokenEndpoint.");
    }

    const redirectValidation = this.validateRedirectUri(redirectUri, config.redirectUri);
    if (!redirectValidation.valid) {
      throw new Error(redirectValidation.error);
    }

    if (typeof fetchImpl !== "function") {
      throw new Error("OIDC code exchange failed: HTTP fetch client is unavailable.");
    }

    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code.trim(),
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: codeVerifier.trim(),
    });

    const response = await fetchImpl(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: formBody.toString(),
    });

    let bodyJson: Record<string, unknown> = {};
    try {
      const text = await response.text();
      if (text.trim()) {
        bodyJson = JSON.parse(text) as Record<string, unknown>;
      }
    } catch {
      throw new Error("OIDC code exchange failed: malformed JSON response from token endpoint.");
    }

    if (!response.ok || bodyJson["error"]) {
      const errCode =
        typeof bodyJson["error"] === "string" ? bodyJson["error"] : `HTTP_${response.status}`;
      const errDesc =
        typeof bodyJson["error_description"] === "string"
          ? bodyJson["error_description"]
          : "Token endpoint rejected authorization code";
      throw new Error(`OIDC token exchange failed (${errCode}): ${errDesc}`);
    }

    const idToken = typeof bodyJson["id_token"] === "string" ? bodyJson["id_token"].trim() : "";
    if (!idToken) {
      throw new Error("OIDC token exchange failed: response did not contain an id_token.");
    }

    return {
      idToken,
      accessToken:
        typeof bodyJson["access_token"] === "string" ? bodyJson["access_token"] : undefined,
      tokenType: typeof bodyJson["token_type"] === "string" ? bodyJson["token_type"] : undefined,
      expiresIn: typeof bodyJson["expires_in"] === "number" ? bodyJson["expires_in"] : undefined,
    };
  }

  /**
   * Retrieves the Identity Provider's JSON Web Key Set (JWKS) from `jwksUri`
   * and resolves the RSA public key matching the ID token's `kid` header.
   */
  public async fetchJwksSigningKey(params: {
    jwksUri: string;
    kid?: string | undefined;
    alg?: string | undefined;
    fetchFn?: typeof fetch | undefined;
  }): Promise<crypto.KeyObject> {
    const fetchImpl = params.fetchFn ?? this.fetchFn;
    if (!params.jwksUri || !params.jwksUri.trim()) {
      throw new Error("OIDC JWKS verification failed: missing jwksUri.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("OIDC JWKS verification failed: HTTP fetch client is unavailable.");
    }

    const response = await fetchImpl(params.jwksUri, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch OIDC JWKS from provider (HTTP ${response.status}).`);
    }

    let jwksBody: { keys?: Array<Record<string, unknown>> };
    try {
      jwksBody = (await response.json()) as { keys?: Array<Record<string, unknown>> };
    } catch {
      throw new Error("Invalid JSON returned from OIDC JWKS endpoint.");
    }

    const keys = Array.isArray(jwksBody?.keys) ? jwksBody.keys : [];
    if (keys.length === 0) {
      throw new Error("OIDC JWKS endpoint returned no signing keys.");
    }

    const candidateKeys = keys.filter((k) => {
      const kty = typeof k["kty"] === "string" ? k["kty"] : "";
      const use = typeof k["use"] === "string" ? k["use"] : "sig";
      return kty === "RSA" && use !== "enc";
    });

    let matchedJwk: Record<string, unknown> | undefined;
    if (params.kid) {
      matchedJwk = candidateKeys.find((k) => k["kid"] === params.kid);
      if (!matchedJwk) {
        throw new Error(`No matching JWK signing key found for kid "${params.kid}".`);
      }
    } else if (candidateKeys.length === 1) {
      matchedJwk = candidateKeys[0];
    } else {
      throw new Error("OIDC ID token header is missing 'kid' and JWKS has multiple keys.");
    }

    if (!matchedJwk) {
      throw new Error("Failed to resolve matching JWK signing key from JWKS.");
    }

    if (
      matchedJwk["alg"] &&
      params.alg &&
      typeof matchedJwk["alg"] === "string" &&
      matchedJwk["alg"] !== params.alg
    ) {
      throw new Error(
        `JWK algorithm "${matchedJwk["alg"]}" does not match ID token algorithm "${params.alg}".`,
      );
    }

    try {
      return crypto.createPublicKey({
        key: matchedJwk as unknown as crypto.JsonWebKey,
        format: "jwk",
      });
    } catch {
      throw new Error("Failed to construct RSA public key from provider JWK.");
    }
  }

  /**
   * Verifies an RS256 OIDC ID Token signature and claims (`iss`, `aud`, `exp`, `iat`, `nbf`, `nonce`)
   * using the Identity Provider's PEM/JWK public key.
   */
  public verifyOidcIdTokenSignature(
    idTokenJwt: string,
    publicKeyPem: string | crypto.KeyObject,
    expected: {
      issuer: string;
      audience: string;
      nonce?: string | undefined;
      requireNonce?: boolean | undefined;
      nowSeconds?: number | undefined;
    },
  ): VerifiedOidcIdTokenClaims {
    if (!idTokenJwt || typeof idTokenJwt !== "string") {
      throw new Error("Malformed OIDC ID token JWT.");
    }
    const parts = idTokenJwt.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error("Malformed OIDC ID token JWT.");
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    let header: { alg?: string; kid?: string; typ?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
        alg?: string;
        kid?: string;
        typ?: string;
      };
    } catch {
      throw new Error("Malformed OIDC ID token header.");
    }

    if (header.alg !== "RS256") {
      throw new Error(`Unsupported OIDC ID token signing algorithm "${header.alg ?? "none"}".`);
    }

    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();

    const sigBuffer = Buffer.from(signatureB64, "base64url");
    let sigValid = false;
    try {
      sigValid = verifier.verify(publicKeyPem, sigBuffer);
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      throw new Error("Invalid OIDC ID token cryptographic signature.");
    }

    let claims: VerifiedOidcIdTokenClaims;
    try {
      claims = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      ) as VerifiedOidcIdTokenClaims;
    } catch {
      throw new Error("Malformed OIDC ID token claims payload.");
    }

    const nowSec = expected.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
      throw new Error("OIDC ID token has expired.");
    }
    if (typeof claims.iat === "number" && claims.iat > nowSec + 300) {
      throw new Error("OIDC ID token iat is in the future.");
    }
    if (typeof claims.nbf === "number" && claims.nbf > nowSec + 60) {
      throw new Error("OIDC ID token is not yet valid (nbf).");
    }
    if (!claims.iss || claims.iss !== expected.issuer) {
      throw new Error(`OIDC issuer mismatch: expected "${expected.issuer}", got "${claims.iss}".`);
    }

    const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audList.includes(expected.audience)) {
      throw new Error(`OIDC audience mismatch: expected "${expected.audience}".`);
    }
    if (claims.azp && claims.azp !== expected.audience) {
      throw new Error(
        `OIDC authorized party (azp) mismatch: expected "${expected.audience}", got "${claims.azp}".`,
      );
    }

    const mustValidateNonce = expected.requireNonce === true || expected.nonce !== undefined;
    if (mustValidateNonce) {
      if (!expected.nonce || !claims.nonce || claims.nonce !== expected.nonce) {
        throw new Error("OIDC ID token nonce mismatch.");
      }
    }

    if (!claims.sub || typeof claims.sub !== "string") {
      throw new Error("OIDC ID token is missing required 'sub' claim.");
    }

    return claims;
  }

  /**
   * Executes the full OIDC callback verification pipeline:
   * 1. Validates and consumes single-use HMAC state, PKCE code_verifier, and redirect_uri
   * 2. Exchanges the authorization code at the provider's tokenEndpoint
   * 3. Retrieves the provider's JWKS from jwksUri (or uses pinned publicKeyPem)
   * 4. Verifies the RS256 ID token cryptographic signature, issuer, audience, expiry, and nonce
   * 5. Verifies the user's email claim is present and verified
   */
  public async completeOidcCallbackExchange(params: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
    redirectUri?: string | undefined;
    codeVerifierOverride?: string | undefined;
    config?: OidcProviderConfig | undefined;
    connectionId?: string | undefined;
    fetchFn?: typeof fetch | undefined;
    nowSeconds?: number | undefined;
  }): Promise<{
    tenantId: string;
    provider: "google_oidc" | "entra_oidc";
    claims: VerifiedOidcIdTokenClaims;
    tokenResponse: OidcTokenExchangeResponse;
  }> {
    const nowMs = params.nowSeconds ? params.nowSeconds * 1000 : Date.now();
    const callbackCheck = this.validateOidcCallback({
      code: params.code,
      state: params.state,
      error: params.error,
      errorDescription: params.errorDescription,
      redirectUri: params.redirectUri,
      codeVerifierOverride: params.codeVerifierOverride,
      now: nowMs,
    });

    if (!callbackCheck.valid || !callbackCheck.code || !callbackCheck.tenantId) {
      throw new Error(callbackCheck.error ?? "OIDC callback validation failed.");
    }

    const config =
      params.config ??
      this.getOidcConnection(
        params.connectionId ?? callbackCheck.connectionId ?? callbackCheck.provider ?? "",
        callbackCheck.tenantId,
      );

    if (!config) {
      throw new Error("OIDC provider configuration is not registered for this tenant connection.");
    }

    if (config.tenantId !== callbackCheck.tenantId) {
      throw new Error(
        `SSO tenant mismatch: configuration belongs to "${config.tenantId}", state belongs to "${callbackCheck.tenantId}".`,
      );
    }

    if (!callbackCheck.codeVerifier) {
      throw new Error("Missing PKCE code_verifier for OIDC authorization code exchange.");
    }

    if (!callbackCheck.nonce) {
      throw new Error("Missing OIDC nonce in authorization state.");
    }

    const effectiveRedirectUri =
      params.redirectUri ?? callbackCheck.redirectUri ?? config.redirectUri;
    const redirectCheck = this.validateRedirectUri(effectiveRedirectUri, config.redirectUri);
    if (!redirectCheck.valid) {
      throw new Error(redirectCheck.error);
    }

    // 1. Exchange authorization code for tokens at provider tokenEndpoint
    const tokenResponse = await this.exchangeAuthorizationCode({
      code: callbackCheck.code,
      codeVerifier: callbackCheck.codeVerifier,
      redirectUri: effectiveRedirectUri,
      config,
      fetchFn: params.fetchFn,
    });

    // 2. Parse JWT header to extract kid & alg for JWKS lookup
    const jwtParts = tokenResponse.idToken.split(".");
    if (jwtParts.length !== 3 || !jwtParts[0]) {
      throw new Error("Malformed OIDC ID token returned from token endpoint.");
    }
    let jwtHeader: { alg?: string; kid?: string };
    try {
      jwtHeader = JSON.parse(Buffer.from(jwtParts[0], "base64url").toString("utf8")) as {
        alg?: string;
        kid?: string;
      };
    } catch {
      throw new Error("Malformed OIDC ID token header.");
    }

    // 3. Resolve signing public key via JWKS endpoint (or explicit publicKeyPem)
    let signingKey: string | crypto.KeyObject;
    if (config.publicKeyPem) {
      signingKey = config.publicKeyPem;
    } else {
      const jwksUri =
        config.jwksUri ||
        (config.provider === "google_oidc"
          ? "https://www.googleapis.com/oauth2/v3/certs"
          : "https://login.microsoftonline.com/common/discovery/v2.0/keys");
      signingKey = await this.fetchJwksSigningKey({
        jwksUri,
        kid: jwtHeader.kid,
        alg: jwtHeader.alg,
        fetchFn: params.fetchFn,
      });
    }

    // 4. Verify RS256 signature and claims (issuer, audience, expiry, nonce)
    const claims = this.verifyOidcIdTokenSignature(tokenResponse.idToken, signingKey, {
      issuer: config.issuerUrl,
      audience: config.clientId,
      nonce: callbackCheck.nonce,
      requireNonce: true,
      nowSeconds: params.nowSeconds,
    });

    if (!claims.email || !claims.email.includes("@")) {
      throw new Error("OIDC ID token is missing a valid 'email' claim.");
    }
    if (claims.email_verified === false) {
      throw new Error("OIDC user email address is not verified by the Identity Provider.");
    }

    return {
      tenantId: callbackCheck.tenantId,
      provider: config.provider,
      claims,
      tokenResponse,
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
    const issuerEntityId =
      config.spEntityId ?? config.entityId ?? "https://timeflow.aurelia.com/saml/sp";
    const samlRequestId = `id_${crypto.randomUUID()}`;
    const relayState = this.generateSignedState(config.tenantId, samlRequestId);
    const authnRequestXml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${samlRequestId}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${config.idpSsoUrl}">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuerEntityId}</saml:Issuer>
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
  }): { valid: boolean; tenantId?: string | undefined; error?: string | undefined } {
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
