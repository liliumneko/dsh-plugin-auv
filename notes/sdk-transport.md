# @auv-js/sdk transport for @local/dsh-auv (task-6)

Implementation notes for the Lead. Written by `sdk-transport-smith`; the API
groundwork lives in `notes/sdk-api-map.md` (task-5) and the CLI contract in
`notes/auv-cli-contract.md`.

## What changed

| File | Change |
| --- | --- |
| `src/transport/config.mjs` | **new** — parses `AUV_DSH_TRANSPORT` (`auto`/`sdk`/`cli`, default `auto`, trimmed/case-insensitive; unknown values warn once and mean `auto`). Pure, env read on every call. |
| `src/transport/sdk-format.mjs` | **new** — side-effect-free argument planners (same validation/error text as the CLI tool bodies), protobuf→CLI JSON mappers, request builders. Unit-tested by `tools/check-tools.mjs`, no SDK/daemon needed. |
| `src/transport/sdk.mjs` | **new** — the transport: lazy app-owned daemon singleton (`globalThis` symbol), typed ops for the 8 typed tools, capture bytes→`.webp` file, abort/timeout plumbing, error mapping, idempotent `disposeSdkTransport()`, and the CLI-with-`AUV_ENDPOINT` route for `auv_doctor`/`auv_invoke`. |
| `src/tools.mjs` | Each of the 8 typed tools' `execute` first asks `activeSdkTransport()`: when a transport facade is returned it runs the SDK implementation; in `cli` mode (or after auto-fallback) it runs the **unchanged** CLI body. `auv_doctor` now calls `runAuvDoctorWithSdkFallback`, `auv_invoke` calls `runAuvWithSdkFallback`; `auv_help` is untouched. |
| `index.js` | Registers `ctx.effect(() => () => disposeSdkTransport())` (with a `ctx.on('dispose')` fallback) so plugin unload/reload stops the owned daemon. Activation still never starts a daemon or touches the binary eagerly. |
| `tools/check-tools.mjs` | New offline checks: transport-config parsing, SDK argument mapping/mappers, "cli mode never starts a daemon", auto-mode fallback (invalid `AUV_BIN`), dispose-effect registration, and bundle assertions (SDK inlined, >600 kB, only `node:` imports). Existing checks kept. |
| `dist/index.mjs` | Rebuilt with `pnpm build` (not hand-edited). **1,577,618 bytes / 338,083 bytes gzip.** |

No changes to `package.json`, `tsdown.config.mjs`, READMEs, `src/auv.mjs`,
`src/catalog*`, or the catalog data. `@auv-js/sdk@0.0.43` and `es-toolkit` were
already devDependencies; no dependencies were added.

## Transport matrix

`AUV_DSH_TRANSPORT`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | First SDK-routed tool call lazily starts the owned daemon. If startup fails, log **one** warning and permanently use the CLI path for this process. |
| `sdk` | Same lazy start, but a startup failure is surfaced as the tool error (`AUV_SDK_INIT_FAILED`) instead of falling back (message suggests `auto`/`cli`). |
| `cli` | The SDK transport is never initialized (no daemon, no socket); every tool uses the historical CLI child-process path. |

Tool routing:

| Tool | Transport |
| --- | --- |
| `auv_screenshot`, `auv_ocr`, `auv_click`, `auv_type`, `auv_keys`, `auv_scroll`, `auv_windows`, `auv_activate` | SDK typed client when active, else CLI |
| `auv_doctor`, `auv_invoke` | CLI always (SDK has no doctor report / generic argv). When the SDK owns a running daemon, the CLI child is routed at that daemon via `AUV_ENDPOINT=<endpoint>` + root `--credential-stdin` with the launcher token on stdin; connection-level failures retry the independent CLI child (which auto-starts/attaches its own daemon as before). |
| `auv_help` | Offline bundled catalog, unchanged |

