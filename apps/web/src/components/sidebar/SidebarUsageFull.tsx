import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ServerConfig,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentServerConfigsAtom } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  clampPercent,
  hasRenderableUsage,
  isUsageStale,
  usageCreditsLabel,
  usageRowValueLabel,
  usageSeverity,
  usageWindowLabel,
  type UsageSeverity,
} from "./SidebarUsage.logic";

/**
 * Reset countdowns and staleness are both minute-grained, so the footer
 * recomputes them on a slow tick. A per-second ticker here would re-render
 * the sidebar sixty times a minute to move a label that changes once.
 */
const USAGE_TICK_MS = 30_000;

const SEVERITY_BAR_CLASS: Record<UsageSeverity, string> = {
  ok: "bg-primary/70",
  warn: "bg-warning",
  hot: "bg-destructive",
};

interface UsageBlock {
  readonly key: string;
  readonly entry: ProviderInstanceEntry;
  readonly usageLimits: ServerProviderUsageLimits;
}

interface UsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerConfig["settings"], "providerInstances" | "providers">;
}

/**
 * Provider usage for the sidebar footer, one block per enabled instance
 * that has reported a usage snapshot.
 *
 * Renders nothing unless the `sidebarUsageDisplay` setting is `full`.
 * `compact` deliberately falls through to nothing — its design is still in
 * progress, and rendering a half-built surface is worse than none.
 *
 * The setting is read here rather than in `SidebarChromeFooter` so the
 * footer's `memo` is not defeated by every unrelated client-settings write.
 */
export const SidebarUsageFull = memo(function SidebarUsageFull() {
  const usageDisplay = useClientSettings((settings) => settings.sidebarUsageDisplay);
  // TODO(compact): render the compact notification surface once its design
  // lands; see mockups/10-salience-channels.html.
  if (usageDisplay !== "full") return null;
  return <SidebarUsageFullBlocks />;
});

function SidebarUsageFullBlocks() {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const nowMs = useCoarseNow();
  const environments = useMemo(
    () =>
      [...serverConfigs.entries()].map(
        ([environmentId, config]): UsageEnvironment => ({
          environmentId,
          providers: config.providers,
          settings: selectProviderInstanceSettings(config.settings),
        }),
      ),
    [serverConfigs],
  );

  return (
    <SidebarUsageEnvironmentBlocks
      environments={environments}
      nowMs={nowMs}
      primaryEnvironmentId={primaryEnvironmentId}
    />
  );
}

/**
 * Build one usage block per account across every environment. Authenticated
 * account email is the only cross-environment identity the provider snapshot
 * exposes, so snapshots without it stay environment-scoped rather than risking
 * collapsing unrelated accounts.
 */
function collectUsageBlocks(
  environments: ReadonlyArray<UsageEnvironment>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<UsageBlock> {
  const orderedEnvironments = [...environments].sort((left, right) => {
    if (left.environmentId === primaryEnvironmentId) return -1;
    if (right.environmentId === primaryEnvironmentId) return 1;
    return 0;
  });
  const blocks: UsageBlock[] = [];
  const blockIndexByKey = new Map<string, number>();

  for (const environment of orderedEnvironments) {
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(
        deriveProviderInstanceEntries(environment.providers),
        environment.settings,
      ),
    );
    for (const entry of entries) {
      // A signed-out or disabled instance is omitted entirely rather than
      // shown empty; auth state is surfaced elsewhere in the app.
      if (!isProviderInstancePickerVisible(entry)) continue;
      const usageLimits = entry.snapshot.usageLimits;
      if (usageLimits === undefined || !hasRenderableUsage(usageLimits)) continue;

      const email = entry.snapshot.auth.email?.trim().toLowerCase();
      const key = email
        ? `account:${entry.driverKind}:${email}`
        : `instance:${environment.environmentId}:${entry.instanceId}`;
      const existingIndex = blockIndexByKey.get(key);
      const block = { key, entry, usageLimits } satisfies UsageBlock;
      if (existingIndex === undefined) {
        blockIndexByKey.set(key, blocks.length);
        blocks.push(block);
        continue;
      }

      const existing = blocks[existingIndex];
      if (
        existing &&
        Date.parse(usageLimits.checkedAt) > Date.parse(existing.usageLimits.checkedAt)
      ) {
        blocks[existingIndex] = block;
      }
    }
  }

  return blocks;
}

