import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ============================================================================
// 1. Enums
// ============================================================================

export const tenantStatusEnum = pgEnum("tenant_status", [
  "provisioning",
  "onboarding",
  "trial",
  "active",
  "suspended",
  "archived",
]);

export const onboardingModeEnum = pgEnum("onboarding_mode", [
  "self_service",
  "assisted_enterprise",
]);

export const domainAutoJoinPolicyEnum = pgEnum("domain_auto_join_policy", [
  "never",
  "invite_only",
  "sso_verified_only",
]);

export const userStatusEnum = pgEnum("user_status", ["active", "locked", "disabled"]);

export const membershipStatusEnum = pgEnum("membership_status", [
  "invited",
  "active",
  "inactive",
  "offboarded",
]);

export const reportingRelationshipEnum = pgEnum("reporting_relationship_type", [
  "primary_hr",
  "dotted_line",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

export const identityProviderEnum = pgEnum("identity_provider_type", [
  "entra_oidc",
  "google_oidc",
  "saml",
]);

export const identityConnectionStatusEnum = pgEnum("identity_connection_status", [
  "draft",
  "testing",
  "active",
  "disabled",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
]);

export const projectStatusEnum = pgEnum("project_status", ["active", "on-hold", "completed"]);

export const projectMemberRoleEnum = pgEnum("project_member_role", [
  "project_manager",
  "team_lead",
  "contributor",
  "viewer",
]);

export const timesheetStatusEnum = pgEnum("timesheet_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
]);

export const leaveTypeEnum = pgEnum("leave_type", ["annual", "sick", "personal", "unpaid"]);

export const leaveStatusEnum = pgEnum("leave_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export const dayPartEnum = pgEnum("day_part", ["full", "am", "pm"]);

export const allocationStatusEnum = pgEnum("allocation_status", ["tentative", "confirmed"]);

// ============================================================================
// 2. Core Multi-Tenant & Identity Entities
// ============================================================================

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    status: tenantStatusEnum("status").default("provisioning").notNull(),
    onboardingMode: onboardingModeEnum("onboarding_mode").default("self_service").notNull(),
    country: varchar("country", { length: 80 }).default("India").notNull(),
    timezone: varchar("timezone", { length: 64 }).default("Asia/Kolkata").notNull(),
    currency: varchar("currency", { length: 8 }).default("INR").notNull(),
    timeFormat: varchar("time_format", { length: 16 }).default("decimal").notNull(),
    weekStart: varchar("week_start", { length: 16 }).default("monday").notNull(),
    dailyTargetHours: numeric("daily_target_hours", { precision: 4, scale: 2 })
      .default("8.00")
      .notNull(),
    lockApprovedSheets: boolean("lock_approved_sheets").default(true).notNull(),
    requireRejectReason: boolean("require_reject_reason").default(true).notNull(),
    leavePolicyJson: jsonb("leave_policy_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tenants_slug_uq").on(t.slug), index("tenants_status_idx").on(t.status)],
);

export const tenantDomains = pgTable(
  "tenant_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // Security invariant: email domain alone never grants automatic membership.
    autoJoinPolicy: domainAutoJoinPolicyEnum("auto_join_policy").default("never").notNull(),
    verificationTxtToken: varchar("verification_txt_token", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tenant_domains_domain_uq").on(t.domain),
    index("tenant_domains_tenant_idx").on(t.tenantId),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash"),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    avatarUrl: text("avatar_url"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isPlatformAdmin: boolean("is_platform_admin").default(false).notNull(),
    status: userStatusEnum("status").default("active").notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    code: varchar("code", { length: 32 }),
    parentDepartmentId: uuid("parent_department_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("departments_tenant_name_uq").on(t.tenantId, t.name),
    index("departments_tenant_idx").on(t.tenantId),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    employeeCode: varchar("employee_code", { length: 48 }),
    jobTitle: varchar("job_title", { length: 120 }).notNull(),
    status: membershipStatusEnum("status").default("invited").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId),
    index("memberships_tenant_status_idx").on(t.tenantId, t.status),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Null tenantId indicates a system-defined role template; non-null indicates a custom tenant role.
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull(),
    isSystemRole: boolean("is_system_role").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("roles_tenant_key_uq").on(t.tenantId, t.key),
    index("roles_tenant_idx").on(t.tenantId),
  ],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 96 }).notNull(),
    module: varchar("module", { length: 48 }).notNull(),
    description: text("description").notNull(),
  },
  (t) => [uniqueIndex("permissions_code_uq").on(t.code)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedByMembershipId: uuid("assigned_by_membership_id").references(() => memberships.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("membership_roles_member_role_uq").on(t.tenantId, t.membershipId, t.roleId),
    index("membership_roles_tenant_member_idx").on(t.tenantId, t.membershipId),
  ],
);

