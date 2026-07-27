import type {
  ServerProviderUsageCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function codexWindowLabel(windowDurationMins: number | null | undefined): string {
  return windowDurationMins !== undefined &&
    windowDurationMins !== null &&
    windowDurationMins >= 7 * 24 * 60
    ? "Weekly"
    : "Session";
}

function mapCodexWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderUsageWindow | undefined {
  if (!window) return undefined;
  return {
    label: codexWindowLabel(window.windowDurationMins),
    usedPercent: clampPercent(window.usedPercent),
    ...(window.windowDurationMins !== undefined && window.windowDurationMins !== null
      ? { windowDurationMins: Math.max(0, window.windowDurationMins) }
      : {}),
    ...(window.resetsAt !== undefined && window.resetsAt !== null
      ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1000)) }
      : {}),
  };
}

/**
 * Codex reports plans as machine slugs. `unknown` carries no information a
 * user could act on, so it is dropped rather than surfaced as a label.
 */
const CODEX_PLAN_LABELS: Partial<
  Record<CodexSchema.V2GetAccountRateLimitsResponse__PlanType, string>
> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business",
  business: "Business",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  edu: "Edu",
};

function codexPlanLabel(
  planType: CodexSchema.V2GetAccountRateLimitsResponse__PlanType | null | undefined,
): string | undefined {
  if (planType === undefined || planType === null) return undefined;
  return CODEX_PLAN_LABELS[planType];
}

/**
 * `hasCredits: false` on a metered account means the balance is exhausted,
 * which is still worth showing; only a wholly absent snapshot is dropped.
 */
function mapCodexCredits(
  credits: CodexSchema.V2GetAccountRateLimitsResponse__CreditsSnapshot | null | undefined,
): ServerProviderUsageCredits | undefined {
  if (!credits) return undefined;
  const balance = credits.balance?.trim();
  return {
    unlimited: credits.unlimited,
    ...(balance ? { balance } : {}),
  };
}

export function usageLimitsFromCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const windows = [
    mapCodexWindow(response.rateLimits.primary),
    mapCodexWindow(response.rateLimits.secondary),
  ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
  const planLabel = codexPlanLabel(response.rateLimits.planType);
  const credits = mapCodexCredits(response.rateLimits.credits);
  // Usage-based plans report no windows at all; their credit balance is the
  // only usage signal, so an empty window list is not an empty snapshot.
  if (windows.length === 0 && credits === undefined) return undefined;
  return {
    source: "codexAppServer",
    checkedAt,
    windows,
    ...(planLabel ? { planLabel } : {}),
    ...(credits ? { credits } : {}),
  };
}

function parseClaudeReset(input: {
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string | undefined;
  readonly meridiem: string;
  readonly timeZone: string;
  readonly checkedAt: string;
}): string | undefined {
  const month =
    MONTHS.indexOf(input.month.toLowerCase().slice(0, 3) as (typeof MONTHS)[number]) + 1;
  if (month === 0) return undefined;
  const checked = DateTime.make(input.checkedAt);
  if (Option.isNone(checked)) return undefined;
  const checkedInResetZone = DateTime.setZoneNamed(checked.value, input.timeZone);
  if (Option.isNone(checkedInResetZone)) return undefined;
  const checkedParts = DateTime.toParts(checkedInResetZone.value);
  const day = Number.parseInt(input.day, 10);
  let hour = Number.parseInt(input.hour, 10);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    day < 1 ||
    day > 31 ||
    hour < 1 ||
    hour > 12
  ) {
    return undefined;
  }
  if (hour === 12) hour = 0;
  if (input.meridiem.toLowerCase() === "pm") hour += 12;
  const year = checkedParts.month === 12 && month === 1 ? checkedParts.year + 1 : checkedParts.year;
  const localDateTime = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${input.minute ?? "00"}:00`;
  const reset = DateTime.makeZoned(localDateTime, {
    timeZone: input.timeZone,
    adjustForTimeZone: true,
  });
  return Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
}

export function parseClaudeUsageLimitsJson(
  output: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  let result: string;
  try {
    const decoded: unknown = JSON.parse(output);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as { result?: unknown }).result !== "string"
    ) {
      return undefined;
    }
    result = (decoded as { result: string }).result.replaceAll("\r\n", "\n");
  } catch {
    return undefined;
  }

  const windows: ServerProviderUsageWindow[] = [];
  const pattern =
    /^Current (session|week(?: \([^)]+\))?):\s*(\d{1,3}(?:\.\d+)?)% used\s*[\u00b7-]\s*resets ([A-Za-z]{3,9}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/gim;
  for (const match of result.matchAll(pattern)) {
    const [, rawLabel, percent, month, day, hour, minute, meridiem, timeZone] = match;
    if (!rawLabel || !percent || !month || !day || !hour || !meridiem || !timeZone) continue;
    const usedPercent = Number.parseFloat(percent);
    if (!Number.isFinite(usedPercent)) continue;
    const isSession = rawLabel.toLowerCase() === "session";
    const suffix = rawLabel.match(/\(([^)]+)\)/)?.[1];
    const resetsAt = parseClaudeReset({
      month,
      day,
      hour,
      minute,
      meridiem,
      timeZone,
      checkedAt,
    });
    windows.push({
      label: isSession ? "Session" : suffix ? `Weekly (${suffix})` : "Weekly",
      usedPercent: clampPercent(usedPercent),
      windowDurationMins: isSession ? 5 * 60 : 7 * 24 * 60,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  return windows.length > 0 ? { source: "claudePrint", checkedAt, windows } : undefined;
}
