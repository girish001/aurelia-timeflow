import { beforeEach, describe, expect, it } from "vitest";
import { MultiTenantDataStore } from "@/server/repositories/tenant-scoped-store";
import { AuthorizationError, TenantIsolationError } from "@/server/tenancy/tenant-context";
import * as schema from "@/server/db/schema";

describe("Multi-Tenant SaaS Architecture: Isolation, Membership & RBAC/ABAC", () => {
  let store: MultiTenantDataStore;

  beforeEach(() => {
    store = new MultiTenantDataStore();

    // Provision two isolated company tenants: Acme Corp (tenant_acme) & Globex Ltd (tenant_globex)
    store.registerTenant({
      id: "tenant_acme",
      slug: "acme-corp",
      name: "Acme Consulting Pvt Ltd",
      status: "active",
      onboardingMode: "self_service",
    });

    store.registerTenant({
      id: "tenant_globex",
      slug: "globex-ltd",
      name: "Globex Enterprise Solutions",
      status: "active",
      onboardingMode: "assisted_enterprise",
    });

    // Register verified domain for Acme (with autoJoinPolicy: 'never')
    store.registerTenantDomain({
      id: "dom_acme",
      tenantId: "tenant_acme",
      domain: "acme.example.com",
      verifiedAt: "2026-10-01T00:00:00Z",
      autoJoinPolicy: "never",
    });
  });

  it("exposes Drizzle ORM PostgreSQL schema tables with tenant_id foreign keys", () => {
    expect(schema.tenants).toBeDefined();
    expect(schema.tenantDomains).toBeDefined();
    expect(schema.users).toBeDefined();
    expect(schema.memberships).toBeDefined();
    expect(schema.roles).toBeDefined();
    expect(schema.permissions).toBeDefined();
    expect(schema.membershipRoles).toBeDefined();
    expect(schema.departments).toBeDefined();
    expect(schema.reportingLines).toBeDefined();
    expect(schema.invitations).toBeDefined();
    expect(schema.identityConnections).toBeDefined();
    expect(schema.subscriptions).toBeDefined();
    expect(schema.auditLogs).toBeDefined();
  });

  it("1. prevents a user in Tenant A from accessing or mutating Tenant B records (cross-tenant isolation)", () => {
    store.registerUser({
      id: "u_acme_admin",
      email: "admin@acme.example.com",
      fullName: "Acme Admin",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_globex_admin",
      email: "admin@globex.example.com",
      fullName: "Globex Admin",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });

    store.createMembership({
      id: "mem_acme_admin",
      tenantId: "tenant_acme",
      userId: "u_acme_admin",
      jobTitle: "VP Operations",
      status: "active",
    });
    store.assignRoleToMembership({
      id: "mr_1",
      tenantId: "tenant_acme",
      membershipId: "mem_acme_admin",
      roleId: "sys_business_admin",
      roleKey: "business_admin",
    });

    store.createMembership({
      id: "mem_globex_admin",
      tenantId: "tenant_globex",
      userId: "u_globex_admin",
      jobTitle: "Managing Director",
      status: "active",
    });
    store.assignRoleToMembership({
      id: "mr_2",
      tenantId: "tenant_globex",
      membershipId: "mem_globex_admin",
      roleId: "sys_business_admin",
      roleKey: "business_admin",
    });

    store.createProject({
      id: "proj_globex_secret",
      tenantId: "tenant_globex",
      clientId: "client_globex_1",
      name: "Globex M&A Integration",
      projectManagerMembershipId: "mem_globex_admin",
      status: "active",
      budgetHours: 2000,
      billableRate: 4500,
    });

    const acmeCtx = store.resolveTenantContext("u_acme_admin", "tenant_acme");

    // Acme Business Admin cannot view or update Globex's project or member
    expect(() => store.getProjectById(acmeCtx, "proj_globex_secret")).toThrow(TenantIsolationError);
    expect(() => store.updateProjectBudget(acmeCtx, "proj_globex_secret", 500)).toThrow(
      TenantIsolationError,
    );
    expect(() => store.getTeamMemberProfile(acmeCtx, "mem_globex_admin")).toThrow(
      TenantIsolationError,
    );
    expect(store.listVisibleProjects(acmeCtx)).toHaveLength(0);
  });

  it("2. requires an explicit active company membership for access (email domain alone never grants access)", () => {
    // User has @acme.example.com email matching Acme's verified domain, but NO membership record
    store.registerUser({
      id: "u_uninvited_acme_email",
      email: "stranger@acme.example.com",
      fullName: "Uninvited Domain User",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });

    expect(() => store.resolveTenantContext("u_uninvited_acme_email", "tenant_acme")).toThrow(
      TenantIsolationError,
    );

    // Even if invited, a membership in 'invited' status cannot access the tenant until activated
    store.createMembership({
      id: "mem_invited_only",
      tenantId: "tenant_acme",
      userId: "u_uninvited_acme_email",
      jobTitle: "Consultant",
      status: "invited",
    });

    expect(() => store.resolveTenantContext("u_uninvited_acme_email", "tenant_acme")).toThrow(
      TenantIsolationError,
    );
  });

  it("3. prevents a manager from accessing unauthorized teams outside their reporting hierarchy", () => {
    store.registerUser({
      id: "u_mgr_a",
      email: "mgr.a@acme.example.com",
      fullName: "Manager Alpha",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_emp_a",
      email: "emp.a@acme.example.com",
      fullName: "Employee Alpha",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_emp_b",
      email: "emp.b@acme.example.com",
      fullName: "Employee Beta (Other Team)",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });

    store.createMembership({
      id: "mem_mgr_a",
      tenantId: "tenant_acme",
      userId: "u_mgr_a",
      jobTitle: "Engineering Manager",
      status: "active",
    });
    store.createMembership({
      id: "mem_emp_a",
      tenantId: "tenant_acme",
      userId: "u_emp_a",
      jobTitle: "Developer",
      status: "active",
    });
    store.createMembership({
      id: "mem_emp_b",
      tenantId: "tenant_acme",
      userId: "u_emp_b",
      jobTitle: "Designer (Team B)",
      status: "active",
    });

    store.assignRoleToMembership({
      id: "mr_mgr_a",
      tenantId: "tenant_acme",
      membershipId: "mem_mgr_a",
      roleId: "sys_manager",
      roleKey: "manager",
    });

    // Only mem_emp_a reports to mem_mgr_a
    store.addReportingLine({
      id: "rl_1",
      tenantId: "tenant_acme",
      managerMembershipId: "mem_mgr_a",
      subordinateMembershipId: "mem_emp_a",
      relationshipType: "primary_hr",
    });

    const mgrCtx = store.resolveTenantContext("u_mgr_a", "tenant_acme");

    // Can access own profile and direct report (mem_emp_a)
    expect(store.getTeamMemberProfile(mgrCtx, "mem_mgr_a").id).toBe("mem_mgr_a");
    expect(store.getTeamMemberProfile(mgrCtx, "mem_emp_a").id).toBe("mem_emp_a");

    // Cannot access mem_emp_b (outside reporting line)
    expect(() => store.getTeamMemberProfile(mgrCtx, "mem_emp_b")).toThrow(AuthorizationError);

    const visibleTeamIds = store.listAccessibleTeamMembers(mgrCtx).map((m) => m.id);
    expect(visibleTeamIds).toEqual(["mem_mgr_a", "mem_emp_a"]);
  });

  it("4. enforces project-level permissions: a project manager can manage assigned projects (even without HR reports) and cannot access unauthorized projects", () => {
    store.registerUser({
      id: "u_pm_1",
      email: "pm1@acme.example.com",
      fullName: "Delivery Lead 1",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_pm_2",
      email: "pm2@acme.example.com",
      fullName: "Delivery Lead 2",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });

    store.createMembership({
      id: "mem_pm_1",
      tenantId: "tenant_acme",
      userId: "u_pm_1",
      jobTitle: "Project Lead",
      status: "active",
    });
    store.createMembership({
      id: "mem_pm_2",
      tenantId: "tenant_acme",
      userId: "u_pm_2",
      jobTitle: "Project Lead",
      status: "active",
    });

    // Note: mem_pm_1 has employee role + project_manager assignment on proj_1, and ZERO HR direct reports
    store.assignRoleToMembership({
      id: "mr_pm_1",
      tenantId: "tenant_acme",
      membershipId: "mem_pm_1",
      roleId: "sys_employee",
      roleKey: "employee",
    });

    store.createProject({
      id: "proj_1",
      tenantId: "tenant_acme",
      clientId: "c_1",
      name: "Cloud Migration",
      projectManagerMembershipId: "mem_pm_1",
      status: "active",
      budgetHours: 1000,
      billableRate: 3000,
    });

    store.createProject({
      id: "proj_2_unassigned",
      tenantId: "tenant_acme",
      clientId: "c_1",
      name: "Core Banking Audit",
      projectManagerMembershipId: "mem_pm_2",
      status: "active",
      budgetHours: 800,
      billableRate: 3500,
    });

    const pm1Ctx = store.resolveTenantContext("u_pm_1", "tenant_acme");
    expect(pm1Ctx.directReportMembershipIds.size).toBe(0);

    // PM1 can view and manage proj_1 despite having 0 HR direct reports
    expect(store.getProjectById(pm1Ctx, "proj_1").name).toBe("Cloud Migration");
    const updated = store.updateProjectBudget(pm1Ctx, "proj_1", 1250);
    expect(updated.budgetHours).toBe(1250);

    // PM1 cannot view or manage proj_2_unassigned
    expect(() => store.getProjectById(pm1Ctx, "proj_2_unassigned")).toThrow(AuthorizationError);
    expect(() => store.updateProjectBudget(pm1Ctx, "proj_2_unassigned", 900)).toThrow(
      AuthorizationError,
    );
  });

  it("5. supports assigning multiple simultaneous roles (including custom roles) to a single user membership", () => {
    store.registerUser({
      id: "u_hybrid",
      email: "hybrid@acme.example.com",
      fullName: "Hybrid Player-Coach",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });

    store.createMembership({
      id: "mem_hybrid",
      tenantId: "tenant_acme",
      userId: "u_hybrid",
      jobTitle: "Principal Architect & Practice Lead",
      status: "active",
    });

    // Custom tenant role for Finance/Audit Reviewer
    store.registerCustomRole({
      id: "role_custom_auditor",
      tenantId: "tenant_acme",
      key: "compliance_auditor",
      name: "Compliance Auditor",
      permissions: ["audit:read:tenant", "report:read:tenant"],
      isSystemRole: false,
    });

    // Assign Employee + Manager + Custom Compliance Auditor simultaneously
    store.assignRoleToMembership({
      id: "mr_h1",
      tenantId: "tenant_acme",
      membershipId: "mem_hybrid",
      roleId: "sys_employee",
      roleKey: "employee",
    });
    store.assignRoleToMembership({
      id: "mr_h2",
      tenantId: "tenant_acme",
      membershipId: "mem_hybrid",
      roleId: "sys_manager",
      roleKey: "manager",
    });
    store.assignRoleToMembership({
      id: "mr_h3",
      tenantId: "tenant_acme",
      membershipId: "mem_hybrid",
      roleId: "role_custom_auditor",
      roleKey: "compliance_auditor",
    });

    const ctx = store.resolveTenantContext("u_hybrid", "tenant_acme");

    expect(ctx.roleKeys.has("employee")).toBe(true);
    expect(ctx.roleKeys.has("manager")).toBe(true);
    expect(ctx.roleKeys.has("compliance_auditor")).toBe(true);

    // Combined permissions from all three roles
    expect(ctx.permissions.has("timesheet:submit:own")).toBe(true);
    expect(ctx.permissions.has("timesheet:approve:team")).toBe(true);
    expect(ctx.permissions.has("audit:read:tenant")).toBe(true);
    expect(store.listTenantAuditLogs(ctx)).toEqual([]);
  });

  it("6. supports a single user belonging to multiple companies with distinct roles and isolated contexts", () => {
    store.registerUser({
      id: "u_advisor",
      email: "advisor@consulting.example.com",
      fullName: "Fractional CTO Advisor",
      emailVerifiedAt: "2026-10-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });

    // Membership 1: Business Admin at Acme Corp
    store.createMembership({
      id: "mem_advisor_acme",
      tenantId: "tenant_acme",
      userId: "u_advisor",
      jobTitle: "Fractional CTO",
      status: "active",
    });
    store.assignRoleToMembership({
      id: "mr_adv_acme",
      tenantId: "tenant_acme",
      membershipId: "mem_advisor_acme",
      roleId: "sys_business_admin",
      roleKey: "business_admin",
    });

    // Membership 2: External Employee Contributor at Globex Ltd
    store.createMembership({
      id: "mem_advisor_globex",
      tenantId: "tenant_globex",
      userId: "u_advisor",
      jobTitle: "External Security Specialist",
      status: "active",
    });
    store.assignRoleToMembership({
      id: "mr_adv_globex",
      tenantId: "tenant_globex",
      membershipId: "mem_advisor_globex",
      roleId: "sys_employee",
      roleKey: "employee",
    });

    const memberships = store.listUserTenants("u_advisor");
    expect(memberships).toHaveLength(2);

    const acmeCtx = store.resolveTenantContext("u_advisor", "tenant_acme");
    const globexCtx = store.resolveTenantContext("u_advisor", "tenant_globex");

    // In Acme, user is a Business Admin
    expect(acmeCtx.roleKeys.has("business_admin")).toBe(true);
    expect(acmeCtx.permissions.has("tenant:settings:manage")).toBe(true);

    // In Globex, the exact same user is only an Employee (no admin permissions)
    expect(globexCtx.roleKeys.has("business_admin")).toBe(false);
    expect(globexCtx.roleKeys.has("employee")).toBe(true);
    expect(globexCtx.permissions.has("tenant:settings:manage")).toBe(false);

    // Cannot use Acme admin context to access Globex member profile
    expect(() => store.getTeamMemberProfile(acmeCtx, "mem_advisor_globex")).toThrow(
      TenantIsolationError,
    );
  });
});
