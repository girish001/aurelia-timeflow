import { useMemo } from "react";
import { format } from "date-fns";
import {
  CalendarDays,
  HeartPulse,
  UserCheck,
  Plus,
  AlertCircle,
  Clock,
  CheckCircle2,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useDemo, useMe, type LeaveType } from "@/lib/demo-store";
import {
  memberAllLeaveBalances,
  calculateMonthlyAccrual,
  type CategoryLeaveBalance,
} from "@/lib/rules";

export interface LeaveBalanceProgressProps {
  memberId?: string;
  year?: number;
  onRequestLeave?: (type: LeaveType) => void;
  title?: string;
  description?: string;
  showActions?: boolean;
  className?: string;
}

interface LeaveCardConfig {
  type: "annual" | "sick" | "personal";
  icon: typeof CalendarDays;
  accent: {
    iconBg: string;
    iconColor: string;
    usedBar: string;
    usedDot: string;
    badgeBorder: string;
  };
  policyHint: string;
  cadenceNote: string;
}

const LEAVE_CONFIGS: LeaveCardConfig[] = [
  {
    type: "annual",
    icon: CalendarDays,
    accent: {
      iconBg: "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400",
      iconColor: "text-indigo-600 dark:text-indigo-400",
      usedBar: "bg-indigo-600 dark:bg-indigo-500",
      usedDot: "bg-indigo-600 dark:bg-indigo-500",
      badgeBorder: "border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300",
    },
    policyHint: "Paid leave (PL) & scheduled vacation",
    cadenceNote: "Accrues 1.5 days every month (18d/yr)",
  },
  {
    type: "sick",
    icon: HeartPulse,
    accent: {
      iconBg: "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400",
      iconColor: "text-rose-600 dark:text-rose-400",
      usedBar: "bg-rose-600 dark:bg-rose-500",
      usedDot: "bg-rose-600 dark:bg-rose-500",
      badgeBorder: "border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300",
    },
    policyHint: "Medical appointments, illness and recovery",
    cadenceNote: "Yearly 10d credited annually on Jan 1",
  },
  {
    type: "personal",
    icon: UserCheck,
    accent: {
      iconBg: "bg-sky-50 text-sky-600 dark:bg-sky-950/60 dark:text-sky-400",
      iconColor: "text-sky-600 dark:text-sky-400",
      usedBar: "bg-sky-600 dark:bg-sky-500",
      usedDot: "bg-sky-600 dark:bg-sky-500",
      badgeBorder: "border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300",
    },
    policyHint: "Personal affairs, emergencies and family duties",
    cadenceNote: "Yearly 5d allowance credited annually on Jan 1",
  },
];

