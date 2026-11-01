-- ============================================================================
-- Aurelia TimeFlow Phase 2 Security Migration: 0002_auth_persistence.sql
-- Target: Private AWS RDS PostgreSQL (ap-south-1, Publicly accessible = No)
-- Purpose: Persistent server-side sessions, hashed single-use password reset
--          tokens, and hashed single-use email verification tokens.
-- Security Invariant: Raw session, reset, and verification tokens are NEVER
--          stored in the database; only SHA-256 hex digests (token_hash) exist.
-- ============================================================================

BEGIN;

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
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash VARCHAR(64) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_tenant_user_idx
  ON email_verification_tokens (tenant_id, user_id);

COMMIT;
