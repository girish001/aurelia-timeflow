-- ============================================================================
-- Aurelia TimeFlow Multi-Tenant SaaS Migration: 0001_initial_multi_tenant.sql
-- Target: Private AWS RDS PostgreSQL (ap-south-1, Publicly accessible = No)
-- Execution: Transactional DDL (BEGIN ... COMMIT). Any failure rolls back atomically.
-- Retry Safety: Uses IF NOT EXISTS / DROP POLICY IF EXISTS for idempotent re-runs.
-- ============================================================================

BEGIN;

-- Native gen_random_uuid() is built into PostgreSQL 13+ (AWS RDS PostgreSQL 14/15/16/17)
-- without requiring superuser extension privileges.

-- ============================================================================
-- 1. Core Tenant, Identity & Governance Tables (Ordered by FK Dependencies)
-- ============================================================================

-- [1/23] tenants
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'provisioning',
  onboarding_mode VARCHAR(32) NOT NULL DEFAULT 'self_service',
  country VARCHAR(80) NOT NULL DEFAULT 'India',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  time_format VARCHAR(16) NOT NULL DEFAULT 'decimal',
  week_start VARCHAR(16) NOT NULL DEFAULT 'monday',
  daily_target_hours NUMERIC(4,2) NOT NULL DEFAULT 8.00,
  lock_approved_sheets BOOLEAN NOT NULL DEFAULT TRUE,
  require_reject_reason BOOLEAN NOT NULL DEFAULT TRUE,
  leave_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenants_status_check CHECK (status IN ('provisioning', 'onboarding', 'trial', 'active', 'suspended', 'archived')),
  CONSTRAINT tenants_onboarding_mode_check CHECK (onboarding_mode IN ('self_service', 'assisted_enterprise'))
);

-- [2/23] tenant_domains
CREATE TABLE IF NOT EXISTS tenant_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain VARCHAR(255) NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ,
  auto_join_policy VARCHAR(32) NOT NULL DEFAULT 'never',
  verification_txt_token VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_domains_no_blind_autojoin CHECK (auto_join_policy IN ('never', 'invite_only', 'sso_verified_only'))
);

-- [3/23] users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT,
  full_name VARCHAR(160) NOT NULL,
  avatar_url TEXT,
  email_verified_at TIMESTAMPTZ,
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'locked', 'disabled'))
);

-- [4/23] departments
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(32),
  parent_department_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, parent_department_id) REFERENCES departments(tenant_id, id) ON DELETE SET NULL
);

-- [5/23] memberships
CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id UUID,
  employee_code VARCHAR(48),
  job_title VARCHAR(120) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'invited',
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memberships_status_check CHECK (status IN ('invited', 'active', 'inactive', 'offboarded')),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id) ON DELETE SET NULL
);

-- [6/23] roles
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, key)
);

-- [7/23] permissions
CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(96) NOT NULL UNIQUE,
  module VARCHAR(48) NOT NULL,
  description TEXT NOT NULL
);

-- [8/23] role_permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- [9/23] membership_roles
CREATE TABLE IF NOT EXISTS membership_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by_membership_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assigned_by_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL
);

-- [10/23] reporting_lines
CREATE TABLE IF NOT EXISTS reporting_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subordinate_membership_id UUID NOT NULL,
  manager_membership_id UUID NOT NULL,
  relationship_type VARCHAR(32) NOT NULL DEFAULT 'primary_hr',
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reporting_no_self_loop CHECK (subordinate_membership_id <> manager_membership_id),
  CONSTRAINT reporting_lines_relationship_type_check CHECK (relationship_type IN ('primary_hr', 'dotted_line')),
  UNIQUE (tenant_id, subordinate_membership_id, manager_membership_id, relationship_type),
  FOREIGN KEY (tenant_id, subordinate_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, manager_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

-- [11/23] invitations
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  role_keys_json JSONB NOT NULL DEFAULT '["employee"]'::jsonb,
  department_id UUID,
  reporting_manager_membership_id UUID,
  invited_by_membership_id UUID,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invitations_status_check CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, reporting_manager_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, invited_by_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL
);

-- [12/23] identity_connections
CREATE TABLE IF NOT EXISTS identity_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  issuer_url TEXT NOT NULL,
  client_id VARCHAR(255),
  metadata_xml_url TEXT,
  sso_endpoint TEXT,
  enforce_sso_only BOOLEAN NOT NULL DEFAULT FALSE,
  jit_provisioning_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT identity_connections_provider_check CHECK (provider IN ('entra_oidc', 'google_oidc', 'saml')),
  CONSTRAINT identity_connections_status_check CHECK (status IN ('draft', 'testing', 'active', 'disabled'))
);

