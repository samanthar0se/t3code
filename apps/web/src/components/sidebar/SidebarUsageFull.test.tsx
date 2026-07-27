import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarUsageBlocksForTest } from "./SidebarUsageFull";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function provider(input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly usageLimits?: ServerProvider["usageLimits"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? "codex"),
    provider: ProviderDriverKind.make(input.driver ?? "codex"),
    displayName: input.displayName ?? "Codex",
    enabled: input.enabled ?? true,
    installed: true,
    status: "ready",
    checkedAt: "2026-07-27T12:00:00.000Z",
    models: [],
    skills: [],
    ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
  } as unknown as ServerProvider;
}

function render(
  providers: ReadonlyArray<ServerProvider>,
  providerInstances: Record<string, { readonly enabled?: boolean }> = {},
): string {
  return renderToStaticMarkup(
    <SidebarUsageBlocksForTest
      nowMs={NOW}
      providers={providers}
      settings={
        { providerInstances, providers: {} } as unknown as Parameters<
          typeof SidebarUsageBlocksForTest
        >[0]["settings"]
      }
    />,
  );
}

describe("SidebarUsageFull blocks", () => {
  it("renders one row per reported window, labelled by duration", () => {
    const markup = render([
      provider({
        instanceId: "codex",
        usageLimits: {
          source: "codexAppServer",
          checkedAt: "2026-07-27T12:00:00.000Z",
          planLabel: "Pro",
          windows: [
            { label: "Session", usedPercent: 42, windowDurationMins: 300 },
            { label: "Weekly", usedPercent: 80, windowDurationMins: 10080 },
          ],
        },
      }),
    ]);

    expect(markup).toContain("Pro");
    expect(markup).toContain(">5h<");
    expect(markup).toContain(">42%<");
    expect(markup).toContain(">7d<");
    expect(markup).toContain(">80%<");
  });

  it("renders a single row when only one window is reported", () => {
    const markup = render([
      provider({
        instanceId: "codex",
        usageLimits: {
          source: "codexAppServer",
          checkedAt: "2026-07-27T12:00:00.000Z",
          windows: [{ label: "Session", usedPercent: 12, windowDurationMins: 300 }],
        },
      }),
    ]);

    expect(markup.match(/role="progressbar"/g)).toHaveLength(1);
  });

  it("swaps the percentage for a countdown at 100%", () => {
    const markup = render([
      provider({
        instanceId: "codex",
        usageLimits: {
          source: "codexAppServer",
          checkedAt: "2026-07-27T12:00:00.000Z",
          windows: [
            {
              label: "Session",
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: "2026-07-27T14:08:00.000Z",
            },
          ],
        },
      }),
    ]);

    expect(markup).toContain("2h 08m");
    expect(markup).not.toContain(">100%<");
  });

  it("shows a credit balance in place of window rows", () => {
    const markup = render([
      provider({
        instanceId: "codex",
        usageLimits: {
          source: "codexAppServer",
          checkedAt: "2026-07-27T12:00:00.000Z",
          windows: [],
          credits: { balance: "$18.40", unlimited: false },
        },
      }),
    ]);

    expect(markup).toContain("$18.40 credits");
    expect(markup).not.toContain("progressbar");
  });

  it("dims a stale snapshot rather than hiding it", () => {
    const markup = render([
      provider({
        instanceId: "codex",
        usageLimits: {
          source: "codexAppServer",
          checkedAt: "2026-07-27T11:00:00.000Z",
          windows: [{ label: "Session", usedPercent: 12, windowDurationMins: 300 }],
        },
      }),
    ]);

    expect(markup).toContain("opacity-55");
    expect(markup).toContain(">12%<");
  });

  it("omits providers with no snapshot, an unlimited plan, or disabled instances", () => {
    expect(render([provider({ instanceId: "codex" })])).toBe("");
    expect(
      render([
        provider({
          instanceId: "codex",
          usageLimits: {
            source: "codexAppServer",
            checkedAt: "2026-07-27T12:00:00.000Z",
            windows: [],
            credits: { unlimited: true },
          },
        }),
      ]),
    ).toBe("");
    expect(
      render([
        provider({
          instanceId: "codex",
          enabled: false,
          usageLimits: {
            source: "codexAppServer",
            checkedAt: "2026-07-27T12:00:00.000Z",
            windows: [{ label: "Session", usedPercent: 12, windowDurationMins: 300 }],
          },
        }),
      ]),
    ).toBe("");
  });

  it("renders two instances of one driver as separate blocks", () => {
    const markup = render(
      [
        provider({
          instanceId: "codex",
          usageLimits: {
            source: "codexAppServer",
            checkedAt: "2026-07-27T12:00:00.000Z",
            windows: [{ label: "Session", usedPercent: 12, windowDurationMins: 300 }],
          },
        }),
        provider({
          instanceId: "codex_work",
          usageLimits: {
            source: "codexAppServer",
            checkedAt: "2026-07-27T12:00:00.000Z",
            windows: [{ label: "Session", usedPercent: 64, windowDurationMins: 300 }],
          },
        }),
      ],
      { codex: { enabled: true }, codex_work: { enabled: true } },
    );

    expect(markup).toContain("Codex Work");
    expect(markup).toContain(">12%<");
    expect(markup).toContain(">64%<");
  });
});
