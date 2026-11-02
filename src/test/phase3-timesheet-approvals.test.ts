// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { handleApiRequest } from "../server/api/routes";
import { hashPassword } from "../server/auth/password";
import { defaultSessionManager } from "../server/auth/session-manager";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";
import type {
  MembershipRecord,
  ProjectRecord,
  TenantRecord,
  UserRecord,
} from "../server/tenancy/tenant-context";

describe("Phase 3: Real Authentication, Timesheets & Approvals End-to-End Workflow", () => {
  let store: MultiTenantDataStore;

  const tenantA: TenantRecord = {
    id: "t_tenant_alpha",
    name: "Alpha Dynamics",
    slug: "alpha-dynamics",
    status: "active",
    onboardingMode: "assisted_enterprise",
  };

  const tenantB: TenantRecord = {
    id: "t_tenant_beta",
    name: "Beta Global",
    slug: "beta-global",
    status: "active",
    onboardingMode: "assisted_enterprise",
  };

  // User 1: Business Admin in Tenant A
  const adminUser: UserRecord = {
    id: "usr_admin_01",
    email: "admin@alpha.com",
    fullName: "Alpha Admin",
    status: "active",
    isPlatformAdmin: false,
    emailVerifiedAt: "2026-03-01T00:00:00.000Z",
  };

  // User 2: Manager in Tenant A
  const managerUser: UserRecord = {
    id: "usr_mgr_01",
    email: "manager@alpha.com",
    fullName: "Alpha Manager",
    status: "active",
    isPlatformAdmin: false,
    emailVerifiedAt: "2026-03-01T00:00:00.000Z",
  };

  // User 3: Employee in Tenant A
  const employeeUser: UserRecord = {
    id: "usr_emp_01",
    email: "engineer@alpha.com",
    fullName: "Alpha Engineer",
    status: "active",
    isPlatformAdmin: false,
    emailVerifiedAt: "2026-03-01T00:00:00.000Z",
  };

  // User 4: Attacker in Tenant B
  const tenantBUser: UserRecord = {
    id: "usr_beta_01",
    email: "intruder@beta.com",
    fullName: "Beta Attacker",
    status: "active",
    isPlatformAdmin: false,
    emailVerifiedAt: "2026-03-01T00:00:00.000Z",
  };

  const adminMember: MembershipRecord = {
    id: "mem_admin_01",
    tenantId: tenantA.id,
    userId: adminUser.id,
    jobTitle: "CTO & Co-Founder",
    status: "active",
  };

  const managerMember: MembershipRecord = {
    id: "mem_mgr_01",
    tenantId: tenantA.id,
    userId: managerUser.id,
    jobTitle: "Engineering Manager",
    status: "active",
  };

  const employeeMember: MembershipRecord = {
    id: "mem_emp_01",
    tenantId: tenantA.id,
    userId: employeeUser.id,
    jobTitle: "Senior Software Engineer",
    status: "active",
  };

  const betaMember: MembershipRecord = {
    id: "mem_beta_01",
    tenantId: tenantB.id,
    userId: tenantBUser.id,
    jobTitle: "Operations",
    status: "active",
  };

  const projectAlpha: ProjectRecord = {
    id: "proj_alpha_01",
    tenantId: tenantA.id,
    clientId: "client_alpha_01",
    name: "Aurelia Platform Core",
    projectManagerMembershipId: managerMember.id,
    budgetHours: 1200,
    billableRate: 150,
    status: "active",
  };

  let adminSessionToken: string;
  let managerSessionToken: string;
  let employeeSessionToken: string;
  let betaSessionToken: string;

  beforeEach(async () => {
    store = new MultiTenantDataStore();

    store.registerTenant(tenantA);
    store.registerTenant(tenantB);

    const defaultHash = await hashPassword("AlphaPass123!");
    const betaHash = await hashPassword("BetaPass123!");

    // Register users & passwords
    store.registerUser(adminUser, defaultHash);
    store.registerUser(managerUser, defaultHash);
    store.registerUser(employeeUser, defaultHash);
    store.registerUser(tenantBUser, betaHash);

    // Memberships
    store.createMembership(adminMember);
    store.createMembership(managerMember);
    store.createMembership(employeeMember);
    store.createMembership(betaMember);

    // Roles
    store.assignRoleToMembership({
      tenantId: tenantA.id,
      membershipId: adminMember.id,
      roleKey: "business_admin",
    });
    store.assignRoleToMembership({
      tenantId: tenantA.id,
      membershipId: managerMember.id,
      roleKey: "manager",
    });
    store.assignRoleToMembership({
      tenantId: tenantA.id,
      membershipId: employeeMember.id,
      roleKey: "employee",
    });
    store.assignRoleToMembership({
      tenantId: tenantB.id,
      membershipId: betaMember.id,
      roleKey: "business_admin",
    });

    // HR reporting line: employee reports to manager
    store.addReportingLine({
      id: "rep_line_01",
      tenantId: tenantA.id,
      subordinateMembershipId: employeeMember.id,
      managerMembershipId: managerMember.id,
      relationshipType: "primary_hr",
    });

    // Project
    store.createProject(projectAlpha);
    store.addProjectMembership({
      id: "pm_01",
      tenantId: tenantA.id,
      projectId: projectAlpha.id,
      membershipId: managerMember.id,
      projectRole: "project_manager",
      canManageAllocations: true,
      canApproveTimesheets: true,
    });
    store.addProjectMembership({
      id: "pm_02",
      tenantId: tenantA.id,
      projectId: projectAlpha.id,
      membershipId: employeeMember.id,
      projectRole: "contributor",
      canManageAllocations: false,
      canApproveTimesheets: false,
    });

    // Sessions
    adminSessionToken = defaultSessionManager.createSession(adminUser.id, adminUser.email).rawToken;
    managerSessionToken = defaultSessionManager.createSession(
      managerUser.id,
      managerUser.email,
    ).rawToken;
    employeeSessionToken = defaultSessionManager.createSession(
      employeeUser.id,
      employeeUser.email,
    ).rawToken;
    betaSessionToken = defaultSessionManager.createSession(
      tenantBUser.id,
      tenantBUser.email,
    ).rawToken;
  });

  describe("1. Real Authentication Flow", () => {
    it("authenticates valid credentials via /api/v1/auth/login and returns memberships", async () => {
      const loginReq = new Request("http://localhost:3000/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "engineer@alpha.com",
          password: "AlphaPass123!",
        }),
      });

      const res = (await handleApiRequest(loginReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.authenticated).toBe(true);
      expect(data.user.email).toBe("engineer@alpha.com");
      expect(data.tenants).toBeDefined();
      expect(data.tenants.length).toBeGreaterThan(0);
      expect(data.tenants[0].tenant.id).toBe(tenantA.id);

      // Verifies HttpOnly session cookie is set
      const cookieHeader = res.headers.get("set-cookie");
      expect(cookieHeader).toContain("aurelia_session=");
      expect(cookieHeader?.toLowerCase()).toContain("httponly");
    });

    it("rejects invalid password with 401 UNAUTHENTICATED", async () => {
      const loginReq = new Request("http://localhost:3000/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "engineer@alpha.com",
          password: "WrongPassword999!",
        }),
      });

      const res = (await handleApiRequest(loginReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("UNAUTHENTICATED");
    });

    it("validates authenticated session via /api/v1/auth/session", async () => {
      const sessionReq = new Request("http://localhost:3000/api/v1/auth/session", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${employeeSessionToken}`,
        },
      });

      const res = (await handleApiRequest(sessionReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.authenticated).toBe(true);
      expect(data.session.userId).toBe(employeeUser.id);
      expect(data.user.email).toBe(employeeUser.email);
    });

    it("logs out and clears session cookie via /api/v1/auth/logout", async () => {
      const logoutReq = new Request("http://localhost:3000/api/v1/auth/logout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${employeeSessionToken}`,
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      const res = (await handleApiRequest(logoutReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const cookieHeader = res.headers.get("set-cookie");
      expect(cookieHeader).toContain("Max-Age=0");
    });
  });

  describe("2. Timesheet Save Draft, Validation & Submission Lifecycle", () => {
    const weekKey = "2026-03-02";

    it("creates a draft timesheet and retrieves it for the specified week", async () => {
      const draftReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: [
              {
                projectId: projectAlpha.id,
                taskName: "Database Performance Tuning",
                hoursByDay: [8, 8, 8, 7.5, 8, 0, 0],
                billable: true,
                notes: "Optimized connection pooling and indexes",
              },
            ],
          }),
        },
      );

      const res = (await handleApiRequest(draftReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.timesheet).toBeDefined();
      expect(data.timesheet.status).toBe("draft");
      expect(data.timesheet.weekStart).toBe(weekKey);
      expect(data.timesheet.totalHours).toBe(39.5);
      expect(data.timesheet.entries.length).toBe(1);

      // Verify GET endpoint returns the same saved draft
      const getReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
          },
        },
      );

      const getRes = (await handleApiRequest(getReq, { store }))!;
      expect(getRes).not.toBeNull();
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.timesheet.totalHours).toBe(39.5);
    });

    it("rejects timesheet entry when total daily hours exceed 24 hours", async () => {
      const invalidReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: [
              {
                projectId: projectAlpha.id,
                taskName: "Impossible Overtime",
                hoursByDay: [25, 8, 8, 8, 8, 0, 0], // Day 1 = 25h
                billable: true,
              },
            ],
          }),
        },
      );

      const res = (await handleApiRequest(invalidReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.message).toContain("24 hours");
    });

    it("allows employee to submit draft timesheet for manager approval", async () => {
      // 1. Save draft
      const draftReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: [
              {
                projectId: projectAlpha.id,
                taskName: "API Implementation",
                hoursByDay: [8, 8, 8, 8, 8, 0, 0],
                billable: true,
              },
            ],
          }),
        },
      );
      const draftRes = (await handleApiRequest(draftReq, { store }))!;
      const { timesheet } = await draftRes.json();

      // 2. Submit timesheet
      const submitReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheet.id}/submit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      const submitRes = (await handleApiRequest(submitReq, { store }))!;
      expect(submitRes).not.toBeNull();
      expect(submitRes.status).toBe(200);

      const submitted = await submitRes.json();
      expect(submitted.timesheet.status).toBe("submitted");
      expect(submitted.timesheet.submittedAt).toBeDefined();

      // 3. Attempting to edit a submitted timesheet must be blocked
      const reEditReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: [
              {
                projectId: projectAlpha.id,
                taskName: "Unauthorized Edit After Submit",
                hoursByDay: [1, 1, 1, 1, 1, 0, 0],
              },
            ],
          }),
        },
      );
      const reEditRes = (await handleApiRequest(reEditReq, { store }))!;
      expect(reEditRes).not.toBeNull();
      expect(reEditRes.status).toBe(400);
      const reEditData = await reEditRes.json();
      expect(reEditData.message).toContain("submitted");
    });
  });

  describe("3. Manager Approvals, Rejections & Resubmission Cycle", () => {
    const weekKey = "2026-03-09";
    let timesheetId: string;

    beforeEach(async () => {
      // Create and submit a timesheet for employee
      const draftReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: [
              {
                projectId: projectAlpha.id,
                taskName: "Core Architecture Refactoring",
                hoursByDay: [8, 8, 8, 8, 8, 0, 0],
                billable: true,
              },
            ],
          }),
        },
      );
      const draftRes = (await handleApiRequest(draftReq, { store }))!;
      const { timesheet } = await draftRes.json();
      timesheetId = timesheet.id;

      const submitReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheetId}/submit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      await handleApiRequest(submitReq, { store });
    });

    it("lists submitted timesheets in manager's pending approvals queue", async () => {
      const apprReq = new Request(`http://localhost:3000/api/v1/tenants/${tenantA.id}/approvals`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${managerSessionToken}`,
        },
      });

      const res = (await handleApiRequest(apprReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.pending).toBeDefined();
      expect(data.pending.length).toBe(1);
      expect(data.pending[0].timesheetId).toBe(timesheetId);
      expect(data.pending[0].totalHours).toBe(40);
      expect(data.pending[0].memberName).toBe(employeeUser.fullName);
    });

    it("rejects timesheet approval with validation error when rejection comment is missing", async () => {
      const rejectReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheetId}/reject`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${managerSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            comment: "", // empty comment
          }),
        },
      );

      const res = (await handleApiRequest(rejectReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("VALIDATION_ERROR");
      expect(data.message).toContain("comment");
    });

    it("allows manager to reject timesheet with valid reason, allowing employee to resubmit", async () => {
      // 1. Manager rejects
      const rejectReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheetId}/reject`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${managerSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            comment: "Please specify task breakdown for Thursday client presentation.",
          }),
        },
      );

      const rejectRes = (await handleApiRequest(rejectReq, { store }))!;
      expect(rejectRes).not.toBeNull();
      expect(rejectRes.status).toBe(200);
      const rejected = await rejectRes.json();
      expect(rejected.timesheet.status).toBe("rejected");

      // 2. Employee can now update the rejected timesheet
      const updateReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/${weekKey}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: [
              {
                projectId: projectAlpha.id,
                taskName: "Core Architecture Refactoring & Client Presentation Prep",
                hoursByDay: [8, 8, 8, 8, 8, 0, 0],
                billable: true,
                notes: "Updated breakdown as requested",
              },
            ],
          }),
        },
      );
      const updateRes = (await handleApiRequest(updateReq, { store }))!;
      expect(updateRes).not.toBeNull();
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.timesheet.status).toBe("draft");

      // 3. Employee resubmits
      const resubmitReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheetId}/submit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      const resubmitRes = (await handleApiRequest(resubmitReq, { store }))!;
      expect(resubmitRes).not.toBeNull();
      expect(resubmitRes.status).toBe(200);

      // 4. Manager approves
      const approveReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheetId}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${managerSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ comment: "Looks great, approved!" }),
        },
      );
      const approveRes = (await handleApiRequest(approveReq, { store }))!;
      expect(approveRes).not.toBeNull();
      expect(approveRes.status).toBe(200);
      const approved = await approveRes.json();
      expect(approved.timesheet.status).toBe("approved");

      // 5. Approvals list should now have 0 pending
      const checkPendingReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/approvals`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${managerSessionToken}`,
          },
        },
      );
      const checkPendingRes = (await handleApiRequest(checkPendingReq, { store }))!;
      expect(checkPendingRes).not.toBeNull();
      const pendingData = await checkPendingRes.json();
      expect(pendingData.pending.length).toBe(0);
      expect(pendingData.history.length).toBeGreaterThan(0);
    });

    it("strictly prohibits self-approval and self-rejection", async () => {
      // Employee attempts to approve own submitted timesheet
      const selfApproveReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/${timesheetId}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${employeeSessionToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      const res = (await handleApiRequest(selfApproveReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(403);
    });
  });

  describe("4. Multi-Tenant Isolation & Role-Based Authorization", () => {
    it("blocks cross-tenant access to timesheets with 403 TenantIsolationError", async () => {
      // User from Tenant B attempts to read timesheet in Tenant A
      const crossTenantReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/timesheets/week/2026-03-02`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${betaSessionToken}`,
          },
        },
      );

      const res = (await handleApiRequest(crossTenantReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("TENANT_ISOLATION_VIOLATION");
    });

    it("blocks cross-tenant approval actions", async () => {
      const crossTenantApprReq = new Request(
        `http://localhost:3000/api/v1/tenants/${tenantA.id}/approvals`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${betaSessionToken}`,
          },
        },
      );

      const res = (await handleApiRequest(crossTenantApprReq, { store }))!;
      expect(res).not.toBeNull();
      expect(res.status).toBe(403);
    });
  });
});
