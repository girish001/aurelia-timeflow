export type OnboardingRoleKey = "business_admin" | "manager" | "team_lead" | "employee";

export interface OnboardingCsvRow {
  email: string;
  fullName: string;
  jobTitle: string;
  department?: string | undefined;
  roles: OnboardingRoleKey[];
  managerEmail?: string | undefined;
}

export interface OnboardingPreviewResult {
  tenantId: string;
  tenantSlug: string;
  companyName: string;
  adminEmail: string;
  importedCount: number;
  reportingLinesLinked: number;
}

/**
 * Normalizes a company slug to lowercase alphanumeric + hyphens.
 */
export function normalizeTenantSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Parses CSV text (`email,fullName,jobTitle,department,roles,managerEmail`) into structured rows.
 */
export function parseTeamOnboardingCsv(csvText: string): OnboardingCsvRow[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstLine = lines[0] ?? "";
  const startIndex = firstLine.toLowerCase().startsWith("email,") ? 1 : 0;
  const rows: OnboardingCsvRow[] = [];

  const validRoles = new Set<OnboardingRoleKey>([
    "business_admin",
    "manager",
    "team_lead",
    "employee",
  ]);

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",").map((c) => c.trim());
    const [email, fullName, jobTitle, department, rolesRaw, managerEmail] = cols;

    if (!email || !email.includes("@") || !fullName) {
      throw new Error(`Invalid CSV row at line ${i + 1}: email and fullName are required.`);
    }

    const parsedRoles = (rolesRaw || "employee")
      .split(/[;|]+/)
      .map((r) => r.trim().toLowerCase() as OnboardingRoleKey)
      .filter((r) => validRoles.has(r));

    rows.push({
      email: email.toLowerCase(),
      fullName,
      jobTitle: jobTitle || "Team Member",
      department: department || undefined,
      roles: parsedRoles.length > 0 ? parsedRoles : ["employee"],
      managerEmail: managerEmail ? managerEmail.toLowerCase() : undefined,
    });
  }

  return rows;
}

export function buildOnboardingPreviewSummary(input: {
  companyName: string;
  slug: string;
  adminEmail: string;
  csvText: string;
}): OnboardingPreviewResult {
  const cleanSlug = normalizeTenantSlug(input.slug || input.companyName);
  if (cleanSlug.length < 2) {
    throw new Error("Company workspace slug must be at least 2 characters.");
  }
  const rows = parseTeamOnboardingCsv(input.csvText);
  const knownEmails = new Set<string>([
    input.adminEmail.trim().toLowerCase(),
    ...rows.map((r) => r.email),
  ]);
  const reportingLinesLinked = rows.filter(
    (r) => r.managerEmail && r.managerEmail !== r.email && knownEmails.has(r.managerEmail),
  ).length;

  return {
    tenantId: `t_${cleanSlug}`,
    tenantSlug: cleanSlug,
    companyName: input.companyName.trim(),
    adminEmail: input.adminEmail.trim().toLowerCase(),
    importedCount: rows.length,
    reportingLinesLinked,
  };
}
