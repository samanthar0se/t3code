import { useEffect } from "react";

import { useClientSettings } from "../hooks/useSettings";

export function resolveAppZoomLayout(appZoom: number, viewportHeight: number) {
  const zoomFactor = appZoom / 100;
  const zoomAdjustedViewportHeight = `${viewportHeight / zoomFactor}px`;
  return {
    bodyHeight: zoomAdjustedViewportHeight,
    viewportHeight: zoomAdjustedViewportHeight,
    zoom: `${appZoom}%`,
  };
}

export function AppZoomSync() {
  const appZoom = useClientSettings((settings) => settings.appZoom);

  useEffect(() => {
    const applyZoom = () => {
      const layout = resolveAppZoomLayout(appZoom, window.innerHeight);
      document.body.style.zoom = layout.zoom;
      document.body.style.minHeight = "0";
      document.body.style.height = layout.bodyHeight;
      document.body.style.setProperty("--app-viewport-height", layout.viewportHeight);
    };

    applyZoom();
    window.addEventListener("resize", applyZoom);
    return () => {
      window.removeEventListener("resize", applyZoom);
      document.body.style.removeProperty("zoom");
      document.body.style.removeProperty("min-height");
      document.body.style.removeProperty("height");
      document.body.style.removeProperty("--app-viewport-height");
    };
  }, [appZoom]);

  return null;
}
