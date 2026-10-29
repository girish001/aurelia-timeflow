import { isValidElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  action,
}: {
  title: string;
  description?: string | undefined;
  actions?: ReactNode;
  action?: ReactNode;
}) {
  const headerActions = actions ?? action;
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold text-foreground sm:text-[1.7rem]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {headerActions && <div className="flex flex-wrap items-center gap-2">{headerActions}</div>}
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-card", className)}>
      {title && (
        <div className="flex items-center justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  meta,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  meta?: ReactNode;
  icon: LucideIcon | ReactNode;
  tone?: "primary" | "teal" | "warning" | "success" | undefined;
}) {
  const tones = {
    primary: "bg-secondary text-primary",
    teal: "bg-teal-soft text-accent-foreground",
    warning: "bg-warning/15 text-warning-foreground",
    success: "bg-success/12 text-success",
  };
  const subtext = hint ?? meta;
  const IconComp = Icon as LucideIcon;
  return (
    <div className="rounded-xl border bg-card p-5 shadow-card">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className={cn("grid size-9 place-items-center rounded-lg", tones[tone])}>
          {isValidElement(Icon) ? Icon : <IconComp className="size-4.5" aria-hidden />}
        </span>
      </div>
      <p className="mt-3 text-3xl font-bold tabular text-foreground">{value}</p>
      {subtext && <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>}
    </div>
  );
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  submitted: "bg-warning/15 text-warning-foreground border-warning/30",
  approved: "bg-success/12 text-success border-success/25",
  rejected: "bg-destructive/10 text-destructive border-destructive/25",
  active: "bg-success/12 text-success border-success/25",
  inactive: "bg-muted text-muted-foreground border-border",
  invited: "bg-teal-soft text-accent-foreground border-teal/30",
  "on-hold": "bg-warning/15 text-warning-foreground border-warning/30",
  completed: "bg-secondary text-primary border-primary/20",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        statusStyles[status] ?? statusStyles["draft"],
      )}
    >
      {status.replace("-", " ")}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  text,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  text?: string | undefined;
  description?: string | undefined;
  action?: ReactNode;
}) {
  const body = text ?? description;
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-secondary text-primary">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 font-semibold text-foreground">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const initialsSizes: Record<string, string> = {
  xs: "size-6 text-[10px]",
  sm: "size-7 text-xs",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
};

export function Initials({
  name,
  className,
  size = "md",
}: {
  name: string;
  className?: string | undefined;
  size?: "xs" | "sm" | "md" | "lg" | undefined;
}) {
  const i = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-secondary font-semibold text-primary",
        initialsSizes[size] ?? initialsSizes["md"],
        className,
      )}
      aria-hidden
    >
      {i}
    </span>
  );
}

export function Logo({ inverted }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-teal text-navy">
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      </span>
      <div className="leading-tight">
        <p
          className={cn(
            "text-[0.95rem] font-bold",
            inverted ? "text-sidebar-accent-foreground" : "text-foreground",
          )}
        >
          Aurelia TimeFlow
        </p>
        <p
          className={cn(
            "text-[0.65rem]",
            inverted ? "text-sidebar-foreground/70" : "text-muted-foreground",
          )}
        >
          by Aurelia Business Services
        </p>
      </div>
    </div>
  );
}