export function LeaveBalanceProgress({
  memberId,
  year = new Date().getFullYear(),
  onRequestLeave,
  title = "My Leave Balances",
  description = "Real-time annual, sick, and personal balance tracking with monthly accruals and policy limits.",
  showActions = true,
  className,
}: LeaveBalanceProgressProps) {
  const me = useMe();
  const s = useDemo((state) => state);
  const targetMemberId = memberId || me.id;

  const targetMember = useMemo(
    () => s.members.find((m) => m.id === targetMemberId) || me,
    [s.members, targetMemberId, me],
  );

  const balances = useMemo(
    () => memberAllLeaveBalances(s, targetMemberId, year),
    [s, targetMemberId, year],
  );

  const accrual = useMemo(() => {
    return calculateMonthlyAccrual(
      new Date(),
      s.settings.leavePolicy?.monthlyPaidLeaveAccrual ?? 1.5,
      s.settings.leavePolicy?.yearlyAnnualLeave ?? 18,
    );
  }, [s.settings.leavePolicy]);

  const currentMonthName = useMemo(() => format(new Date(), "MMM"), []);

  return (
    <div className={cn("space-y-3", className)} data-testid="leave-balance-progress-section">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 px-0.5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground tracking-tight">{title}</h2>
            <Badge variant="outline" className="font-mono text-[11px] font-normal py-0">
              {year} Policy Year
            </Badge>
            <Badge
              variant="secondary"
              className="text-[11px] font-medium bg-primary/10 text-primary border border-primary/20"
            >
              PL: 1.5d/mo Accrual
            </Badge>
          </div>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {targetMemberId !== me.id && (
          <span className="text-xs text-muted-foreground italic">
            Viewing balance for {targetMember.name}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {LEAVE_CONFIGS.map((config) => {
          const bal = balances[config.type] as CategoryLeaveBalance;
          const Icon = config.icon;
          const isLow = bal.remaining <= 2 && bal.entitlement > 0;
          const isExhausted = bal.remaining === 0 && bal.entitlement > 0;

          return (
            <div
              key={config.type}
              data-testid={`leave-balance-card-${config.type}`}
              className="group relative rounded-xl border bg-card p-5 shadow-card transition-all hover:border-foreground/20 flex flex-col justify-between"
            >
              <div>
                {/* Header row: Icon, Category Name, Entitlement badge */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "grid size-9 shrink-0 place-items-center rounded-lg shadow-2xs",
                        config.accent.iconBg,
                      )}
                    >
                      <Icon className="size-4.5" aria-hidden />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{bal.label}</h3>
                      <p className="text-[11px] text-muted-foreground leading-tight">
                        {config.policyHint}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "shrink-0 text-[11px] font-mono tabular-nums px-2 py-0.5",
                      config.accent.badgeBorder,
                    )}
                  >
                    {bal.entitlement}d / yr
                  </Badge>
                </div>

                {/* Monthly Accrual Banner for Annual Leave */}
                {config.type === "annual" && (
                  <div className="mt-2.5 flex items-center justify-between rounded-lg bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/60 px-2.5 py-1 text-[11px]">
                    <span className="text-indigo-900 dark:text-indigo-200 font-medium flex items-center gap-1">
                      <TrendingUp className="size-3 text-indigo-600 dark:text-indigo-400" />
                      Accrued to date ({currentMonthName}):
                    </span>
                    <strong className="text-indigo-700 dark:text-indigo-300 font-mono">
                      {accrual.accruedToDate} days
                    </strong>
                  </div>
                )}
                {config.type !== "annual" && (
                  <div className="mt-2.5 flex items-center justify-between rounded-lg bg-muted/40 border border-border/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                    <span>Allocation cadence:</span>
                    <span className="font-medium text-foreground">Annual quota credited Jan 1</span>
                  </div>
                )}

                {/* Hero balance metric & status flag */}
                <div className="mt-4 flex items-baseline justify-between">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-bold tracking-tight text-foreground font-mono tabular-nums">
                      {bal.remaining}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      days remaining
                    </span>
                  </div>

                  {isExhausted ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive border border-destructive/20">
                      <AlertCircle className="size-3" />
                      Exhausted
                    </span>
                  ) : isLow ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
                      <AlertCircle className="size-3" />
                      Low Balance
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                      <Sparkles className="size-3" />
                      {100 - bal.percentUsed}% Free
                    </span>
                  )}
                </div>

                {/* Visual Progress Bar (Accessible multi-segment) */}
                <div className="mt-3 space-y-1.5">
                  <div
                    role="progressbar"
                    aria-valuenow={bal.used}
                    aria-valuemin={0}
                    aria-valuemax={bal.entitlement}
                    aria-label={`${bal.label}: ${bal.used} of ${bal.entitlement} days used, ${bal.pending} pending, ${bal.remaining} remaining`}
                    className="relative h-2.5 w-full overflow-hidden rounded-full bg-secondary/80 flex"
                  >
                    {/* Approved / Used Segment */}
                    {bal.percentUsed > 0 && (
                      <div
                        className={cn(
                          "h-full transition-all duration-300 rounded-l-full",
                          config.accent.usedBar,
                          bal.percentUsed === 100 && "rounded-r-full",
                        )}
                        style={{ width: `${bal.percentUsed}%` }}
                        title={`Approved: ${bal.used} days (${bal.percentUsed}%)`}
                      />
                    )}

                    {/* Pending Review Segment (Striped Amber) */}
                    {bal.percentPending > 0 && (
                      <div
                        className={cn(
                          "h-full bg-amber-400 dark:bg-amber-500 transition-all duration-300 relative",
                          bal.percentUsed === 0 && "rounded-l-full",
                          bal.percentUsed + bal.percentPending >= 100 && "rounded-r-full",
                        )}
                        style={{
                          width: `${bal.percentPending}%`,
                          backgroundImage:
                            "repeating-linear-gradient(45deg, rgba(255,255,255,0.3) 0, rgba(255,255,255,0.3) 3px, transparent 3px, transparent 6px)",
                        }}
                        title={`Pending: ${bal.pending} days (${bal.percentPending}%)`}
                      />
                    )}
                  </div>
                </div>

                {/* Breakdown Stats Grid */}
                <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-xs">
                  <div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span className={cn("size-2 rounded-full", config.accent.usedDot)} />
                      <span className="truncate">Used</span>
                    </div>
                    <p className="mt-0.5 font-semibold text-foreground font-mono tabular-nums">
                      {bal.used}d
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 rounded-full bg-amber-400 dark:bg-amber-500" />
                      <span className="truncate">Pending</span>
                    </div>
                    <p className="mt-0.5 font-semibold text-foreground font-mono tabular-nums">
                      {bal.pending}d
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 rounded-full bg-emerald-500" />
                      <span className="truncate">Available</span>
                    </div>
                    <p className="mt-0.5 font-semibold text-foreground font-mono tabular-nums">
                      {bal.remaining}d
                    </p>
                  </div>
                </div>
              </div>

              {/* Action trigger footer */}
              {showActions && onRequestLeave && (
                <div className="mt-4 pt-3 border-t border-border/40">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs font-medium gap-1.5 justify-center hover:bg-secondary/80"
                    onClick={() => onRequestLeave(config.type)}
                    disabled={isExhausted}
                  >
                    <Plus className="size-3.5" />
                    Request {bal.label}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