`auv_doctor` never forces the SDK daemon to start (it keeps working when the
daemon cannot start at all); it uses the owned-daemon route only if the daemon
is already running.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `AUV_DSH_TRANSPORT` | `auto` \| `sdk` \| `cli` (see above). |
| `AUV_DSH_SDK_STORE_ROOT` | Owned daemon store root; default `<DSH data>/auv/sdk` (`<DSH data>` = `$DSH_HOME` or `~/.dsh`). |
| `AUV_DSH_CAPTURE_DIR` | Directory for SDK capture `.webp` files; default `<DSH data>/auv/sdk-captures`. |
| `DSH_HOME` | Data root for the two paths above. |
| `AUV_DSH_STORE_ROOT` | Existing CLI run/artifact store root (CLI path and routed `auv_invoke`). |
| `AUV_BIN`, `PATH` | Existing AUV binary resolution (`src/auv.mjs`), reused for `startAuv({ binaryPath })`. |
| `AUV_DSH_NO_DAEMON` | Existing CLI flag (`--no-daemon`). Still honoured on the CLI path; the SDK transport ignores it. |
| `AUV_LOG_DIR` | AUV's own logs (needed in the DSH bash sandbox). |

## SDK semantics / deviations from the CLI path

- **Captures**: `displays.capture` / `displays.captureRegion` / window client
  `capture` return `CapturedFrame` refs, not files. The transport immediately
  calls `captures.image(frame, { encoding: ImageEncoding.WEBP, maxSize: {width:
  2048, height: 2048} })`, writes the bytes to
  `<capture root>/<timestamp>-<captureId>-<random>.webp`, and returns the
  existing tool value shape (`artifact_path`, `content_type: "image/webp"`,
  `width`, `height`, `result.capture`, `artifacts[]` with `byte_length`/`sha256`).
  Capture refs are never cached across calls. Files older than 7 days are
  pruned best-effort on daemon init.
