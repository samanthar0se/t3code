import { describe, expect, it } from "vite-plus/test";

import { resolveAppZoomLayout } from "./AppZoomSync";

describe("resolveAppZoomLayout", () => {
  it("provides the zoom-adjusted viewport height used by fixed app chrome", () => {
    expect(resolveAppZoomLayout(150, 900)).toEqual({
      bodyHeight: "600px",
      viewportHeight: "600px",
      zoom: "150%",
    });
  });
});
