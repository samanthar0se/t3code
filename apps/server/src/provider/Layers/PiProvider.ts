import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  extractAvailableCommands,
  extractAvailableModels,
  makePiRpcTransport,
  type PiAvailableCommand,
  piModelInfoToServerModel,
} from "./PiRpcClient.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  showRuntimeModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

// Outer hard wall on the whole discovery effect. `transport.request` has its own
// per-request timeout (see PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS below); keep the
// outer wall strictly larger so the inner request owns cleanup/logging and the
// outer only fires as a defensive backstop.
const PI_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS = 14_000;
// Pi can spend several seconds loading extensions before printing its version.
// Keep this provider-specific probe above the shared 4-second CLI default.
const PI_VERSION_PROBE_TIMEOUT_MS = 15_000;

type PiProviderDiscovery = {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
};

const EMPTY_PI_PROVIDER_DISCOVERY: PiProviderDiscovery = {
  models: [],
  slashCommands: [],
  skills: [],
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runPiVersion = Effect.fn("runPiVersion")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const binaryPath = piSettings.binaryPath || "pi";
  const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
    env: environment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(binaryPath, command);
});

function piCommandsToProviderMetadata(
  commands: ReadonlyArray<PiAvailableCommand>,
): Pick<PiProviderDiscovery, "slashCommands" | "skills"> {
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];

  for (const command of commands) {
    if (command.source !== "skill") {
      slashCommands.push({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
      });
      continue;
    }

    const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : "";
    if (!name || !command.path) continue;
    skills.push({
      name,
      ...(command.description ? { description: command.description } : {}),
      path: command.path,
      ...(command.location ? { scope: command.location } : {}),
      enabled: true,
    });
  }

  return { slashCommands, skills };
}

/** Discover provider metadata via a short-lived `pi --mode rpc` session. */
export const discoverPiProviderViaRpc = Effect.fn("discoverPiProviderViaRpc")(
  function* (piSettings: PiSettings, cwd: string, environment: NodeJS.ProcessEnv) {
    const transport = yield* makePiRpcTransport({
      binaryPath: piSettings.binaryPath || "pi",
      args: ["--mode", "rpc", "--no-session", "--approve"],
      cwd,
      env: environment,
      onExit: Effect.void,
    });
    const [modelsResponse, commandsResponse] = yield* Effect.all(
      [
        transport.request(
          { type: "get_available_models" },
          "pi-model-discovery",
          PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS,
        ),
        transport
          .request(
            { type: "get_commands" },
            "pi-command-discovery",
            PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS,
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Pi command discovery failed", { cause }).pipe(
                Effect.as(undefined),
              ),
            ),
          ),
      ],
      { concurrency: "unbounded" },
    );
    const commands = piCommandsToProviderMetadata(extractAvailableCommands(commandsResponse));
    return {
      models: extractAvailableModels(modelsResponse).map(piModelInfoToServerModel),
      ...commands,
    } satisfies PiProviderDiscovery;
  },
  Effect.scoped,
  Effect.timeoutOption(PI_MODEL_DISCOVERY_TIMEOUT_MS),
  Effect.map(Option.getOrElse(() => EMPTY_PI_PROVIDER_DISCOVERY)),
  Effect.catchCause((cause) =>
    Effect.logWarning("Pi provider discovery failed", { cause }).pipe(
      Effect.as(EMPTY_PI_PROVIDER_DISCOVERY),
    ),
  ),
);

const modelsFromSettings = (
  piSettings: PiSettings,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(discovered, piSettings.customModels, EMPTY_CAPABILITIES);

export const buildInitialPiProviderSnapshot = Effect.fn("buildInitialPiProviderSnapshot")(
  function* (piSettings: PiSettings) {
    const checkedAt = yield* nowIso;
    const models = modelsFromSettings(piSettings, []);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi availability...",
      },
    });
  },
);

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = yield* nowIso;
  const fallbackModels = modelsFromSettings(piSettings, []);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runPiVersion(piSettings, environment).pipe(
    Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail ?? "Pi CLI returned an error during health check.",
      },
    });
  }

  const discovered = yield* discoverPiProviderViaRpc(piSettings, cwd, environment);
  const models = modelsFromSettings(piSettings, discovered.models);

  // no auth query in pi; get_available_models only lists once a key is configured in ~/.pi/agent
  const authenticated = models.length > 0;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovered.slashCommands,
    skills: discovered.skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unknown", type: "pi" },
      ...(authenticated
        ? {}
        : {
            message:
              "Pi is installed but no models are available. Configure a provider or API key in ~/.pi/agent (e.g. run `pi`) so models appear.",
          }),
    },
  });
});
