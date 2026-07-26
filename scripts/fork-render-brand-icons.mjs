#!/usr/bin/env node
// Fork-only icon rasterizer.
//
// Upstream regenerates the tracked PNG/ICO assets with Icon Composer, which is
// macOS-only (`vp run icons:export`). This script renders the same Icon
// Composer layer stack with headless Chrome so the ">_" dev icon can be
// regenerated from Windows. It is a stand-in for the official exporter, not a
// replacement: re-run `vp run icons:export` on macOS when that is available.
//
// Usage: node scripts/fork-render-brand-icons.mjs

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const projectDir = NodePath.join(repoRoot, "assets", "dev", "app-icon.icon");
const outputDir = NodePath.join(repoRoot, "assets", "dev");
const publicDir = NodePath.join(repoRoot, "apps", "web", "public");
const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-icons-"));

// Matches assets/dev/app-icon.icon/icon.json.
const BACKGROUND_SCALE = 8.1;
const FOREGROUND_SCALE = 8.5;
const DESIGN_SIZE = 128;
const CANVAS = 1024;
const CORNER_RADIUS = 225;

const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const DESKTOP_RESOURCE_ICO_SIZES = [16, 32, 48, 256];
const RENDER_SIZES = [...new Set([...WINDOWS_ICON_SIZES, 180, 512, 1024])].sort((a, b) => a - b);

function readLayer(name) {
  const svg = NodeFS.readFileSync(NodePath.join(projectDir, "Assets", name), "utf8");
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return body.trim();
}

function centered(scale) {
  const offset = (CANVAS - DESIGN_SIZE * scale) / 2;
  return `translate(${offset} ${offset}) scale(${scale})`;
}