/**
 * The rendering half, taking every input as a prop so aggregation and
 * deduplication are exercisable without server connections or a wall clock.
 */
function SidebarUsageEnvironmentBlocks(props: {
  readonly environments: ReadonlyArray<UsageEnvironment>;
  readonly nowMs: number;
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const blocks = useMemo(
    () => collectUsageBlocks(props.environments, props.primaryEnvironmentId),
    [props.environments, props.primaryEnvironmentId],
  );

  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col border-b border-sidebar-border/60" aria-label="Provider usage">
      {blocks.map((block) => (
        <SidebarUsageProviderBlock block={block} key={block.key} nowMs={props.nowMs} />
      ))}
    </div>
  );
}

function SidebarUsageBlocksForTest(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UsageEnvironment["settings"];
  readonly nowMs: number;
}) {
  const environmentId = "test-environment" as EnvironmentId;
  return (
    <SidebarUsageEnvironmentBlocks
      environments={[{ environmentId, providers: props.providers, settings: props.settings }]}
      nowMs={props.nowMs}
      primaryEnvironmentId={environmentId}
    />
  );
}

export {
  SidebarUsageBlocksForTest,
  SidebarUsageEnvironmentBlocks as SidebarUsageEnvironmentsForTest,
};

function SidebarUsageProviderBlock(props: { readonly block: UsageBlock; readonly nowMs: number }) {
  const { entry, usageLimits } = props.block;
  const creditsLabel = usageCreditsLabel(usageLimits);
  const stale = isUsageStale(usageLimits, props.nowMs);

  return (
    <div
      className={cn(
        "flex flex-col gap-[3px] px-2 pt-[5px] pb-1.5 not-first:border-t not-first:border-sidebar-border/40",
        // Stale data is dimmed, never hidden — a number an hour old still
        // tells the user roughly where they stand.
        stale && "opacity-55",
      )}
    >
      <div className="flex items-center gap-1.5">
        <ProviderInstanceIcon
          className="size-[13px]"
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          iconClassName="size-[13px]"
          {...(entry.accentColor !== undefined ? { accentColor: entry.accentColor } : {})}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-sidebar-foreground">
          {entry.displayName}
        </span>
        {usageLimits.planLabel ? (
          <span className="shrink-0 text-[10px] text-sidebar-muted-foreground">
            {usageLimits.planLabel}
          </span>
        ) : null}
      </div>

      {creditsLabel ? (
        <div className="text-[9.5px] tabular-nums text-sidebar-muted-foreground">
          {creditsLabel}
        </div>
      ) : (
        usageLimits.windows.map((window, index) => (
          <SidebarUsageWindowRow
            key={`${window.label}:${window.windowDurationMins ?? index}`}
            nowMs={props.nowMs}
            window={window}
          />
        ))
      )}
    </div>
  );
}

function SidebarUsageWindowRow(props: {
  readonly window: ServerProviderUsageLimits["windows"][number];
  readonly nowMs: number;
}) {
  const usedPercent = clampPercent(props.window.usedPercent);
  const label = usageWindowLabel(props.window);
  const value = usageRowValueLabel(props.window, props.nowMs);
  const severity = usageSeverity(usedPercent);

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-5 shrink-0 text-[9.5px] tabular-nums text-sidebar-muted-foreground">
        {label}
      </span>
      <span
        aria-label={`${label} usage`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(usedPercent)}
        aria-valuetext={`${Math.round(usedPercent)}% used`}
        className="h-[3px] flex-1 overflow-hidden rounded-full bg-sidebar-foreground/12"
        role="progressbar"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
            SEVERITY_BAR_CLASS[severity],
          )}
          style={{ width: `${usedPercent}%` }}
        />
      </span>
      <span
        className={cn(
          "w-7 shrink-0 text-right text-[9.5px] tabular-nums",
          value.kind === "reset" ? "text-destructive" : "text-sidebar-muted-foreground",
        )}
      >
        {value.text}
      </span>
    </div>
  );
}

function selectProviderInstanceSettings(
  settings: ServerConfig["settings"],
): UsageEnvironment["settings"] {
  return { providerInstances: settings.providerInstances, providers: settings.providers };
}

/**
 * Wall clock rounded to the usage tick. Only the usage footer re-renders on
 * each tick; nothing above it subscribes.
 */
function useCoarseNow(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, USAGE_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return nowMs;
}
