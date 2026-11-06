import { beforeEach, describe, expect, it } from "vitest";

import { handleApiRequest } from "../server/api/routes";
import { defaultAuthService } from "../server/auth/auth-service";
import { defaultSessionManager } from "../server/auth/session-manager";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";
import type { ResolvedTenantContext } from "../server/tenancy/tenant-context";

describe("SaaS Business Readiness & Multi-Tenant Operations", () => {
  let store: MultiTenantDataStore;
  let adminCtx: ResolvedTenantContext;
  let managerCtx: ResolvedTenantContext;
  let employeeCtx: ResolvedTenantContext;
  let tenantBAdminCtx: ResolvedTenantContext;

  let adminSessionToken: string;
  let managerSessionToken: string;
  let employeeSessionToken: string;
  let tenantBAdminSessionToken: string;

  beforeEach(async () => {
    store = new MultiTenantDataStore();

    // Tenant A (Aurelia Tech)
    store.registerTenant({
      id: "t_aurelia",
      name: "Aurelia Business Services",
      slug: "aurelia-tech",
      status: "active",
      onboardingMode: "self_service",
    });

    // Tenant B (Competitor Inc)
    store.registerTenant({
      id: "t_competitor",
      name: "Competitor Corp",
      slug: "competitor-corp",
      status: "active",
      onboardingMode: "self_service",
    });

    // Users
    store.registerUser({
      id: "u_admin",
      email: "admin@aurelia.com",
      fullName: "Ananya Admin",
      emailVerifiedAt: new Date().toISOString(),
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_mgr",
      email: "manager@aurelia.com",
      fullName: "Rohan Manager",
      emailVerifiedAt: new Date().toISOString(),
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_emp",
      email: "employee@aurelia.com",
      fullName: "Dev Employee",
      emailVerifiedAt: new Date().toISOString(),
      isPlatformAdmin: false,
      status: "active",
    });
    store.registerUser({
      id: "u_tenant_b_admin",
      email: "admin@competitor.com",
      fullName: "Bob Competitor",
      emailVerifiedAt: new Date().toISOString(),
      isPlatformAdmin: false,
      status: "active",
    });

    // Memberships
    store.createMembership({
      id: "m_admin",
      tenantId: "t_aurelia",
      userId: "u_admin",
      jobTitle: "Business Admin",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: "t_aurelia",
      membershipId: "m_admin",
      roleKey: "business_admin",
    });

    store.createMembership({
      id: "m_mgr",
      tenantId: "t_aurelia",
      userId: "u_mgr",
      jobTitle: "Project Manager",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: "t_aurelia",
      membershipId: "m_mgr",
      roleKey: "manager",
    });

    store.createMembership({
      id: "m_emp",
      tenantId: "t_aurelia",
      userId: "u_emp",
      jobTitle: "Senior Software Engineer",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: "t_aurelia",
      membershipId: "m_emp",
      roleKey: "employee",
    });

    // HR reporting line: Dev Employee reports to Rohan Manager
    store.registerReportingLine({
      id: "rl_1",
      tenantId: "t_aurelia",
      managerMembershipId: "m_mgr",
      subordinateMembershipId: "m_emp",
      relationshipType: "primary_hr",
    });

    // Tenant B Membership
    store.createMembership({
      id: "m_b_admin",
      tenantId: "t_competitor",
      userId: "u_tenant_b_admin",
      jobTitle: "Company Admin",
      status: "active",
    });
    store.assignRoleToMembership({
      tenantId: "t_competitor",
      membershipId: "m_b_admin",
      roleKey: "business_admin",
    });

    // Sessions
    adminSessionToken = defaultSessionManager.createSession(
      "u_admin",
      "admin@aurelia.com",
    ).rawToken;

    managerSessionToken = defaultSessionManager.createSession(
      "u_mgr",
      "manager@aurelia.com",
    ).rawToken;

    employeeSessionToken = defaultSessionManager.createSession(
      "u_emp",
      "employee@aurelia.com",
    ).rawToken;

    tenantBAdminSessionToken = defaultSessionManager.createSession(
      "u_tenant_b_admin",
      "admin@competitor.com",
    ).rawToken;

    adminCtx = store.resolveTenantContext("u_admin", "t_aurelia");
    managerCtx = store.resolveTenantContext("u_mgr", "t_aurelia");
    employeeCtx = store.resolveTenantContext("u_emp", "t_aurelia");
    tenantBAdminCtx = store.resolveTenantContext("u_tenant_b_admin", "t_competitor");
  });

  describe("Client Management & Tenant Isolation", () => {
    it("creates, retrieves, and updates client accounts under tenant scope", async () => {
      // 1. Create client via API
      const createReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/clients", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminSessionToken}`,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          name: "Global FinTech Ltd",
          contactName: "Vikram Malhotra",
          contactEmail: "vikram@fintech.example",
          country: "United Kingdom",
          billingTerms: "Net 45",
          status: "active",
        }),
      });

      const createRes = await handleApiRequest(createReq, { store });
      expect(createRes?.status).toBe(201);
      const createData = await createRes?.json();
      expect(createData.client.name).toBe("Global FinTech Ltd");
      expect(createData.client.billingTerms).toBe("Net 45");

      const clientId = createData.client.id;

      // 2. List clients
      const listReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/clients", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${adminSessionToken}`,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const listRes = await handleApiRequest(listReq, { store });
      expect(listRes?.status).toBe(200);
      const listData = await listRes?.json();
      expect(listData.clients.length).toBe(1);
      expect(listData.clients[0].id).toBe(clientId);

      // 3. Update client
      const patchReq = new Request(
        `http://localhost:3000/api/v1/tenants/t_aurelia/clients/${clientId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminSessionToken}`,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            billingTerms: "Net 60",
            status: "active",
          }),
        },
      );
      const patchRes = await handleApiRequest(patchReq, { store });
      expect(patchRes?.status).toBe(200);
      const patchData = await patchRes?.json();
      expect(patchData.client.billingTerms).toBe("Net 60");

      // 4. Tenant B cannot access Tenant A's client
      const crossReq = new Request(
        `http://localhost:3000/api/v1/tenants/t_competitor/clients/${clientId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${tenantBAdminSessionToken}`,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({ billingTerms: "Hacked" }),
        },
      );
      const crossRes = await handleApiRequest(crossReq, { store });
      expect(crossRes?.status).toBe(400); // Not found in tenant B
    });

    it("enforces permission guards on client creation (Employee cannot create clients)", async () => {
      const forbiddenReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/clients", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${employeeSessionToken}`,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          name: "Unpermitted Client",
        }),
      });

      const res = await handleApiRequest(forbiddenReq, { store });
      expect(res?.status).toBe(403);
    });
  });

  describe("Project Creation & Budget Management", () => {
    it("creates a new project with client mapping, billable rates, and manager assignment", async () => {
      // Setup client first
      const client = store.createClient(adminCtx, {
        name: "Enterprise Client",
        contactName: "Priya Rao",
        contactEmail: "priya@enterprise.example",
        country: "India",
      });

      const projectReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminSessionToken}`,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          clientId: client.id,
          name: "Cloud Transformation",
          projectManagerMembershipId: "m_mgr",
          budgetHours: 250,
          billableRate: 95,
          tasks: ["Sprint Planning", "Cloud Migration", "QA Validation"],
          status: "active",
        }),
      });

      const res = await handleApiRequest(projectReq, { store });
      expect(res?.status).toBe(201);
      const data = await res?.json();
      expect(data.project.name).toBe("Cloud Transformation");
      expect(data.project.budgetHours).toBe(250);
      expect(data.project.billableRate).toBe(95);
    });
  });

  describe("Company Settings Management", () => {
    it("retrieves and updates company settings", async () => {
      const getReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/settings", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${adminSessionToken}`,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const getRes = await handleApiRequest(getReq, { store });
      expect(getRes?.status).toBe(200);
      const getData = await getRes?.json();
      expect(getData.settings.country).toBe("India");

      const patchReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminSessionToken}`,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          dailyTargetHours: "8.50",
          currency: "USD",
          timezone: "Asia/Kolkata",
          lockApprovedSheets: true,
          requireRejectReason: true,
        }),
      });
      const patchRes = await handleApiRequest(patchReq, { store });
      expect(patchRes?.status).toBe(200);
      const patchData = await patchRes?.json();
      expect(patchData.settings.dailyTargetHours).toBe("8.50");
      expect(patchData.settings.currency).toBe("USD");
    });
  });

  describe("Real Database-Backed Reports & Analytics", () => {
    it("aggregates utilization, billable vs non-billable, and project/client breakdowns", async () => {
      // 1. Create client and project
      const client = store.createClient(adminCtx, {
        name: "Acme Corp",
        contactName: "Alice",
        contactEmail: "alice@acme.example",
        country: "USA",
      });

      const project = store.createProjectScoped(adminCtx, {
        clientId: client.id,
        name: "Mobile Banking App",
        projectManagerMembershipId: "m_mgr",
        budgetHours: 200,
        billableRate: 100,
      });

      // 2. Submit timesheet for Dev Employee (2026-11-02: Monday)
      // 8h billable on Mon, 8h billable on Tue, 4h non-billable on Wed
      const sheet = store.upsertTimesheet(employeeCtx, "m_emp", {
        weekStart: "2026-11-02",
        entries: [
          {
            projectId: project.id,
            taskName: "Frontend Coding",
            hoursByDay: [8, 8, 0, 0, 0, 0, 0],
            billable: true,
            notes: "React UI development",
          },
          {
            projectId: project.id,
            taskName: "Team Sync",
            hoursByDay: [0, 0, 4, 0, 0, 0, 0],
            billable: false,
            notes: "Internal sync",
          },
        ],
      });

      // Submit sheet
      store.submitTimesheet(employeeCtx, sheet.id);

      // 3. Query reports endpoint
      const reportReq = new Request(
        "http://localhost:3000/api/v1/tenants/t_aurelia/reports?from=2026-11-01&to=2026-11-30",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${adminSessionToken}`,
            "X-Requested-With": "XMLHttpRequest",
          },
        },
      );

      const res = await handleApiRequest(reportReq, { store });
      expect(res?.status).toBe(200);
      const data = await res?.json();

      expect(data.totalHours).toBe(20);
      expect(data.billableHours).toBe(16);
      expect(data.nonBillableHours).toBe(4);
      expect(data.utilizationRate).toBe(80); // (16 / 20) * 100
      expect(data.totalBillableValue).toBe(1600); // 16h * $100

      // By Project breakdown
      expect(data.byProject.length).toBe(1);
      expect(data.byProject[0].projectName).toBe("Mobile Banking App");
      expect(data.byProject[0].billableHours).toBe(16);
      expect(data.byProject[0].nonBillableHours).toBe(4);

      // By Client breakdown
      expect(data.byClient.length).toBe(1);
      expect(data.byClient[0].clientName).toBe("Acme Corp");

      // By Employee breakdown
      expect(data.byEmployee.length).toBe(1);
      expect(data.byEmployee[0].employeeName).toBe("Dev Employee");
      expect(data.byEmployee[0].utilizationRate).toBe(80);

      // Detailed entries list
      expect(data.entries.length).toBe(3);
    });
  });

  describe("Timesheet Approvals & Self-Approval Prevention", () => {
    it("strictly prevents managers from self-approving their own submitted timesheets", async () => {
      const client = store.createClient(adminCtx, {
        name: "FinTech",
        contactName: "Carl",
        contactEmail: "carl@fintech.example",
        country: "India",
      });

      const project = store.createProjectScoped(adminCtx, {
        clientId: client.id,
        name: "Security Auditing",
        projectManagerMembershipId: "m_mgr",
        budgetHours: 100,
        billableRate: 150,
      });

      // Manager logs their own timesheet
      const mgrSheet = store.upsertTimesheet(managerCtx, "m_mgr", {
        weekStart: "2026-11-02",
        entries: [
          {
            projectId: project.id,
            taskName: "Architecture Review",
            hoursByDay: [8, 8, 8, 8, 8, 0, 0],
            billable: true,
            notes: "Sprint work",
          },
        ],
      });
      store.submitTimesheet(managerCtx, mgrSheet.id);

      // Manager attempts self-approval
      const selfApproveReq = new Request(
        `http://localhost:3000/api/v1/tenants/t_aurelia/timesheets/${mgrSheet.id}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${managerSessionToken}`,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({ comment: "Self-approving my own timesheet" }),
        },
      );

      const res = await handleApiRequest(selfApproveReq, { store });
      expect(res?.status).toBe(403); // Strictly blocked!
    });
  });

  describe("Member Invitations", () => {
    it("generates and dispatches single employee invitations", async () => {
      const inviteReq = new Request("http://localhost:3000/api/v1/tenants/t_aurelia/invitations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminSessionToken}`,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          email: "newhire@aurelia.com",
          roleKeys: ["employee"],
          reportingManagerMembershipId: "m_mgr",
        }),
      });

      const res = await handleApiRequest(inviteReq, { store });
      expect(res?.status).toBe(201);
      const data = await res?.json();
      expect(data.invitation.email).toBe("newhire@aurelia.com");
      expect(data.invitation.token).toBeDefined();
      expect(data.invitation.expiresAt).toBeDefined();
    });
  });
});