function buildCompositeSvg() {
  const background = readLayer("background.svg");
  const annotations = readLayer("annotations.svg");
  const text = readLayer("text.svg");

  // Icon Composer renders the "Text" layer with a glass material: a soft
  // contact shadow plus a lighter top-left edge. Approximated with a blurred
  // drop shadow under a slightly offset white copy of the mark.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">
  <defs>
    <clipPath id="squircle">
      <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"/>
    </clipPath>
    <filter id="markShadow" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="9" stdDeviation="9" flood-color="#07206E" flood-opacity="0.42"/>
    </filter>
    <filter id="rimGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="${CANVAS}" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF" stop-opacity="0.85"/>
      <stop offset="0.5" stop-color="#CDE9FF" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0.55"/>
    </linearGradient>
  </defs>

  <g clip-path="url(#squircle)">
    <g transform="${centered(BACKGROUND_SCALE)}">${background}</g>
    <g transform="${centered(FOREGROUND_SCALE)}">${annotations}</g>
    <g filter="url(#markShadow)">
      <g transform="${centered(FOREGROUND_SCALE)}">${text.replaceAll('"white"', '"#C3D3EC"')}</g>
      <g transform="${centered(FOREGROUND_SCALE)} translate(-0.7 -0.9)">${text}</g>
    </g>

    <rect x="6" y="6" width="${CANVAS - 12}" height="${CANVAS - 12}" rx="${CORNER_RADIUS - 6}" fill="none" stroke="url(#rim)" stroke-width="12" filter="url(#rimGlow)" opacity="0.75"/>
    <rect x="3" y="3" width="${CANVAS - 6}" height="${CANVAS - 6}" rx="${CORNER_RADIUS - 3}" fill="none" stroke="#F4FBFF" stroke-width="2.5" opacity="0.5"/>
  </g>
</svg>
`;
}

/**
 * The macOS icon keeps the classic safe area: an 824x824 opaque body inset
 * 100px on every side of a 1024x1024 canvas, with only the shadow reaching
 * past it. The shadow is an SVG filter rather than a CSS `drop-shadow`, which
 * headless Chrome renders unblurred.
 */
function buildMacosSvg(iconSvg) {
  const inset = 100;
  const body = CANVAS - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">
  <defs>
    <filter id="macShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#0A1740" flood-opacity="0.3"/>
    </filter>
  </defs>
  <g filter="url(#macShadow)" transform="translate(${inset} ${inset}) scale(${body / CANVAS})">
    ${iconSvg}
  </g>
</svg>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome/Edge binary found. Set CHROME_PATH.");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives Chrome over CDP. `--screenshot` with `--window-size` is not usable
 * here: Chrome clamps the window to a platform minimum, so small sizes come
 * back as crops of an oversized render. Page.captureScreenshot takes an
 * explicit clip instead, which is exact at every size.
 */
async function launchChrome(chrome) {
  const profileDir = NodePath.join(workDir, "profile");
  const child = NodeChildProcess.spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const portFile = NodePath.join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // Chrome briefly holds an exclusive lock while writing this file.
      const port = NodeFS.readFileSync(portFile, "utf8").split("\n")[0]?.trim();
      if (port) return { child, port: Number(port) };
    } catch {
      // Not written (or not readable) yet.
    }
    await delay(100);
  }
  child.kill();
  throw new Error("Chrome did not expose a DevTools port.");
}

async function connect(port, htmlPath) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params) => {
    const id = (nextId += 1);
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  await send("Page.enable", {});
  await send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  await send("Page.navigate", { url: NodeURL.pathToFileURL(htmlPath).href });
  await delay(600);

  return { send, close: () => socket.close() };
}

async function renderSize(page, size) {
  await page.send("Runtime.evaluate", {
    expression: `
      (() => {
        const stage = document.getElementById("stage");
        stage.style.width = "${size}px";
        stage.style.height = "${size}px";
        return new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      })()
    `,
    awaitPromise: true,
  });

  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
  });

  const contents = Buffer.from(data, "base64");
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`Expected a ${size}x${size} render, got ${width}x${height}.`);
  }
  return contents;
}

function encodePngIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(image.size === 256 ? 0 : image.size, entry);
    header.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.contents.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.contents.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.contents)]);
}

function write(relativePath, contents) {
  const target = NodePath.join(repoRoot, relativePath);
  NodeFS.writeFileSync(target, contents);
  console.log(`wrote ${relativePath} (${contents.length} bytes)`);
}

const svg = buildCompositeSvg();
NodeFS.writeFileSync(NodePath.join(workDir, "icon.svg"), svg);
const htmlPath = NodePath.join(workDir, "icon.html");
NodeFS.writeFileSync(
  htmlPath,
  `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    #stage{position:absolute;top:0;left:0}
    #stage>svg{display:block;width:100%;height:100%}
  </style><div id="stage">${svg}</div>`,
);

// The macOS icon keeps the classic safe area: an 824x824 body inset 100px on
// every side of a 1024x1024 canvas, with only the shadow outside it.
const macosHtml = NodePath.join(workDir, "macos.html");
NodeFS.writeFileSync(
  macosHtml,
  `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    #stage{position:absolute;top:0;left:0}
    #stage>svg{display:block;width:100%;height:100%}
  </style><div id="stage">${buildMacosSvg(svg)}</div>`,
);

const chrome = findChrome();
console.log(`rendering with ${chrome}`);
const { child, port } = await launchChrome(chrome);

const rendered = new Map();
const page = await connect(port, htmlPath);
for (const size of RENDER_SIZES) {
  rendered.set(size, await renderSize(page, size));
  console.log(`  rendered ${size}x${size}`);
}
page.close();

const macosPage = await connect(port, macosHtml);
const macosPng = await renderSize(macosPage, 1024);
macosPage.close();
child.kill();

const png = (size) => rendered.get(size);

write("assets/dev/blueprint-ios-1024.png", png(1024));
write("assets/dev/blueprint-universal-1024.png", png(1024));
write("assets/dev/blueprint-web-apple-touch-180.png", png(180));
write("assets/dev/blueprint-web-favicon-32x32.png", png(32));
write("assets/dev/blueprint-web-favicon-16x16.png", png(16));

const icoImages = WINDOWS_ICON_SIZES.map((size) => ({ size, contents: png(size) }));
write("assets/dev/blueprint-windows.ico", encodePngIco(icoImages));
write("assets/dev/blueprint-web-favicon.ico", encodePngIco(icoImages));

write("assets/dev/blueprint-macos-1024.png", macosPng);

// Electron reads these directly in dev: icon.ico is the Windows window/taskbar
// icon, icon.png the Linux one. icon.icns is left alone — packaging rebuilds it
// from the production artwork with iconutil on macOS.
write("apps/desktop/resources/icon.png", png(512));
write(
  "apps/desktop/resources/icon.ico",
  encodePngIco(DESKTOP_RESOURCE_ICO_SIZES.map((size) => ({ size, contents: png(size) }))),
);

// apps/web/public mirrors the development web exports (see brand-assets.ts).
for (const [source, target] of [
  ["assets/dev/blueprint-web-favicon.ico", "favicon.ico"],
  ["assets/dev/blueprint-web-favicon-16x16.png", "favicon-16x16.png"],
  ["assets/dev/blueprint-web-favicon-32x32.png", "favicon-32x32.png"],
  ["assets/dev/blueprint-web-apple-touch-180.png", "apple-touch-icon.png"],
]) {
  NodeFS.copyFileSync(NodePath.join(repoRoot, source), NodePath.join(publicDir, target));
  console.log(`copied ${source} -> apps/web/public/${target}`);
}

// Chrome can still be releasing its profile lock; cleanup is best-effort.
try {
  NodeFS.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
  console.log(`note: could not remove ${workDir}`);
}
console.log(`\nDone. Outputs in ${NodePath.relative(repoRoot, outputDir)} and apps/web/public.`);
