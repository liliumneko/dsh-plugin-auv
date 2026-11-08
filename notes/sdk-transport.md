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
