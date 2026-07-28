import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius?: number;
  readonly visibility?: "visible";
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly appZoom: number;
  readonly cornerRadius?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const { active, appZoom, cornerRadius = 0, hiddenSize, rect } = input;
  // Surface slots report visual viewport pixels. The wrapper lives under the
  // zoomed body, so cancel app zoom before applying those already-scaled values.
  const inverseAppZoom = 100 / appZoom;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zoom: inverseAppZoom,
      zIndex: 30,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  return {
    left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zoom: inverseAppZoom,
    zIndex: -1,
    pointerEvents: "none",
    // Keep the guest CSS-visible even while physically offscreen. Electron
    // webviews can keep metadata/status alive under `visibility:hidden` while
    // CDP Runtime/Input commands stall, which breaks offscreen automation.
    visibility: "visible",
  };
}