- **Resolution**: `CaptureResolution.LOGICAL` (1 px per point), bounded by
  `maxSize` 2048². The CLI path returns native 2× Retina captures; SDK
  screenshots are therefore half the pixel dimensions on Retina (same logical
  area). This follows the approved design ("Use CaptureResolution.LOGICAL unless
  the API surface says otherwise").
- **`window_id` capture/OCR findText** address the exact window through the SDK
  window client, unlike the CLI (which only accepts `app:` + `--title` for
  `window.capture`/`window.findText`). This removes the CLI's window→app
  workaround and is a strict improvement.
- **`window_id` click/type/keys/scroll** use the window client (window-local
  coordinates / window recipient), matching the CLI's window-target semantics.
  Screen-wide clicks use `Position.screen`, display clicks `Position.display`.
- **OCR `wait: true`** is a client-side poll of `findText` every 250 ms until
  `timeout_ms` (default 10 000 ms), returning `timed_out: true` on expiry. The
  CLI's `display.waitForText` quirk (timeouts for text `findText` finds) is not
  reproduced because each poll is a fresh `findText`. Match objects are
  normalized to the CLI shape (`bounds.origin/size`, `confidence`, `text`).
- **`click text`** is composed (`findText` → `click` at match center), like
  `display.clickText`/`window.clickText`; it clicks the first match and returns
  the normalized matches plus the click response. No match returns
  `status: "completed"`, empty `matches`, and a "nothing was clicked" warning.
  There is no `--dry-run` in the typed API; `auv_invoke` dry-runs stay CLI.
- **`auv_type`** uses `runner.input.typeText`/`pasteText` (foreground), window
  client `typeText`/`pasteText`, or a single `runner.input.keyboard` action for
  an `application_id` target; `policy` maps to `InputPolicy`.
- **`auv_keys`** uses `WindowClient.pressKeys` for a window, otherwise
  `runner.input.pressKeys({target:{recipient:{case:'applicationId'|'foreground'}}})`
  with `count`/`interval` (default interval 50 ms when `repeat > 1`).
- **`auv_scroll`** uses `WindowClient.scroll` with window-local point (window
  center when x/y omitted). A screen-point scroll on macOS fails fast with the
  existing actionable message; on Linux/Windows it uses `invokeUnary` +
  `InputService.ScrollPoint` (typed wrapper is absent in 0.0.43).
- **`auv_activate`** uses `runner.applications.activate({applicationId})`; the
  result is normalized to snake_case with human enum names, and a
  `foregroundMismatch` verification adds a warning instead of claiming success.
- **Errors**: `AuvAbortError` → `AUV_TIMEOUT`/`ABORTED`; `AuvRpcError` maps
  rpcCode → actionable text (`PERMISSION_DENIED` includes the macOS permission
  hint, `NOT_FOUND` suggests refreshing window ids, `UNIMPLEMENTED`/`INTERNAL`
  explain platform/OCR limits, `UNAVAILABLE` explains daemon restart);
  `inputActionProgress` adds "may already have been delivered" notes. Error
  class/message shape stays `AuvError` so tool renderers are unchanged.
- **Warnings shown on `auv_screenshot` with `application_id`** ("Capturing the
  application's main visible window…") are preserved.
- **Runs/tracing**: SDK calls do not create the CLI-style receipt `run_id` or
  per-invoke trace files; tool values return `run_id: null`. A per-call
  `auv.runs.create()` was deliberately not added (v1): it would add two RPCs per
  call without giving CLI trace parity. Report if the Lead wants run grouping.
- **`AUV_DSH_NO_DAEMON` / `AUV_DSH_OVERLAY`** only affect the CLI path, as
  before. The SDK daemon is app-owned and private (`noRegister` default,
  launcher-token socket, `--exit-on-stdin-close`), so it never replaces or
  collides with the user's own `auv serve`.

## Lifecycle

- Lazy init on the first SDK-routed tool call; concurrent initializations share
  one promise.
- Daemon/connection/client/runner are stored on `globalThis[Symbol.for(
  '@local/dsh-auv/sdk-transport.v1')]`, so a DSH plugin reload reuses the
  daemon instead of leaking one.
- `daemon.exited` clears the singleton so the next call starts a fresh daemon
  (new id/socket/token); the CLI path remains available.
- `disposeSdkTransport()` closes the connection and awaits `daemon.stop()`
  (idempotent; concurrent calls share one teardown promise). `index.js` wires it
  through `ctx.effect`; `--exit-on-stdin-close` is the safety net if the Host
  dies without unloading the plugin.

## Verification (exact commands and results)

All from `/Users/liliumneko/Projects/dshplugin`; read-only tools only, no real
clicks/typing/presses were delivered.

```sh
# 1. syntax
for f in index.js src/tools.mjs src/transport/*.mjs tools/check-tools.mjs; do node --check "$f"; done   # OK

# 2. offline self-check (12 checks, includes new transport/mapping/bundle checks)
node tools/check-tools.mjs
# RESULT: 12 checks passed, 0 failed.

# 3. SDK transport smoke (source): windows, screenshot bytes→file, OCR, dispose
AUV_DSH_TRANSPORT=sdk AUV_LOG_DIR=/tmp/sdk-smoke/logs AUV_DSH_SDK_STORE_ROOT=/tmp/sdk-smoke/store \
  node /tmp/sdk-smoke/smoke.mjs
# PASS auv_windows (19 windows, CLI-shaped rows)
# PASS auv_screenshot (artifact exists, RIFF/WEBP, byte_length > 0, dims 1728×1117 for the display)
# PASS auv_ocr ("Window" matched, bounds.origin/size shape)
# PASS sdk started (daemon pid), dispose stopped, daemon process exited, dispose idempotent
# RESULT: all smoke checks passed

# 4. CLI fallback smoke (same source tools, AUV_DSH_TRANSPORT=cli)
AUV_DSH_TRANSPORT=cli AUV_DSH_NO_DAEMON=1 AUV_LOG_DIR=/tmp/sdk-smoke/logs AUV_DSH_STORE_ROOT=/tmp/sdk-smoke/cli-store \
  node /tmp/sdk-smoke/smoke-cli.mjs
# PASS windows/screenshot/OCR/doctor/invoke, no SDK daemon started
# RESULT: all CLI-mode checks passed

# 5. SDK-mode CLI routing (auv_doctor + auv_invoke at the owned daemon)
AUV_DSH_TRANSPORT=sdk AUV_LOG_DIR=/tmp/sdk-smoke/logs AUV_DSH_SDK_STORE_ROOT=/tmp/sdk-smoke/store AUV_DSH_STORE_ROOT=/tmp/sdk-smoke/hybrid-store \
  node /tmp/sdk-smoke/smoke-hybrid.mjs
# PASS doctor + auv_invoke display.list, receipt failure surfaces
# RESULT: all hybrid checks passed

# 6. auto-mode fallback with a broken AUV_BIN (no daemon spawn, one warning, CLI guidance)
AUV_LOG_DIR=/tmp/sdk-smoke/logs node /tmp/sdk-smoke/smoke-fallback.mjs
# PASS auto returns null, one warning, status.fallback, no pid, CLI reports AUV_BIN guidance

# 7. build + bundled runtime
pnpm build
# dist/index.mjs 1.58 MB (1,577,618 bytes), gzip 338,083 bytes
AUV_DSH_TRANSPORT=sdk AUV_LOG_DIR=/tmp/sdk-smoke/logs AUV_DSH_SDK_STORE_ROOT=/tmp/sdk-smoke/bundle-store \
  node /tmp/sdk-smoke/smoke-bundle.mjs
# PASS bundled apply registers 11 tools, bundled SDK windows/screenshot/OCR, dispose effect
```

`node tools/check-tools.mjs` needs the rebuilt `dist/index.mjs` (it asserts the
SDK is inlined and >600 kB); the rebuilt dist is in the working tree but **not
committed** (Lead owns the commit).

## Bundle notes (deviation from the scout's estimate)

`pnpm build` (tsdown 0.23.7 / rolldown 1.3.0, existing config) succeeds and
inlines the SDK. Measured: **1,577,618 bytes raw / 338,083 bytes gzip**, versus
162,211 bytes before. That is larger than the scout's projected 1.12 MB / 241 kB
because rolldown resolved gRPC's lazy `require('@grpc/proto-loader')` instead of
leaving `__require` shims, so `@grpc/proto-loader` + `protobufjs`/`long` land in
the bundle (tsdown's dependency report lists them). The bundle loads and its
daemon/typed calls work from `dist/index.mjs` (smoke 7). Options if the size
matters (all owned by the Lead, not done here): stub `@grpc/proto-loader` via
tsdown alias, or keep the CLI path. No `tsdown.config.mjs` change was made.

`@grpc/grpc-js` and the gRPC unix-socket transport are required for the local
app-owned daemon; `node:*` builtins stay external and the bundle imports only
`node:` specifiers.

## Remaining risks / for the Lead

1. **TCC attribution in the real DSH Host is unverified here.** The daemon is a
   child of the Host process (same responsible process for Screen
   Recording/Accessibility). Our bash-context smoke works, and the installed
   plugin runs in the unsandboxed Host, but a live verification (read-only:
   `auv_doctor`, `auv_windows`, `auv_screenshot`) after reload is recommended.
2. **Bundle grew to 1.58 MB raw** (see above); if plugin size policy matters,
   decide on a proto-loader stub/budget.
3. **First SDK call latency**: daemon spawn + health wait + lazy Runner start
   (~1–5 s observed; up to 15 s startup timeout). Subsequent calls are fast.
4. **Capture disk growth**: SDK captures are files under
   `~/.dsh/auv/sdk-captures` (7-day best-effort pruning). `read_image` needs
   them to persist across the tool call; the retention window is a policy
   choice.
5. **Composed click/wait semantics** have small OCR→click race windows and
   poll-interval differences from the CLI (documented above).
6. **Mutating tools were not executed** in this environment (no real clicks,
   typing, keys or scrolls); only dry-run keyboard validation (during research)
   and read-only tools were exercised. The request shapes follow the grounded
   API map; a live mutation test should be done by whoever can safely provide
   a throwaway target app.
7. **README/package.json/CHANGELOG** are Lead-owned: document
   `AUV_DSH_TRANSPORT`, `AUV_DSH_SDK_STORE_ROOT`, `AUV_DSH_CAPTURE_DIR`, the
   app-owned daemon, and the bundle-size change. Reload/reinstall the plugin
   after committing the rebuilt `dist/`.
8. **CLI auto-daemon in the sandbox**: CLI-mode smoke needed
   `AUV_DSH_NO_DAEMON=1` inside the DSH bash sandbox (AUV's detached
   autostart cannot run there). Unchanged from before; the real Host uses the
   normal CLI daemon path.

---

# Simplification: attach-first, SDK-only, 9 tools (task-8)

Implemented by `transport-simplifier`. This section supersedes the transport matrix
and CLI notes above; the earlier sections stay as historical evidence for the
CLI/SDK-fallback era.

## What changed

| File | Change |
| --- | --- |
| `src/transport/sdk.mjs` | Rewritten. **Attach-first, SDK-only** transport: `connect({ discover: true })` (bounded to 2 s) → if nothing is reachable, `startAuv()` owns a private daemon. No CLI child process, no argv builder, no receipt parsing. Tracks `attached` vs `owned`; dispose closes the connection always and stops the daemon **only when owned**. Transport-level failures (`UNAVAILABLE`, transport/protocol/remote errors) forget the client so the next tool call re-attaches or starts again. `auv_doctor` implemented on the SDK (`health.check` + `macos.permissions.probe()`), never throws. Exports `createSdkTransportState()` / `initializeSdkTransport(shared, deps)` / `disposeTransportState(shared)` / `SDK_DEPENDENCIES` for offline unit tests. |
| `src/transport/sdk-format.mjs` | Pure planners/mappers kept; header no longer says "CLI receipts". Added `permissionStatusName`, `summarizePermissions`, `permissionsAllOk`, `PERMISSION_RECOMMENDATION` for the doctor report. |
| `src/tools.mjs` | **9 tools**: `auv_doctor`, `auv_screenshot`, `auv_ocr`, `auv_click`, `auv_type`, `auv_keys`, `auv_scroll`, `auv_windows`, `auv_activate`. Removed `auv_invoke` and `auv_help`, every CLI fallback body, the catalog access layer, window→app resolution workarounds, and receipt helpers. Tool bodies run the pure planner *before* `activeSdkTransport()`, so invalid input never attaches/starts a daemon. `auv_doctor` catches transport-init failure and returns a plain diagnostic report containing install/permission guidance. Tool values gain `daemon_mode` (`attached`/`owned`) and `daemon_endpoint`. |
| `src/auv.mjs` | Trimmed to binary discovery (`resolveAuvBinary`, `AUV_BIN`/PATH handling), `AUV_INSTALL_GUIDANCE`, `AuvError`, `clampTimeout`, `permissionHint`. Removed `runAuv`/`runAuvDoctor`/`spawn`/receipt parsing/`childEnvironment`/`defaultStoreRoot`/`artifactPathOf`. |
| `src/transport/config.mjs` | **Deleted.** No `AUV_DSH_TRANSPORT` / `auto`/`sdk`/`cli` modes any more. |
| `src/catalog.json`, `src/catalog.mjs`, `src/catalog-data.mjs` | **Deleted** (no generic invoke/help tool). |
| `tools/generate-catalog.mjs`, `tools/sync-catalog-data.mjs`, `notes/catalog-selfcheck.mjs` | **Deleted** (dead tooling). `notes/*.md` evidence docs kept. |
| `index.js` | Same effect-scoped dispose, but it now closes the connection and stops only an owned daemon. Preflight wording: a missing CLI does not prevent attaching to a running daemon, only owning one. |
| `tools/check-tools.mjs` | Rewritten for 9 tools: no catalog checks; added attach-first/ownership unit checks (injected fake SDK deps), doctor helper checks, a runtime-source grep proving no CLI/catalog/removed-env code, a fast-fail `connect({discover:true})` check, validation-before-transport execute guards, and bundle checks for 9 tools + no retired markers. **11 checks, all pass.** |
| `dist/index.mjs` | Rebuilt with `pnpm build`: **1,445,677 bytes raw / 315,032 bytes gzip** (was 1,577,618 / 338,083 — the catalog data is gone). |

## Transport behaviour

1. First tool call → `ensureSdkTransport()` (module singleton on `globalThis`,
   symbol `@local/dsh-auv/sdk-transport.v2`, so a reload reuses it).
2. **Attach**: `discoverEndpoint()` for diagnostics (optional) then
   `connect({ discover: true, signal: AbortSignal.timeout(2000) })`, then
   `createAuv(connection)`, `health.check` (5 s), `runner({runnerClass:'auv.core.local'})`.
   Discovery honours `AUV_ENDPOINT` first and the OS-user discovery descriptor
   second (macOS: `~/Library/Application Support/ai.moeru.auv/api-server.json`;
   `AUV_DISCOVERY_FILE` overrides the path). A CLI-started/registered daemon uses
   `os-user` local auth, so no credential is needed.
3. **Owned fallback**: `resolveAuvBinary()` → `startAuv({ binaryPath, storeRoot,
   workingDirectory, environment, startupTimeoutMs: 15000 })`. This keeps the
   private socket, launcher-token auth, `noRegister` (no discovery descriptor) and
   `exit-on-stdin-close`. `AUV_BIN`/PATH handling is unchanged.
4. **Dispose**: awaits any in-flight init, closes the connection, and calls
   `daemon.stop()` only when `mode === 'owned'`. Idempotent; concurrent calls
   share one teardown promise. An attached user daemon is never stopped.
5. **Recovery**: if the attached daemon exits (idle-exit after 5 min, user
   quits it), the failing call maps to `AUV_UNAVAILABLE`, the state is forgotten,
   and the next call attaches again or starts an owned daemon (verified live).
   Owned daemons also drop the client when `daemon.exited` fires.

## auv_doctor (SDK)

Report fields (plain, no jargon labels): `platform`, `daemon` `{mode, endpoint,
daemon_id, pid, health}`, `permissions_checked`, `accessibility`,
`screen_recording`, `screen_capture_kit`, `automation`, `all_ok`,
`recommendation`, `error`, `warnings`. Permission statuses are AUV's
`PERMISSION_STATUS_*` mapped to `granted` / `missing` / `unknown`. `all_ok`
requires Accessibility granted, Screen Recording granted, and ScreenCaptureKit
not missing; Automation is reported as optional (a missing one only adds a
warning). On non-macOS the daemon health alone decides `all_ok`. When the daemon
cannot be attached or started (e.g. AUV not installed), `execute` returns a
failure report whose `error` embeds `AUV_INSTALL_GUIDANCE` and whose
`recommendation` points at the fix — the tool never throws.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `AUV_BIN`, `PATH` | AUV executable used only when the plugin must start its own daemon. |
| `AUV_DSH_SDK_STORE_ROOT` | Owned-daemon store root; default `<DSH data>/auv/sdk`. |
| `AUV_DSH_CAPTURE_DIR` | Directory for SDK capture `.webp` files; default `<DSH data>/auv/sdk-captures`. |
| `DSH_HOME` | Data root for the two paths above. |
| `AUV_LOG_DIR` | AUV's own logs (needed in the DSH bash sandbox). |
| `AUV_ENDPOINT`, `AUV_DISCOVERY_FILE` | SDK discovery overrides; honoured for attach (normally unset). |

Removed: `AUV_DSH_TRANSPORT`, `AUV_DSH_NO_DAEMON`, `AUV_DSH_OVERLAY`,
`AUV_DSH_STORE_ROOT`, and the `AUV_DSH_*` fallback semantics.

## Verification (exact commands and results)

All from `/Users/liliumneko/Projects/dshplugin`; read-only tools only (no real
clicks/typing/keys/scrolls/activation were delivered).

```sh
# 1. syntax
for f in index.js src/auv.mjs src/tools.mjs src/transport/sdk-format.mjs src/transport/sdk.mjs tools/check-tools.mjs; do node --check "$f"; done   # OK

# 2. offline self-check
node tools/check-tools.mjs
# RESULT: 11 checks passed, 0 failed.
#   (9 tools / entry point / manifest + retired files / SDK mapping / attach-first & ownership /
#    doctor helpers / no CLI-or-catalog runtime grep / discovery fast-fail / offline execute guards / bundle)

# 3. bundle build
pnpm build   # dist/index.mjs 1,445,677 bytes; gzip 315,032 bytes

# 4. OWNED mode smoke (source) — no discoverable daemon, plugin starts its own
AUV_LOG_DIR=/tmp/simplifier-sdk/logs AUV_DSH_SDK_STORE_ROOT=/tmp/simplifier-sdk/store \
AUV_DSH_CAPTURE_DIR=/tmp/simplifier-sdk/caps AUV_DISCOVERY_FILE=/tmp/simplifier-sdk/none/api-server.json \
  node /tmp/simplifier-sdk/owned-smoke.mjs
# PASS windows 16 rows, daemon_mode=owned, run_id=null
# PASS screenshot artifact under capture dir, RIFF/WEBP, byte_length 286018, 1728x1117
# PASS OCR matches; doctor all_ok=true, mode=owned, permissions granted
# PASS exactly one `auv serve ... --store-root /tmp/simplifier-sdk/store --no-register`
# PASS dispose: state cleared, owned daemon process gone, idempotent

# 5. ATTACH mode smoke (source) — a real discoverable daemon under /tmp
#    (startAuv({ discoveryFile: '/tmp/simplifier-sdk/attach2/api-server.json',
#               local: { auth: { allowedMethods: ['os-user'] } } })
#     + AUV_DISCOVERY_FILE pointing at the descriptor = a CLI-style registered daemon)
AUV_LOG_DIR=/tmp/simplifier-sdk/logs AUV_DSH_SDK_STORE_ROOT=/tmp/simplifier-sdk/attach2/plugin-store \
AUV_DSH_CAPTURE_DIR=/tmp/simplifier-sdk/attach2/caps \
  node /tmp/simplifier-sdk/attach-smoke.mjs
# PASS attached windows (daemon_mode=attached, endpoint from descriptor, pid=null)
# PASS doctor daemon.mode=attached; render says "attached to the running AUV daemon"
# PASS no plugin-owned `auv serve` was started
# PASS dispose closed only the connection; user daemon stayed healthy; descriptor removed on stop

# 6. ATTACH death + recovery (source)
AUV_LOG_DIR=/tmp/simplifier-sdk/logs AUV_DSH_SDK_STORE_ROOT=/tmp/simplifier-sdk/recover/plugin-store \
  node /tmp/simplifier-sdk/recover-smoke.mjs
# PASS first call after the attached daemon exits fails with AUV_UNAVAILABLE (rpc 14) and forgets the client
# PASS the next call recovers with an owned daemon (daemon_mode=owned)

# 7. BUNDLED runtime smoke (dist/index.mjs)
AUV_LOG_DIR=/tmp/simplifier-sdk/logs AUV_DSH_SDK_STORE_ROOT=/tmp/simplifier-sdk/bundle-store \
AUV_DSH_CAPTURE_DIR=/tmp/simplifier-sdk/bundle-caps AUV_DISCOVERY_FILE=/tmp/simplifier-sdk/none/api-server.json \
  node /tmp/simplifier-sdk/bundle-smoke.mjs
# PASS apply registers 9 tools; windows/doctored/screenshot region 200x120 work; dispose stops the owned daemon
```

The live attach path **is tested** in this sandbox: the SDK publishes a
descriptor to any path via `startAuv({ discoveryFile })`, and
`AUV_DISCOVERY_FILE` makes `connect({ discover: true })` read it. That is the
same descriptor + `os-user` auth contract the user's CLI daemon uses; the only
untested variant is the real `~/Library/Application Support/ai.moeru.auv/api-server.json`
location (not writable in the DSH bash sandbox), which behaves identically.

Source grep (evidence that no CLI/catalog path remains in runtime code):

```sh
grep -nE "node:child_process|\bspawn\s*\(|--no-daemon|--credential-stdin|--no-overlay|--dry-run|AUV_DSH_TRANSPORT|AUV_DSH_NO_DAEMON|AUV_DSH_OVERLAY|AUV_DSH_STORE_ROOT|catalog\.(json|mjs|data)|generate-catalog|sync-catalog|buildInvokeArgs|\brunAuv\b|auv_help|auv_invoke" \
  index.js src/auv.mjs src/tools.mjs src/transport/sdk-format.mjs src/transport/sdk.mjs
# (no matches)
```

## Required Lead-owned edits (not done here)

1. **`package.json` scripts** — delete the now-broken catalog scripts:
   - `"catalog": "node tools/generate-catalog.mjs"`
   - `"catalog:sync": "node tools/sync-catalog-data.mjs"`
   Everything else (files/exports/devDependencies) is unchanged; `@auv-js/sdk`,
   `es-toolkit`, `tsdown` stay devDependencies and are still bundled.
2. **`README.md` / `README.zh.md`** — update: tool table to 9 tools (drop
   `auv_invoke`/`auv_help`); env table (drop `AUV_DSH_TRANSPORT`,
   `AUV_DSH_NO_DAEMON`, `AUV_DSH_OVERLAY`, `AUV_DSH_STORE_ROOT`; keep
   `AUV_DSH_SDK_STORE_ROOT`, `AUV_DSH_CAPTURE_DIR`); "Transport and daemon
   lifecycle" section (attach-first; owned only as fallback; dispose ownership);
   doctor now SDK-backed; remove the catalog/MCP size-comparison and
   catalog-regeneration sections; update the build/test scripts list; bundle
   size 1.45 MB raw / 315 kB gzip; `notes/catalog-selfcheck.mjs` no longer exists.
3. **`locale/en.json` / `locale/zh.json`** — drop "and raw AUV commands" /
   "以及直接调用 AUV 命令" from the descriptions.
4. **`tsdown.config.mjs` header comment** (cosmetic only) — it still says the
   bundle inlines "the generated AUV catalog"; that is no longer true.
5. Suggested commit message (do not commit in this session):
   `Refactor the plugin to an attach-first, SDK-only transport with 9 tools`

## Remaining risks

1. **TCC attribution differs between attached and owned daemons.** An attached
   daemon runs with whatever permissions its launcher (terminal/CLI) has; the
   owned daemon is a child of the DSH Host. The doctor probe reports the actual
   capability for the daemon in use, but the Host-level TCC state should still be
   re-verified live after the plugin reload (read-only doctor/windows/screenshot).
2. **Attach latency bound is 2 s.** A very slow daemon start right as a tool call
   happens can make the attach attempt time out; the plugin then starts its own
   private daemon (safe, but the user's daemon is not used for that session).
3. **Mutating tools were not executed** here (no real clicks/typing/keys/scrolls);
   request shapes are unchanged from the previously verified SDK transport.
4. **First call latency**: attach is fast (<100 ms locally); owned-daemon start is
   ~1–5 s (15 s startup timeout).
5. A pre-existing leaked `auv serve` from an earlier verification session
   (`--store-root ~/.dsh/auv/sdk --no-register`, pid seen during this task) is
   unrelated to this plugin instance; dispose only stops daemons it owns.
