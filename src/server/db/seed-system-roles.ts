import { SYSTEM_ROLE_PERMISSIONS } from "../authz/rbac";
import type { MultiTenantDataStore } from "../repositories/tenant-scoped-store";
import type { PermissionCode, RoleRecord, SystemRoleKey } from "../tenancy/tenant-context";

// ============================================================================
// Default System Permission Catalog & Role Definitions for AWS PostgreSQL
// ============================================================================

export interface PermissionCatalogEntry {
  id: string;
  code: PermissionCode;
  module:
    "tenant" | "client" | "project" | "allocation" | "timesheet" | "leave" | "report" | "audit";
  description: string;
}

export const SYSTEM_PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  {
    id: "perm_tenant_settings_manage",
    code: "tenant:settings:manage",
    module: "tenant",
    description: "Manage company profile, regional defaults, leave policies, and holidays.",
  },
  {
    id: "perm_tenant_members_manage",
    code: "tenant:members:manage",
    module: "tenant",
    description: "Invite employees, assign roles, and manage HR reporting lines.",
  },
  {
    id: "perm_client_read_all",
    code: "client:read:all",
    module: "client",
    description: "View all client accounts and billing terms in the tenant.",
  },
  {
    id: "perm_client_write_all",
    code: "client:write:all",
    module: "client",
    description: "Create, update, and archive client records.",
  },
  {
    id: "perm_project_read_all",
    code: "project:read:all",
    module: "project",
    description: "View all projects across the tenant organization.",
  },
  {
    id: "perm_project_read_assigned",
    code: "project:read:assigned",
    module: "project",
    description: "View projects where the member is assigned or is project manager.",
  },
  {
    id: "perm_project_write_all",
    code: "project:write:all",
    module: "project",
    description: "Create and update any project, budget, and billable rate in the tenant.",
  },
  {
    id: "perm_project_write_assigned",
    code: "project:write:assigned",
    module: "project",
    description: "Update project tasks, budgets, and team members for managed projects.",
  },
  {
    id: "perm_allocation_read_all",
    code: "allocation:read:all",
    module: "allocation",
    description: "View resource allocations across all employees and projects.",
  },
  {
    id: "perm_allocation_read_team",
    code: "allocation:read:team",
    module: "allocation",
    description: "View resource allocations for direct reports and managed projects.",
  },
  {
    id: "perm_allocation_read_own",
    code: "allocation:read:own",
    module: "allocation",
    description: "View personal resource schedule and project capacity.",
  },
  {
    id: "perm_allocation_write_project",
    code: "allocation:write:project",
    module: "allocation",
    description: "Schedule and modify resource allocations on managed projects.",
  },
  {
    id: "perm_timesheet_submit_own",
    code: "timesheet:submit:own",
    module: "timesheet",
    description: "Log weekly hours and submit personal timesheets for approval.",
  },
  {
    id: "perm_timesheet_read_team",
    code: "timesheet:read:team",
    module: "timesheet",
    description: "View submitted timesheets for direct reports or project team members.",
  },
  {
    id: "perm_timesheet_approve_team",
    code: "timesheet:approve:team",
    module: "timesheet",
    description: "Approve or reject timesheets for HR direct reports.",
  },
  {
    id: "perm_timesheet_approve_project",
    code: "timesheet:approve:project",
    module: "timesheet",
    description: "Approve or reject project timesheet entries as a project manager or lead.",
  },
  {
    id: "perm_leave_request_own",
    code: "leave:request:own",
    module: "leave",
    description: "Submit and cancel personal time-off and leave requests.",
  },
  {
    id: "perm_leave_approve_reports",
    code: "leave:approve:reports",
    module: "leave",
    description: "Approve or reject leave requests for HR direct reports.",
  },
  {
    id: "perm_report_read_tenant",
    code: "report:read:tenant",
    module: "report",
    description: "Access utilization, billable hours, and project financial reports.",
  },
  {
    id: "perm_audit_read_tenant",
    code: "audit:read:tenant",
    module: "audit",
    description: "Inspect immutable tenant governance and security audit logs.",
  },
];

export const SYSTEM_ROLE_DEFINITIONS: Array<{
  id: string;
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: PermissionCode[];
}> = [
  {
    id: "sys_business_admin",
    key: "business_admin",
    name: "Business Admin",
    description:
      "Full organizational governance, client billing, project budgets, utilization reporting, and workspace settings.",
    permissions: SYSTEM_ROLE_PERMISSIONS.business_admin,
  },
  {
    id: "sys_manager",
    key: "manager",
    name: "Project / People Manager",
    description:
      "Project delivery, team resource allocation, capacity planning, and timesheet & leave approvals.",
    permissions: SYSTEM_ROLE_PERMISSIONS.manager,
  },
  {
    id: "sys_team_lead",
    key: "team_lead",
    name: "Team Lead",
    description:
      "Project task coordination, team schedule visibility, and project-scoped timesheet review.",
    permissions: SYSTEM_ROLE_PERMISSIONS.team_lead,
  },
  {
    id: "sys_employee",
    key: "employee",
    name: "Employee",
    description:
      "Weekly timesheet logging, task tracking, personal leave requests, and assigned project schedules.",
    permissions: SYSTEM_ROLE_PERMISSIONS.employee,
  },
];

/**
 * Seeds the 4 default system roles into a `MultiTenantDataStore` instance.
 */
export function seedSystemRolesIntoStore(store: MultiTenantDataStore): RoleRecord[] {
  return SYSTEM_ROLE_DEFINITIONS.map((def) =>
    store.registerCustomRole({
      id: def.id,
      tenantId: null,
      key: def.key,
      name: def.name,
      permissions: [...def.permissions],
      isSystemRole: true,
    }),
  );
}
