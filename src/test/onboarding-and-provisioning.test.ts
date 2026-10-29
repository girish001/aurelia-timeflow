import { describe, expect, it } from "vitest";

import {
  SYSTEM_PERMISSION_CATALOG,
  SYSTEM_ROLE_DEFINITIONS,
  seedSystemRolesIntoStore,
} from "../server/db/seed-system-roles";
import {
  importTeamCsvIntoTenant,
  provisionEnterpriseTenant,
  registerSelfServiceCompany,
  startSupportImpersonationSession,
  verifyCompanyAdminEmail,
} from "../server/onboarding/onboarding-service";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";
import { AuthorizationError, TenantIsolationError } from "../server/tenancy/tenant-context";

describe("Self-Service Onboarding, CSV Team Import & Assisted Enterprise Provisioning", () => {
  it("seeds all 4 default system roles and 20 permission definitions", () => {
    const store = new MultiTenantDataStore();
    const seededRoles = seedSystemRolesIntoStore(store);

    expect(SYSTEM_PERMISSION_CATALOG).toHaveLength(20);
    expect(SYSTEM_ROLE_DEFINITIONS).toHaveLength(4);
    expect(seededRoles.map((r) => r.key)).toEqual([
      "business_admin",
      "manager",
      "team_lead",
      "employee",
    ]);
  });

  it("executes self-service company registration, email verification, and CSV team import with multi-roles and HR reporting lines", () => {
    const store = new MultiTenantDataStore();

    // 1. Register new company in self-service mode
    const reg = registerSelfServiceCompany(store, {
      companyName: "Nova Software Solutions",
      slug: "nova-software",
      adminEmail: "founder@nova-software.io",
      adminFullName: "Ananya Rao",
    });

    expect(reg.tenant.status).toBe("onboarding");
    expect(reg.tenant.onboardingMode).toBe("self_service");
    expect(reg.adminUser.emailVerifiedAt).toBeNull();

    // 2. Verify founding admin email and activate tenant
    const adminCtx = verifyCompanyAdminEmail(store, reg.verificationToken);
    expect(adminCtx.tenant.status).toBe("active");
    expect(adminCtx.user.emailVerifiedAt).not.toBeNull();
    expect(adminCtx.roleKeys.has("business_admin")).toBe(true);

    // 3. Bulk import team via CSV with multiple roles per member and HR reporting hierarchy
    const csv = [
      "email,fullName,jobTitle,department,roles,managerEmail",
      "lead@nova-software.io,Rohan Gupta,Engineering Manager,Engineering,manager;team_lead,founder@nova-software.io",
      "dev1@nova-software.io,Meera Iyer,Senior Engineer,Engineering,employee,lead@nova-software.io",
      "dev2@nova-software.io,Kabir Singh,Backend Developer,Engineering,employee,lead@nova-software.io",
    ].join("\n");

    const importResult = importTeamCsvIntoTenant(store, adminCtx, csv);
    expect(importResult.importedCount).toBe(3);
    expect(importResult.reportingLinesLinked).toBe(3);

    // Verify Rohan Gupta has both manager and team_lead roles and has 2 direct reports (Meera & Kabir)
    const rohanMembership = importResult.memberships[0]!;
    const rohanCtx = store.resolveTenantContext(rohanMembership.userId, adminCtx.tenant.id);
    expect(rohanCtx.roleKeys.has("manager")).toBe(true);
    expect(rohanCtx.roleKeys.has("team_lead")).toBe(true);
    expect(rohanCtx.directReportMembershipIds.size).toBe(2);

    // Verify Meera (employee) cannot run CSV imports
    const meeraMembership = importResult.memberships[1]!;
    const meeraCtx = store.resolveTenantContext(meeraMembership.userId, adminCtx.tenant.id);
    expect(() => importTeamCsvIntoTenant(store, meeraCtx, csv)).toThrow(AuthorizationError);
  });

  it("supports assisted enterprise provisioning, enforces domain autoJoinPolicy=never, and audits platform support impersonation", () => {
    const store = new MultiTenantDataStore();

    const platformAdmin = store.registerUser({
      id: "u_platform_super",
      email: "ops@aurelia-platform.com",
      fullName: "Aurelia Platform Ops",
      emailVerifiedAt: "2026-01-01T00:00:00Z",
      isPlatformAdmin: true,
      status: "active",
    });

    const provisioned = provisionEnterpriseTenant(store, platformAdmin, {
      companyName: "Apex Global Consulting",
      slug: "apex-global",
      primaryDomain: "apex-global.com",
      primaryAdminEmail: "cio@apex-global.com",
      primaryAdminFullName: "Siddharth Malhotra",
    });

    expect(provisioned.tenant.onboardingMode).toBe("assisted_enterprise");
    expect(provisioned.domain.autoJoinPolicy).toBe("never");

    // Uninvited user with @apex-global.com email still cannot auto-join without membership
    store.registerUser({
      id: "u_uninvited_apex",
      email: "stranger@apex-global.com",
      fullName: "Uninvited User",
      emailVerifiedAt: "2026-02-01T00:00:00Z",
      isPlatformAdmin: false,
      status: "active",
    });
    expect(() => store.resolveTenantContext("u_uninvited_apex", provisioned.tenant.id)).toThrow(
      TenantIsolationError,
    );

    // Support impersonation stamps impersonatedByPlatformUserId
    const impersonatedCtx = startSupportImpersonationSession(store, platformAdmin, {
      tenantId: provisioned.tenant.id,
      targetMembershipId: provisioned.adminMembership.id,
      supportTicketId: "SUP-2026-8841",
      reason: "Customer requested assistance configuring project budget thresholds",
    });

    expect(impersonatedCtx.impersonatedByPlatformUserId).toBe("u_platform_super");
    expect(impersonatedCtx.tenant.id).toBe(provisioned.tenant.id);
  });
});
