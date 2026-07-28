/**
 * Pure helpers behind the sidebar's provider-usage surfaces.
 *
 * Full mode is the only consumer today; Compact is still in design and is
 * expected to reuse every function here rather than re-derive thresholds or
 * window labels, so this module is the single source of truth for both.
 *
 * @module SidebarUsage.logic
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

/**
 * A snapshot older than this is shown dimmed rather than hidden — a stale
 * number still tells the user roughly where they stand, and hiding the block
 * would make the footer jump.
 */
export const USAGE_STALE_AFTER_MS = 10 * 60 * 1000;

export type UsageSeverity = "ok" | "warn" | "hot";

/**
 * Severity buckets shared by every usage surface. Chosen so "warn" lands
 * well before a user is actually blocked, and "hot" only fires when a
 * window is close enough that the next turn may fail.
 */
export function usageSeverity(usedPercent: number): UsageSeverity {
  if (usedPercent >= 95) return "hot";
  if (usedPercent >= 75) return "warn";
  return "ok";
}

/**
 * Derive a window's short label from its reported duration rather than
 * trusting the provider's own prose. A provider that starts reporting a
 * window we have never seen still gets a correct label, and two providers
 * reporting the same duration label identically.
 *
 * The provider-supplied `label` is the fallback for windows with no
 * duration, since it is the only remaining signal.
 */
export function usageWindowLabel(window: ServerProviderUsageWindow): string {
  const minutes = window.windowDurationMins;
  if (minutes === undefined || minutes <= 0) return window.label;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? "1d" : `${days}d`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Coarse countdown to a reset, e.g. `2h 08m`. Deliberately never finer than
 * a minute: the sidebar recomputes these on a slow interval, and a seconds
 * component would look frozen between ticks.
 *
 * Returns null once the reset has passed, so callers fall back to showing
 * the percentage instead of a stale "0m".
 */
export function formatTimeToReset(resetsAtIso: string, nowMs: number): string | null {
  const resetsAtMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsAtMs)) return null;
  const remainingMs = resetsAtMs - nowMs;
  if (remainingMs <= 0) return null;
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * What the trailing slot of a usage row should read.
 *
 * A window at 100% has nothing useful to say with a percentage — the number
 * the user needs is when it frees up — so the reset countdown takes over
 * that slot. Every other case keeps the percentage, including an exhausted
 * window whose `resetsAt` is missing or already past.
 */
export function usageRowValueLabel(
  window: ServerProviderUsageWindow,
  nowMs: number,
): { readonly kind: "percent" | "reset"; readonly text: string } {
  const percent = Math.round(clampPercent(window.usedPercent));
  if (percent >= 100) {
    const countdown = usageRowResetLabel(window, nowMs);
    if (countdown !== null) return { kind: "reset", text: countdown };
  }
  return { kind: "percent", text: `${percent}%` };
}

export function usageRowResetLabel(
  window: ServerProviderUsageWindow,
  nowMs: number,
): string | null {
  return window.resetsAt === undefined ? null : formatTimeToReset(window.resetsAt, nowMs);
}

export function clampPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.max(0, Math.min(100, usedPercent));
}

export function isUsageStale(limits: ServerProviderUsageLimits, nowMs: number): boolean {
  const checkedAtMs = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return nowMs - checkedAtMs > USAGE_STALE_AFTER_MS;
}

/**
 * Whether a snapshot has anything worth rendering.
 *
 * An unlimited account is explicitly nothing to show: it has no windows and
 * a balance that never moves, so a block for it would be permanent noise.
 */
export function hasRenderableUsage(limits: ServerProviderUsageLimits): boolean {
  if (limits.windows.length > 0) return true;
  return limits.credits !== undefined && !limits.credits.unlimited;
}

/**
 * The credits line shown in place of window rows on usage-based plans.
 * Null whenever windows already carry the story, or the balance is absent.
 */
export function usageCreditsLabel(limits: ServerProviderUsageLimits): string | null {
  if (limits.windows.length > 0) return null;
  const credits = limits.credits;
  if (credits === undefined || credits.unlimited) return null;
  const balance = credits.balance?.trim();
  return balance ? `${balance} credits` : null;
}
