# Pi provider handoff: PR #4355

Date reviewed: 2026-07-26
Candidate: [pingdotgg/t3code PR #4355, “feat: add Pi provider integration via RPC”](https://github.com/pingdotgg/t3code/pull/4355)
Reviewed head: [`0bc5db3722c070bd15698da51633657e5bbdf40b`](https://github.com/pingdotgg/t3code/commit/0bc5db3722c070bd15698da51633657e5bbdf40b)

## Recommendation

Use #4355 as implementation material, not as a merge-ready patch.

It is the strongest Pi-specific starting point I found: it follows the requested native JSONL RPC direction, fits the existing provider-driver shape, has a broad vertical slice, and includes substantial focused tests. The author also incorporated four follow-up hardening commits after the initial implementation. However, the patch is large (5,981 additions across 34 files), its UI advertises an interaction mode it does not implement, its thinking choices have already drifted from Pi, and its safety boundary depends on a custom extension whose behavior and packaging need independent verification. The open orchestrator-v2 work is also replacing the lifecycle model underneath this adapter.

The practical path is to port the reusable transport and event-mapping ideas onto a fresh branch from current `main`, while making Pi support explicitly experimental and keeping the changes separable enough to rebase onto orchestrator v2.

## Why #4355 is worth using

The originating [Pi provider issue #402](https://github.com/pingdotgg/t3code/issues/402) asks for Pi to use the normal provider/orchestration flow, native RPC, dynamic models, real thinking options, safe startup/send failure handling, configured-binary support, and no static fallback models. #4355 follows that direction rather closely:

- A Pi-only `ProviderDriver`, provider snapshot, adapter, JSONL RPC client, and text-generation service.
- Per-thread `pi --mode rpc` subprocesses, correlated responses, streamed events, image prompts, steering, model switches, thinking changes, rollback/fork, and session cleanup.
- Dynamic `get_available_models` discovery with no static Pi default.
- Canonical session, turn, assistant-text, reasoning, tool, approval, and user-input events.
- A default-deny approval extension, load handshake, and fail-closed startup for gated modes.
- Settings, provider-instance UI, model picker, icons, documentation, mocks, and focused tests.

The PR description reports 168 passing tests across ten affected files, targeted type/lint/format checks, and an isolated browser pass. Treat that as useful author evidence, but repeat verification locally because the PR was never accepted or merged. See the [PR description and checks summary](https://github.com/pingdotgg/t3code/pull/4355#issue-3449782712).

## Reusable pieces

### 1. JSONL RPC transport

[`PiRpcClient.ts`](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiRpcClient.ts) is the clearest reusable unit. It spawns without a shell, writes newline-delimited commands, classifies responses/events/extension UI messages, correlates request IDs, drains stderr, ends queues on exit, races requests against process closure, and places the process in an Effect scope. Pi explicitly documents RPC mode as a headless JSON protocol for custom UIs and also points to its own subprocess TypeScript client as a reference ([official RPC docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)).

Retain the small parsing and command-building helpers and their tests. Re-evaluate whether to keep the subprocess boundary or use `AgentSession` in-process: Pi’s docs recommend considering `AgentSession` for Node/TypeScript applications, while issue #402 deliberately chose RPC. The subprocess boundary is reasonable for isolation and compatibility, but the choice should be recorded.

### 2. Native model discovery and switching

[`PiProvider.ts`](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiProvider.ts) uses a short-lived, scoped RPC session and `get_available_models`; [`PiAdapter.ts`](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiAdapter.ts) uses `set_model` for live switches. These are native RPC operations documented by Pi, and dynamic discovery satisfies #402’s explicit “no fake fallback models” requirement ([RPC model commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#get_available_models)).

### 3. Event mapping and lifecycle hardening

The adapter handles text separately from thinking and tool deltas, prevents empty intermediate steps from becoming assistant messages, ignores retrying `agent_end` events, serializes concurrent sends, reports failed writes, refreshes the resume cursor after a fork, and settles pending extension requests on interruption. Those details directly address failure modes listed in [issue #402](https://github.com/pingdotgg/t3code/issues/402) and several review findings that were resolved by the later commits; the review history is useful regression-test input ([PR review threads](https://github.com/pingdotgg/t3code/pull/4355/files)).

### 4. Rollback, attachments, and text generation

The fork/new-session rollback mapping, base64 image conversion, and structured text-generation flow are useful implementations and tests. Keep them only after confirming the exact Pi version being supported; these are wider than the minimum viable provider and should not block a first working chat slice.

## Concerns to resolve before integration

### Interaction mode is advertised but ignored

The provider snapshot sets `showInteractionModeToggle: true` in [`PiProvider.ts`](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiProvider.ts#L27-L31). The adapter’s `startSession` consumes `runtimeMode`, model selection, cwd, and resume state, but never consumes `input.interactionMode` ([start-session implementation](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiAdapter.ts#L836-L943)). Selecting T3’s Plan mode would therefore change the UI state without changing Pi behavior.

Set `showInteractionModeToggle: false` for the initial integration. Do not synthesize plan mode with a prompt unless product semantics are explicitly designed and tested.

### Thinking options are stale and too static

#4355 hard-codes `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`, omitting `max` ([thinking option table](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiRpcClient.ts#L125-L140)). Current Pi RPC supports `max` and exposes `get_available_thinking_levels`; `xhigh` and `max` are model-dependent ([official thinking commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#set_thinking_level)). Pi settings likewise list `max` ([official settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#model--thinking)).

At minimum add `max`. Prefer deriving choices per selected model from `get_available_thinking_levels` or Pi model metadata so unsupported levels are hidden or clamped honestly. Add tests for a non-reasoning model and a custom model with a sparse `thinkingLevelMap`.

### Approval and security semantics need threat-focused review

Pi does not provide T3’s native per-tool approval policy. #4355 injects [`t3-approvals.ts`](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/assets/pi/t3-approvals.ts), auto-allows five tool names (`read`, `grep`, `find`, `ls`, `glob`), optionally allows four edit names, and gates everything else through extension UI. It verifies a sentinel command before allowing a gated session ([handshake](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiAdapter.ts#L969-L990)).

The fail-closed design is good, but tool-name allowlists are a security boundary:

- Confirm that every built-in, extension, package, MCP, renamed, and future Pi tool passes the `tool_call` hook.
- Confirm “read-only” tools cannot write through arguments, shell expansion, symlinks, or extension substitution.
- Decide whether `acceptForSession` should really collapse to one binary confirmation; #4355 maps it exactly like `accept` and does not establish a durable session rule.
- Confirm cancellation, lost WebSocket clients, transport write failures, and process exit always deny/unblock rather than hang or execute.
- Treat `auto-accept-edits` as T3 policy implemented by this extension, not as Pi-native semantics, and explain that accurately in UI/docs.
- Run adversarial approval tests against custom tools and extensions, not only the bundled mock.

### Project trust can silently change what Pi loads

Current Pi asks about project trust interactively, but RPC mode does not show the prompt. With the default `ask` policy and no stored decision, project-local settings, resources, packages, extensions, and skills are ignored. `--approve` or `--no-approve` can override this for a run ([official project-trust behavior](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#project-trust)).

#4355 starts RPC without either flag. A T3 session can therefore behave differently from an interactive Pi session in the same repository, and the approval extension does not resolve trust for the user’s own project resources. Decide and expose a policy:

- safest initial behavior: pass `--no-approve`, state that project Pi resources are disabled, and avoid hidden trust;
- richer behavior: add an explicit T3 trust decision and pass `--approve` only after user consent;
- never silently force `--approve`.

Test trusted, untrusted, inherited-trust, and malicious project-extension cases.

### Dynamic discovery is useful, but auth inference is not proof of usable credentials

The provider marks Pi authenticated whenever the combined model list is non-empty ([status logic](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiProvider.ts#L211-L232)). Because `modelsFromSettings` appends T3 `customModels`, a manually stored string can produce “authenticated” even if RPC discovery failed. Even discovered model availability is not equivalent to a successful provider request; Pi’s custom configuration can contain unresolved or invalid credentials.

Keep discovery, but report it as “configured/models available,” not authenticated, unless Pi adds a real auth-status operation. Preserve discovery failure separately from an empty valid catalog. Validate a selected model by native provider/id, and surface the first request’s credential failure clearly.

### T3 `customModels` duplicates and weakens Pi’s native model system

#4355 adds a hidden `customModels: string[]` to `PiSettings` and merges those strings into discovered models. Pi already supports custom providers/models, capability metadata, auth references, headers, reasoning maps, and local backends in `~/.pi/agent/models.json` ([official custom-model docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#custom-models)). A T3-only string cannot represent those capabilities and can make discovery/auth state misleading.

For v1, remove or ignore T3 `customModels` for Pi and treat Pi’s native model catalog as authoritative. If backward compatibility requires the field, validate canonical `provider/id` slugs, never count it as auth evidence, label entries as unverified, and assign no invented capabilities.

### Lifecycle and cleanup deserve real-process tests

The final PR is much stronger than its initial commit: the transport closes queues on exit, request effects race against closure, sessions own closeable scopes, startup checks for early process exit, sends are serialized, and the adapter finalizer stops all sessions ([transport lifecycle](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiRpcClient.ts#L314-L420), [adapter finalizer](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/src/provider/Layers/PiAdapter.ts#L1276-L1307)).

Most coverage uses a mock RPC process. Verify with the supported Pi binary that there are no children, pipe readers, fibers, pending deferreds, or approval requests left after:

- spawn failure and immediate exit;
- startup request timeout;
- Ctrl-C/abort during text, tool execution, and approval;
- server shutdown and client disconnect;
- session replacement and rapid open/close;
- model-switch and fork failure;
- discovery timeout;
- Windows process termination, where child-tree semantics often differ.

Also pin a supported Pi version range. #4355 type-checks against `@earendil-works/pi-coding-agent` `^0.80.2` as a development dependency, while it executes a separately installed user binary. Compile-time types therefore do not guarantee runtime protocol compatibility.

### Packaging must make the approval asset inseparable from gated support

The PR copies the TypeScript approval extension beside the server bundle and fails the build if it is missing ([asset copy](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/scripts/cliBuildAssets.ts), [CLI build integration](https://github.com/pingdotgg/t3code/blob/0bc5db3722c070bd15698da51633657e5bbdf40b/apps/server/scripts/cli.ts#L181-L188)). This was added after review caught an unsafe “warning only” path.

Verify the final npm package, desktop bundle, and platform installers—not just the source build. Confirm Pi can load a `.ts` extension from the packaged path on Node/Bun and on Windows, macOS, and Linux. Prefer emitting a stable JavaScript asset if Pi’s loader/transpiler assumptions are not guaranteed. Add a package-content test and a packaged smoke test that proves the sentinel handshake.

### Orchestrator v2 will require deliberate rework

The maintainer closed #4355 with: “we’re not adding providers right now. we’ll reconsider this after our new orchestrator has shipped #2829” ([closure comment](https://github.com/pingdotgg/t3code/pull/4355#issuecomment-5057928022)). [PR #2829](https://github.com/pingdotgg/t3code/pull/2829) is an open, very large orchestration rewrite. Its current description replaces session/turn concepts with run attempts and new provider adapters, changes projections and persistence, and adds a registry/factory flow.

Therefore:

- reuse Pi protocol/transport logic and pure parsers;
- expect to rewrite the `ProviderAdapterShape` boundary and canonical event mapping;
- do not deepen dependencies on the current session/turn projection solely to land Pi;
- keep Pi-specific logic behind a narrow service so the orchestrator-v2 adapter is replaceable;
- decide whether this is a fork-only feature on today’s architecture or work intended to follow #2829. Trying to optimize for both simultaneously will create churn.

## Context from other Pi PRs

- [#3818](https://github.com/pingdotgg/t3code/pull/3818) is the closest predecessor and useful history, but it was also closed pending #2829. #4355 is the later five-commit hardening pass and is the better code source.
- [#2748](https://github.com/pingdotgg/t3code/pull/2748) combines Hermes and Pi through ACP. It is useful only as an alternative-protocol comparison; #402 and #4355 deliberately chose native Pi RPC.
- [#2800](https://github.com/pingdotgg/t3code/pull/2800) is provider/schema/UI groundwork rather than a complete Pi runtime.
- [#2831](https://github.com/pingdotgg/t3code/pull/2831) is an earlier Pi implementation/prototype. Use it only to mine failure cases, not as the integration base.

## Recommended integration sequence

1. Create `feat/pi-provider` from current `main`; do not merge the PR wholesale.
2. Decide the target architecture first:
   - fork feature now: implement against the current provider adapter and accept later rework;
   - upstream-oriented feature: wait for #2829’s adapter seam, then port the Pi transport.
3. Port the JSONL transport, pure parsers, mock process, and focused tests.
4. Pin and probe the Pi protocol/version; add a clear unsupported-version error.
5. Implement the minimum session slice: availability, native model discovery, start, prompt, streaming text/reasoning, interrupt, stop.
6. Hide interaction/plan mode. Implement model-dependent thinking levels including `max`.
7. Choose explicit project-trust behavior.
8. Add the approval extension only after threat-model tests and packaged sentinel verification pass.
9. Add attachments, steering, model switching, rollback/fork, extension user input, and text generation incrementally, each with focused tests.
10. Register the web settings/provider-instance/model UI and run one integrated web verification pass using the repository’s `test-t3-app` workflow.

## Focused verification checklist

### Contracts and model options

- [ ] `pi` driver and settings round-trip through contracts.
- [ ] No static Pi fallback/default model.
- [ ] Native `provider/id` model slugs survive discovery, persistence, resume, and switching.
- [ ] Thinking options match the selected model and include `max` when supported.
- [ ] Plan/interaction toggle is absent until it has real semantics.

### Discovery and configuration

- [ ] Disabled Pi performs no spawn/discovery work.
- [ ] Configured binary path is used for version, discovery, sessions, and text generation.
- [ ] Missing binary, nonzero version probe, timeout, malformed JSONL, empty valid catalog, and discovery crash are distinct states.
- [ ] A T3 custom-model string cannot cause a false authenticated state.
- [ ] Native Pi custom models (Ollama/vLLM/LM Studio/proxy) preserve image/reasoning capabilities.
- [ ] Environment overrides, including `PI_CODING_AGENT_DIR`, are instance-scoped.

### Session and event behavior

- [ ] Text and reasoning stream into the correct canonical items.
- [ ] Intermediate tool/planning steps do not create empty assistant messages.
- [ ] Retrying `agent_end` is nonterminal; exactly one final turn completion is emitted.
- [ ] Concurrent sends serialize; mid-turn messages use `steer`.
- [ ] Model/thinking changes apply only to the addressed provider instance and only between turns.
- [ ] Resume and rollback use the new session file after fork/new-session.
- [ ] Startup/send/switch/fork failures do not leave a usable-looking poisoned session.

### Approval and trust

- [ ] Gated modes refuse startup when the approval asset is missing or its sentinel is absent.
- [ ] Unknown/custom/extension/MCP tools default to denied.
- [ ] Read-only and auto-edit allowlists are reviewed against the exact supported Pi version.
- [ ] Reject, accept, accept-for-session, cancellation, disconnect, duplicate response, and write failure settle safely.
- [ ] Trusted and untrusted projects have explicit, documented behavior in RPC mode.
- [ ] A malicious project extension cannot bypass the intended approval boundary.

### Cleanup and packaging

- [ ] No process/fiber/queue/deferred leaks after every exit and timeout path.
- [ ] Windows, macOS, and Linux child termination is verified.
- [ ] The npm tarball and desktop/package artifacts contain the loadable approval extension.
- [ ] Packaged builds pass the sentinel handshake from their real install path.
- [ ] Runtime Pi version mismatch fails clearly rather than parsing events optimistically.

### Focused commands and integrated UI

- [ ] Run only the affected server, contracts, and web tests with `vp test run <files>`.
- [ ] Run targeted formatting, lint, and type checks for changed packages.
- [ ] Run `git diff --check`.
- [ ] Use one isolated paired T3 environment to verify: enable Pi, health status, provider instance, dynamic models, thinking level, prompt/stream, approval/reject, interrupt, resume, and cleanup.
- [ ] Stop the isolated server and verify its Pi child processes are gone.

## Bottom line

#4355 demonstrates that a native Pi RPC provider fits T3 Code and supplies a valuable test corpus and protocol adapter. The correct reuse boundary is below the current orchestration adapter: transport, parsers, Pi commands, approval-extension concept, and failure cases. The interaction-mode claim, static thinking list, inferred authentication, duplicate custom-model setting, implicit project trust, approval allowlist, packaged extension, and subprocess lifecycle all need explicit decisions before this becomes a trustworthy provider.