export const reportingLines = pgTable(
  "reporting_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subordinateMembershipId: uuid("subordinate_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    managerMembershipId: uuid("manager_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    relationshipType: reportingRelationshipEnum("relationship_type")
      .default("primary_hr")
      .notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("reporting_lines_active_uq").on(
      t.tenantId,
      t.subordinateMembershipId,
      t.managerMembershipId,
      t.relationshipType,
    ),
    index("reporting_lines_manager_idx").on(t.tenantId, t.managerMembershipId),
    index("reporting_lines_subordinate_idx").on(t.tenantId, t.subordinateMembershipId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    roleKeysJson: jsonb("role_keys_json").$type<string[]>().notNull(),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    reportingManagerMembershipId: uuid("reporting_manager_membership_id").references(
      () => memberships.id,
      { onDelete: "set null" },
    ),
    invitedByMembershipId: uuid("invited_by_membership_id").references(() => memberships.id, {
      onDelete: "set null",
    }),
    status: invitationStatusEnum("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_uq").on(t.tokenHash),
    index("invitations_tenant_email_idx").on(t.tenantId, t.email),
  ],
);

export const identityConnections = pgTable(
  "identity_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: identityProviderEnum("provider").notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    status: identityConnectionStatusEnum("status").default("draft").notNull(),
    issuerUrl: text("issuer_url").notNull(),
    clientId: varchar("client_id", { length: 255 }),
    metadataXmlUrl: text("metadata_xml_url"),
    ssoEndpoint: text("sso_endpoint"),
    enforceSsoOnly: boolean("enforce_sso_only").default(false).notNull(),
    // Even with JIT enabled, an explicit invitation or verified SSO claim for the tenant is required.
    jitProvisioningEnabled: boolean("jit_provisioning_enabled").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("identity_connections_tenant_idx").on(t.tenantId)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 64 }).notNull(),
    status: subscriptionStatusEnum("status").default("trialing").notNull(),
    seatLimit: integer("seat_limit").default(25).notNull(),
    billingCycle: varchar("billing_cycle", { length: 32 }).default("monthly").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    provisionedByPlatformUserId: uuid("provisioned_by_platform_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("subscriptions_tenant_uq").on(t.tenantId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorMembershipId: uuid("actor_membership_id").references(() => memberships.id, {
      onDelete: "set null",
    }),
    impersonatedByPlatformUserId: uuid("impersonated_by_platform_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    category: varchar("category", { length: 48 }).notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 64 }).notNull(),
    targetId: varchar("target_id", { length: 128 }),
    detailsJson: jsonb("details_json").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_logs_tenant_category_idx").on(t.tenantId, t.category),
  ],
);

// ============================================================================
// 3. Tenant-Owned Business Operational Entities
// ============================================================================

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    contactName: varchar("contact_name", { length: 120 }).notNull(),
    contactEmail: varchar("contact_email", { length: 255 }).notNull(),
    country: varchar("country", { length: 80 }).notNull(),
    billingTerms: varchar("billing_terms", { length: 64 }).default("Net 30").notNull(),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("clients_tenant_idx").on(t.tenantId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 160 }).notNull(),
    projectManagerMembershipId: uuid("project_manager_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    status: projectStatusEnum("status").default("active").notNull(),
    budgetHours: numeric("budget_hours", { precision: 10, scale: 2 }).notNull(),
    billableRate: numeric("billable_rate", { precision: 12, scale: 2 }).notNull(),
    tasksJson: jsonb("tasks_json").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("projects_tenant_idx").on(t.tenantId),
    index("projects_tenant_pm_idx").on(t.tenantId, t.projectManagerMembershipId),
  ],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    projectRole: projectMemberRoleEnum("project_role").default("contributor").notNull(),
    canApproveTimesheets: boolean("can_approve_timesheets").default(false).notNull(),
    canManageAllocations: boolean("can_manage_allocations").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("project_memberships_uq").on(t.tenantId, t.projectId, t.membershipId),
    index("project_memberships_member_idx").on(t.tenantId, t.membershipId),
  ],
);

export const timesheets = pgTable(
  "timesheets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    weekStart: date("week_start").notNull(),
    status: timesheetStatusEnum("status").default("draft").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByMembershipId: uuid("reviewed_by_membership_id").references(() => memberships.id, {
      onDelete: "set null",
    }),
    reviewComment: text("review_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("timesheets_tenant_member_week_uq").on(t.tenantId, t.membershipId, t.weekStart),
    index("timesheets_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const timesheetEntries = pgTable(
  "timesheet_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    timesheetId: uuid("timesheet_id")
      .notNull()
      .references(() => timesheets.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    taskName: varchar("task_name", { length: 120 }).notNull(),
    hoursByDayJson: jsonb("hours_by_day_json").$type<number[]>().notNull(),
    billable: boolean("billable").default(true).notNull(),
    notes: text("notes").default("").notNull(),
  },
  (t) => [
    index("timesheet_entries_tenant_sheet_idx").on(t.tenantId, t.timesheetId),
    index("timesheet_entries_tenant_project_idx").on(t.tenantId, t.projectId),
  ],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    type: leaveTypeEnum("type").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    partial: dayPartEnum("partial").default("full").notNull(),
    reason: text("reason").default("").notNull(),
    status: leaveStatusEnum("status").default("pending").notNull(),
    reviewedByMembershipId: uuid("reviewed_by_membership_id").references(() => memberships.id, {
      onDelete: "set null",
    }),
    reviewComment: text("review_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("leave_requests_tenant_member_idx").on(t.tenantId, t.membershipId)],
);

export const resourceAllocations = pgTable(
  "resource_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    allocationDate: date("allocation_date").notNull(),
    hours: numeric("hours", { precision: 4, scale: 2 }).notNull(),
    status: allocationStatusEnum("status").default("confirmed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("resource_allocations_tenant_date_idx").on(t.tenantId, t.allocationDate),
    index("resource_allocations_tenant_project_idx").on(t.tenantId, t.projectId),
  ],
);

export const companyHolidays = pgTable(
  "company_holidays",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    holidayDate: date("holiday_date").notNull(),
    holidayType: varchar("holiday_type", { length: 32 }).default("national").notNull(),
    mandatory: boolean("mandatory").default(true).notNull(),
    description: text("description"),
  },
  (t) => [
    uniqueIndex("company_holidays_tenant_date_uq").on(t.tenantId, t.holidayDate),
    index("company_holidays_tenant_idx").on(t.tenantId),
  ],
);
