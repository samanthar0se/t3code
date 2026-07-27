import { useEffect } from "react";

import { useClientSettings } from "../hooks/useSettings";

export function AppZoomSync() {
  const appZoom = useClientSettings((settings) => settings.appZoom);

  useEffect(() => {
    const zoomFactor = appZoom / 100;
    const applyZoom = () => {
      document.body.style.zoom = `${appZoom}%`;
      document.body.style.minHeight = "0";
      document.body.style.height = `${window.innerHeight / zoomFactor}px`;
    };

    applyZoom();
    window.addEventListener("resize", applyZoom);
    return () => {
      window.removeEventListener("resize", applyZoom);
      document.body.style.removeProperty("zoom");
      document.body.style.removeProperty("min-height");
      document.body.style.removeProperty("height");
    };
  }, [appZoom]);

  return null;
}
