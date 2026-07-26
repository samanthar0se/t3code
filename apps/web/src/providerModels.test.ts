import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderInteractionModeToggle,
  getProviderRuntimeModeToggle,
} from "./providerModels.ts";

const PI = ProviderDriverKind.make("pi");

const providerSnapshot = (
  overrides: Pick<ServerProvider, "showInteractionModeToggle" | "showRuntimeModeToggle">,
): ServerProvider =>
  ({
    instanceId: "pi",
    driver: PI,
    ...overrides,
  }) as ServerProvider;

describe("provider mode capabilities", () => {
  it("honors provider snapshots that disable both mode controls", () => {
    const providers = [
      providerSnapshot({
        showInteractionModeToggle: false,
        showRuntimeModeToggle: false,
      }),
    ];
    expect(getProviderInteractionModeToggle(providers, PI)).toBe(false);
    expect(getProviderRuntimeModeToggle(providers, PI)).toBe(false);
  });

  it("keeps both controls enabled for legacy provider snapshots", () => {
    const providers = [
      providerSnapshot({
        showInteractionModeToggle: undefined,
        showRuntimeModeToggle: undefined,
      }),
    ];
    expect(getProviderInteractionModeToggle(providers, PI)).toBe(true);
    expect(getProviderRuntimeModeToggle(providers, PI)).toBe(true);
  });
});
