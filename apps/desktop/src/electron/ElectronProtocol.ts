import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly renderer:
    | {
        readonly _tag: "Proxy";
        readonly targetOrigin: URL;
      }
    | {
        readonly _tag: "Static";
        readonly rootDirectory: string;
      };
  readonly clerkFrontendApiHostname: string | undefined;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const existingStaticFile = Effect.fn("desktop.electron.protocol.existingStaticFile")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  candidate: string,
) {
  const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
  if (Option.isNone(info)) return null;
  if (info.value.type === "File") return candidate;
  if (info.value.type !== "Directory") return null;
  const indexPath = path.join(candidate, "index.html");
  const indexInfo = yield* fileSystem.stat(indexPath).pipe(Effect.option);
  return Option.isSome(indexInfo) && indexInfo.value.type === "File" ? indexPath : null;
});

function decodeStaticPathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

const staticRequest = Effect.fn("desktop.electron.protocol.staticRequest")(function* (
  request: Request,
  rootDirectory: string,
  contentSecurityPolicy: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const decodedPath = decodeStaticPathname(requestUrl.pathname);
  if (decodedPath === null) {
    return new Response("Invalid static file path", { status: 400 });
  }

  const rawRelativePath = decodedPath.replaceAll("\\", "/").replace(/^\/+/u, "");
  const normalizedRelativePath = path.normalize(rawRelativePath || "index.html");
  if (
    normalizedRelativePath === ".." ||
    normalizedRelativePath.startsWith(`..${path.sep}`) ||
    normalizedRelativePath.includes("\0")
  ) {
    return new Response("Invalid static file path", { status: 400 });
  }

  const staticRoot = path.resolve(rootDirectory);
  const candidate = path.resolve(staticRoot, normalizedRelativePath);
  const insideRoot =
    candidate === staticRoot ||
    candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);
  if (!insideRoot) {
    return new Response("Invalid static file path", { status: 400 });
  }

  let filePath = yield* existingStaticFile(fileSystem, path, candidate);
  if (filePath === null && path.extname(normalizedRelativePath) === "") {
    filePath = yield* existingStaticFile(fileSystem, path, path.join(staticRoot, "index.html"));
  }
  if (filePath === null) {
    return new Response(null, { status: 404 });
  }

  const headers = new Headers({
    "Content-Security-Policy": contentSecurityPolicy,
    "Content-Type":
      CONTENT_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
  });
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const content = yield* fileSystem.readFile(filePath);
  const body = new Uint8Array(content.byteLength);
  body.set(content);
  return new Response(body.buffer, { status: 200, headers });
});

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);
      const renderer = input.renderer;
      if (renderer._tag === "Static") {
        const rootDirectory = renderer.rootDirectory;
        yield* fileSystem
          .access(path.join(rootDirectory, "index.html"))
          .pipe(
            Effect.mapError(
              (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
            ),
          );
      }

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) => {
              if (renderer._tag === "Static") {
                return runPromise(
                  staticRequest(
                    request,
                    renderer.rootDirectory,
                    contentSecurityPolicy,
                    fileSystem,
                    path,
                  ),
                );
              }
              return proxyRequest(request, renderer.targetOrigin, contentSecurityPolicy);
            });
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