-- [13/23] subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'trialing',
  seat_limit INTEGER NOT NULL DEFAULT 25,
  billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly',
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  provisioned_by_platform_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_status_check CHECK (status IN ('trialing', 'active', 'past_due', 'canceled'))
);

-- [14/23] audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_membership_id UUID,
  impersonated_by_platform_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category VARCHAR(48) NOT NULL,
  action VARCHAR(120) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(128),
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL
);

-- ============================================================================
-- 2. Tenant Operational Tables with Composite Tenant Foreign Keys
-- ============================================================================

-- [15/23] clients
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  contact_name VARCHAR(120) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  country VARCHAR(80) NOT NULL,
  billing_terms VARCHAR(64) NOT NULL DEFAULT 'Net 30',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id)
);

-- [16/23] projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  name VARCHAR(160) NOT NULL,
  project_manager_membership_id UUID NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  budget_hours NUMERIC(10,2) NOT NULL,
  billable_rate NUMERIC(12,2) NOT NULL,
  tasks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT projects_status_check CHECK (status IN ('active', 'on-hold', 'completed')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_manager_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT
);

-- [17/23] project_memberships
CREATE TABLE IF NOT EXISTS project_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  project_role VARCHAR(32) NOT NULL DEFAULT 'contributor',
  can_approve_timesheets BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_allocations BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_memberships_role_check CHECK (project_role IN ('project_manager', 'team_lead', 'contributor', 'viewer')),
  UNIQUE (tenant_id, project_id, membership_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

-- [18/23] timesheets
CREATE TABLE IF NOT EXISTS timesheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL,
  week_start DATE NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_membership_id UUID,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT timesheets_status_check CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, membership_id, week_start),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL
);

-- [19/23] timesheet_entries
CREATE TABLE IF NOT EXISTS timesheet_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timesheet_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_name VARCHAR(120) NOT NULL,
  hours_by_day_json JSONB NOT NULL DEFAULT '[0,0,0,0,0,0,0]'::jsonb,
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (tenant_id, timesheet_id) REFERENCES timesheets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT
);

-- [20/23] leave_requests
CREATE TABLE IF NOT EXISTS leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL,
  type VARCHAR(32) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  partial VARCHAR(16) NOT NULL DEFAULT 'full',
  reason TEXT NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  reviewed_by_membership_id UUID,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT leave_requests_type_check CHECK (type IN ('annual', 'sick', 'personal', 'unpaid')),
  CONSTRAINT leave_requests_partial_check CHECK (partial IN ('full', 'am', 'pm')),
  CONSTRAINT leave_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL
);

-- [21/23] approvals
CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_type VARCHAR(32) NOT NULL,
  target_id UUID NOT NULL,
  requester_membership_id UUID NOT NULL,
  approver_membership_id UUID,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  comment TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT approvals_target_type_check CHECK (target_type IN ('timesheet', 'leave_request')),
  CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  FOREIGN KEY (tenant_id, requester_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL
);

-- [22/23] resource_allocations
CREATE TABLE IF NOT EXISTS resource_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL,
  project_id UUID NOT NULL,
  allocation_date DATE NOT NULL,
  hours NUMERIC(4,2) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resource_allocations_status_check CHECK (status IN ('tentative', 'confirmed')),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE
);

-- [23/23] company_holidays
CREATE TABLE IF NOT EXISTS company_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  holiday_date DATE NOT NULL,
  holiday_type VARCHAR(32) NOT NULL DEFAULT 'national',
  mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  UNIQUE (tenant_id, holiday_date)
);

-- ============================================================================
-- 3. Performance & Tenant Scoping Indexes (26 Indexes)
-- ============================================================================

CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants (status);
CREATE INDEX IF NOT EXISTS tenant_domains_tenant_idx ON tenant_domains (tenant_id);
CREATE INDEX IF NOT EXISTS departments_tenant_idx ON departments (tenant_id);
CREATE INDEX IF NOT EXISTS memberships_tenant_status_idx ON memberships (tenant_id, status);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
CREATE INDEX IF NOT EXISTS roles_tenant_idx ON roles (tenant_id);
CREATE INDEX IF NOT EXISTS membership_roles_tenant_member_idx ON membership_roles (tenant_id, membership_id);
CREATE INDEX IF NOT EXISTS reporting_lines_manager_idx ON reporting_lines (tenant_id, manager_membership_id);
CREATE INDEX IF NOT EXISTS reporting_lines_subordinate_idx ON reporting_lines (tenant_id, subordinate_membership_id);
CREATE INDEX IF NOT EXISTS invitations_tenant_email_idx ON invitations (tenant_id, email);
CREATE INDEX IF NOT EXISTS identity_connections_tenant_idx ON identity_connections (tenant_id);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_category_idx ON audit_logs (tenant_id, category);
CREATE INDEX IF NOT EXISTS clients_tenant_idx ON clients (tenant_id);
CREATE INDEX IF NOT EXISTS projects_tenant_idx ON projects (tenant_id);
CREATE INDEX IF NOT EXISTS projects_tenant_pm_idx ON projects (tenant_id, project_manager_membership_id);
CREATE INDEX IF NOT EXISTS project_memberships_member_idx ON project_memberships (tenant_id, membership_id);
CREATE INDEX IF NOT EXISTS timesheets_tenant_status_idx ON timesheets (tenant_id, status);
CREATE INDEX IF NOT EXISTS timesheet_entries_tenant_sheet_idx ON timesheet_entries (tenant_id, timesheet_id);
CREATE INDEX IF NOT EXISTS timesheet_entries_tenant_project_idx ON timesheet_entries (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS leave_requests_tenant_member_idx ON leave_requests (tenant_id, membership_id);
CREATE INDEX IF NOT EXISTS approvals_tenant_target_idx ON approvals (tenant_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS approvals_tenant_status_idx ON approvals (tenant_id, status);
CREATE INDEX IF NOT EXISTS resource_allocations_tenant_date_idx ON resource_allocations (tenant_id, allocation_date);
CREATE INDEX IF NOT EXISTS resource_allocations_tenant_project_idx ON resource_allocations (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS company_holidays_tenant_idx ON company_holidays (tenant_id);

-- ============================================================================
-- 4. Row-Level Security (RLS) Defense-in-Depth (17 Tenant-Scoped Tables)
--    Global/System Tables (6): tenants, users, roles, permissions,
--    role_permissions, subscriptions (deliberately excluded from tenant RLS;
--    governed by authenticated membership & platform-admin guards).
--    Application Role Requirement: NOSUPERUSER NOBYPASSRLS.
--    FORCE ROW LEVEL SECURITY ensures even table-owner connections obey RLS.
-- ============================================================================

ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains FORCE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets FORCE ROW LEVEL SECURITY;
ALTER TABLE timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE company_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_holidays FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_tenant_domains ON tenant_domains;
CREATE POLICY tenant_isolation_tenant_domains ON tenant_domains
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_departments ON departments;
CREATE POLICY tenant_isolation_departments ON departments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_memberships ON memberships;
CREATE POLICY tenant_isolation_memberships ON memberships
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_membership_roles ON membership_roles;
CREATE POLICY tenant_isolation_membership_roles ON membership_roles
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_reporting_lines ON reporting_lines;
CREATE POLICY tenant_isolation_reporting_lines ON reporting_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_invitations ON invitations;
CREATE POLICY tenant_isolation_invitations ON invitations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_identity_connections ON identity_connections;
CREATE POLICY tenant_isolation_identity_connections ON identity_connections
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_clients ON clients;
CREATE POLICY tenant_isolation_clients ON clients
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_projects ON projects;
CREATE POLICY tenant_isolation_projects ON projects
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_project_memberships ON project_memberships;
CREATE POLICY tenant_isolation_project_memberships ON project_memberships
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_timesheets ON timesheets;
CREATE POLICY tenant_isolation_timesheets ON timesheets
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_timesheet_entries ON timesheet_entries;
CREATE POLICY tenant_isolation_timesheet_entries ON timesheet_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_leave_requests ON leave_requests;
CREATE POLICY tenant_isolation_leave_requests ON leave_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_approvals ON approvals;
CREATE POLICY tenant_isolation_approvals ON approvals
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_resource_allocations ON resource_allocations;
CREATE POLICY tenant_isolation_resource_allocations ON resource_allocations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_company_holidays ON company_holidays;
CREATE POLICY tenant_isolation_company_holidays ON company_holidays
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
