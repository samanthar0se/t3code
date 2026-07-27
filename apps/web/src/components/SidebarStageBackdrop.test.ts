import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarStageBackdropVariant } from "./SidebarStageBackdrop";

describe("resolveSidebarStageBackdropVariant", () => {
  it("does not apply preview chrome to the fork's nightly channel", () => {
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBeNull();
  });

  it("keeps the development blueprint chrome", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
  });
});
