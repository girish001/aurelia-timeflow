import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  FileSpreadsheet,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Logo } from "@/components/app/common";
import {
  buildOnboardingPreviewSummary,
  normalizeTenantSlug,
  parseTeamOnboardingCsv,
  type OnboardingPreviewResult,
} from "@/lib/onboarding-preview";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  head: () =>
    pageHead(
      "Company Onboarding",
      "Set up your organization workspace on Aurelia TimeFlow — configure regional defaults, verify admin access, and import your team.",
    ),
  component: CompanyOnboardingWizard,
});

const DEFAULT_SAMPLE_CSV = `email,fullName,jobTitle,department,roles,managerEmail
priya.sharma@acme-consulting.com,Priya Sharma,Delivery Manager,Delivery,manager;employee,admin@acme-consulting.com
arjun.mehta@acme-consulting.com,Arjun Mehta,Senior Developer,Engineering,team_lead;employee,priya.sharma@acme-consulting.com
kavya.nair@acme-consulting.com,Kavya Nair,Product Designer,Design,employee,priya.sharma@acme-consulting.com`;

function CompanyOnboardingWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [companyName, setCompanyName] = useState("Acme IT Consulting Pvt Ltd");
  const [slug, setSlug] = useState("acme-consulting");
  const [adminFullName, setAdminFullName] = useState("Vikram Joshi");
  const [adminEmail, setAdminEmail] = useState("admin@acme-consulting.com");
  const [csvText, setCsvText] = useState(DEFAULT_SAMPLE_CSV);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<OnboardingPreviewResult | null>(null);

  const handleStep1Continue = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!companyName.trim() || !adminFullName.trim() || !adminEmail.includes("@")) {
      setError("Please provide a valid company name, administrator name, and work email.");
      return;
    }
    setStep(2);
  };

  const handleCompleteOnboarding = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = buildOnboardingPreviewSummary({
        companyName,
        slug,
        adminEmail,
        csvText,
      });
      setSummary(result);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete onboarding.");
    }
  };

  const previewRows = (() => {
    try {
      return parseTeamOnboardingCsv(csvText);
    } catch {
      return [];
    }
  })();

  return (
    <div className="min-h-screen bg-hero text-foreground flex flex-col">
      <header className="sticky top-0 z-30 border-b bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <Logo />
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/login" className="font-medium text-muted-foreground hover:text-foreground">
              Demo Role Preview
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-6">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Self-Service Company Onboarding
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Provision an isolated multi-tenant workspace, assign additive roles, and configure HR
            reporting lines.
          </p>
        </div>

        {/* Step Indicator */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          {[
            { num: 1, label: "Company & Admin", icon: Building2 },
            { num: 2, label: "Team & Reporting CSV", icon: FileSpreadsheet },
            { num: 3, label: "Workspace Ready", icon: UserCheck },
          ].map((item) => {
            const active = step === item.num;
            const completed = step > item.num;
            return (
              <div
                key={item.num}
                className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-xs font-semibold ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : completed
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-border bg-card text-muted-foreground"
                }`}
              >
                <item.icon className="size-4 shrink-0" />
                <span>
                  Step {item.num}: {item.label}
                </span>
              </div>
            );
          })}
        </div>

        {error && (
          <div
            role="alert"
            className="mb-5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs font-medium text-destructive"
          >
            {error}
          </div>
        )}

        {step === 1 && (
          <form
            onSubmit={handleStep1Continue}
            className="space-y-5 rounded-2xl border bg-card p-6 shadow-card sm:p-8"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ob-company">Company Legal / Trading Name</Label>
                <Input
                  id="ob-company"
                  value={companyName}
                  onChange={(e) => {
                    setCompanyName(e.target.value);
                    setSlug(normalizeTenantSlug(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-slug">Tenant Workspace Slug</Label>
                <Input
                  id="ob-slug"
                  value={slug}
                  onChange={(e) => setSlug(normalizeTenantSlug(e.target.value))}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ob-admin-name">Founding Administrator Name</Label>
                <Input
                  id="ob-admin-name"
                  value={adminFullName}
                  onChange={(e) => setAdminFullName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-admin-email">Administrator Work Email</Label>
                <Input
                  id="ob-admin-email"
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t pt-4">
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 text-primary" />
                Strict tenant_id isolation & explicit membership verification
              </span>
              <Button type="submit">
                Continue to Team Setup <ArrowRight className="size-4" />
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form
            onSubmit={handleCompleteOnboarding}
            className="space-y-5 rounded-2xl border bg-card p-6 shadow-card sm:p-8"
          >
            <div className="space-y-1.5">
              <Label htmlFor="ob-csv">
                Bulk Team & Reporting Hierarchy CSV
                (email,fullName,jobTitle,department,roles,managerEmail)
              </Label>
              <Textarea
                id="ob-csv"
                rows={6}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Parsed {previewRows.length} employee rows. Multiple roles per employee can be
                separated with <code>;</code> (e.g., <code>manager;employee</code>).
              </p>
            </div>

            <div className="flex items-center justify-between border-t pt-4">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit">
                Verify & Provision Workspace <ArrowRight className="size-4" />
              </Button>
            </div>
          </form>
        )}

        {step === 3 && summary && (
          <div className="space-y-5 rounded-2xl border bg-card p-6 shadow-card sm:p-8">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-7 text-emerald-600" />
              <div>
                <h2 className="text-lg font-bold">{summary.companyName} Workspace Provisioned</h2>
                <p className="text-xs text-muted-foreground">
                  Tenant ID: <code>{summary.tenantId}</code> · Slug:{" "}
                  <code>{summary.tenantSlug}</code>
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">Founding Admin</p>
                <p className="mt-1 text-sm font-semibold">{summary.adminEmail}</p>
              </div>
              <div className="rounded-xl border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">Imported Memberships</p>
                <p className="mt-1 text-sm font-semibold">{summary.importedCount} active members</p>
              </div>
              <div className="rounded-xl border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">HR Reporting Lines</p>
                <p className="mt-1 text-sm font-semibold">
                  {summary.reportingLinesLinked} linked relationships
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t pt-4">
              <Button variant="outline" onClick={() => setStep(1)}>
                Provision Another Tenant
              </Button>
              <Button onClick={() => void navigate({ to: "/login" })}>
                Open Demo Role Preview <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
