import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatTimeToReset,
  hasRenderableUsage,
  isUsageStale,
  usageCreditsLabel,
  usageRowResetLabel,
  usageRowValueLabel,
  usageSeverity,
  usageWindowLabel,
} from "./SidebarUsage.logic";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function limits(overrides: Partial<ServerProviderUsageLimits> = {}): ServerProviderUsageLimits {
  return {
    source: "codexAppServer",
    checkedAt: "2026-07-27T12:00:00.000Z",
    windows: [],
    ...overrides,
  };
}

describe("usageWindowLabel", () => {
  it("derives the label from the reported duration, not the provider's prose", () => {
    expect(usageWindowLabel({ label: "Session", usedPercent: 10, windowDurationMins: 300 })).toBe(
      "5h",
    );
    expect(usageWindowLabel({ label: "Weekly", usedPercent: 10, windowDurationMins: 10080 })).toBe(
      "7d",
    );
  });

  it("labels a window shape neither provider reports today", () => {
    expect(usageWindowLabel({ label: "Rolling", usedPercent: 10, windowDurationMins: 1440 })).toBe(
      "1d",
    );
    expect(usageWindowLabel({ label: "Burst", usedPercent: 10, windowDurationMins: 45 })).toBe(
      "45m",
    );
  });

  it("falls back to the provider label when no duration is reported", () => {
    expect(usageWindowLabel({ label: "Weekly (Opus)", usedPercent: 10 })).toBe("Weekly (Opus)");
    expect(usageWindowLabel({ label: "Session", usedPercent: 10, windowDurationMins: 0 })).toBe(
      "Session",
    );
  });
});

describe("usageSeverity", () => {
  it("buckets at the shared thresholds", () => {
    expect(usageSeverity(0)).toBe("ok");
    expect(usageSeverity(74.9)).toBe("ok");
    expect(usageSeverity(75)).toBe("warn");
    expect(usageSeverity(94)).toBe("warn");
    expect(usageSeverity(95)).toBe("hot");
    expect(usageSeverity(100)).toBe("hot");
  });
});

describe("formatTimeToReset", () => {
  it("formats hours and zero-padded minutes", () => {
    expect(formatTimeToReset("2026-07-27T14:08:00.000Z", NOW)).toBe("2h 08m");
  });

  it("drops the hour component under an hour", () => {
    expect(formatTimeToReset("2026-07-27T12:20:00.000Z", NOW)).toBe("20m");
  });

  it("returns null for a reset that has already passed", () => {
    expect(formatTimeToReset("2026-07-27T11:00:00.000Z", NOW)).toBeNull();
  });

  it("returns null rather than 'Invalid Date' for unparseable input", () => {
    expect(formatTimeToReset("not-a-date", NOW)).toBeNull();
  });
});

describe("usageRowValueLabel", () => {
  it("shows the percentage below 100%", () => {
    expect(
      usageRowValueLabel(
        { label: "Session", usedPercent: 82, resetsAt: "2026-07-27T14:08:00.000Z" },
        NOW,
      ),
    ).toEqual({ kind: "percent", text: "82%" });
  });

  it("swaps in the countdown at 100%", () => {
    expect(
      usageRowValueLabel(
        { label: "Session", usedPercent: 100, resetsAt: "2026-07-27T14:08:00.000Z" },
        NOW,
      ),
    ).toEqual({ kind: "reset", text: "2h 08m" });
  });

  it("keeps the percentage at 100% when no reset time is known", () => {
    expect(usageRowValueLabel({ label: "Session", usedPercent: 100 }, NOW)).toEqual({
      kind: "percent",
      text: "100%",
    });
  });

  it("keeps the percentage at 100% when the reset time has passed", () => {
    expect(
      usageRowValueLabel(
        { label: "Session", usedPercent: 100, resetsAt: "2026-07-27T11:00:00.000Z" },
        NOW,
      ),
    ).toEqual({ kind: "percent", text: "100%" });
  });
});

describe("usageRowResetLabel", () => {
  it("returns the countdown whenever a future reset is known", () => {
    expect(
      usageRowResetLabel(
        { label: "Session", usedPercent: 82, resetsAt: "2026-07-27T14:08:00.000Z" },
        NOW,
      ),
    ).toBe("2h 08m");
  });

  it("returns null when the reset is missing or past", () => {
    expect(usageRowResetLabel({ label: "Session", usedPercent: 82 }, NOW)).toBeNull();
    expect(
      usageRowResetLabel(
        { label: "Session", usedPercent: 82, resetsAt: "2026-07-27T11:00:00.000Z" },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("isUsageStale", () => {
  it("treats a snapshot older than ten minutes as stale", () => {
    expect(isUsageStale(limits({ checkedAt: "2026-07-27T11:49:00.000Z" }), NOW)).toBe(true);
    expect(isUsageStale(limits({ checkedAt: "2026-07-27T11:55:00.000Z" }), NOW)).toBe(false);
  });
});

describe("hasRenderableUsage", () => {
  it("renders any snapshot carrying windows", () => {
    expect(hasRenderableUsage(limits({ windows: [{ label: "Session", usedPercent: 4 }] }))).toBe(
      true,
    );
  });

  it("renders a metered account with a balance and no windows", () => {
    expect(hasRenderableUsage(limits({ credits: { balance: "$18.40", unlimited: false } }))).toBe(
      true,
    );
  });

  it("renders nothing for an unlimited account", () => {
    expect(hasRenderableUsage(limits({ credits: { unlimited: true } }))).toBe(false);
  });

  it("renders nothing for a snapshot with neither windows nor credits", () => {
    expect(hasRenderableUsage(limits())).toBe(false);
  });
});

describe("usageCreditsLabel", () => {
  it("labels a balance when windows are absent", () => {
    expect(usageCreditsLabel(limits({ credits: { balance: "$18.40", unlimited: false } }))).toBe(
      "$18.40 credits",
    );
  });

  it("defers to windows when both are present", () => {
    expect(
      usageCreditsLabel(
        limits({
          windows: [{ label: "Session", usedPercent: 4 }],
          credits: { balance: "$18.40", unlimited: false },
        }),
      ),
    ).toBeNull();
  });

  it("shows nothing for an unlimited account", () => {
    expect(usageCreditsLabel(limits({ credits: { unlimited: true } }))).toBeNull();
  });
});
