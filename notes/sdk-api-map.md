# @auv-js/sdk 0.0.43 API map for the dsh-auv transport migration

Research deliverable for `task-5`. Everything below is grounded in the published
`@auv-js/sdk@0.0.43` tarball (`/tmp/auv-sdk-pack/package/`), the AUV repo sources at
`github.com/moeru-ai/auv@main` (`js/packages/sdk/`, `crates/auv-cli/`, `crates/auv-daemon/`),
and runtime probes against the installed **AUV 0.0.43** (`/opt/homebrew/bin/auv`) on this
macOS host (2026-11-08). No plugin source, package.json, or git state was modified; the only
workspace write is this file.

Runtime probes were run from `/tmp/auv-bundle-test` (SDK tarball + its pinned deps extracted
by hand; no `npm`/`pnpm` install, no desktop input — only read-only capture/OCR/window/discovery
calls, plus `dryRun: true` keyboard validation). Probe scripts are listed in §8.

## TL;DR

| Question | Answer |
| --- | --- |
| Daemon strategy | **Own the daemon: `startAuv()` once per Host lifetime**, reuse `daemon.connect()` + one `createAuv()` client, `daemon.stop()` on unload/exit. `connect({ discover: true })` cannot be the primary transport: the descriptor is credential-free but only exists after the CLI (or another host) starts a registered daemon, and app-owned daemons are deliberately not discoverable. |
| Typed coverage of the 43 `auv invoke` commands | **41 reachable through the typed client**: 35 direct, 4 by composing 2 typed calls, 2 via the typed `invokeUnary` escape hatch; **2 CLI-only** (`scan.frame`, `scan.coverage`, dev fixture commands with no Runner route). `overlay.*` are reachable only as raw `overlay.show` layers (CLI composes defaults), and 2 commands (`input.getPointerPosition`, `input.scrollPoint`) have no `RunnerClient` wrapper but work through the typed `invokeUnary` escape hatch (verified). |
| CLI fallback still needed | `auv_doctor` (SDK has no doctor), `auv_invoke` (all 43 CLI argv/`--dry-run`/`scan.*`/CLI-composed `overlay.*`/`dry_run` semantics), plus a hard failure path if daemon start fails. Fallback can and should target the **same owned daemon**: `AUV_ENDPOINT=daemon.connectionOptions.endpoint` + `--credential-stdin` + token on stdin (verified end-to-end). `auv_help` is offline catalog data and unaffected. |
| Bundle size | SDK node graph + grpc-js/protobuf/etc. bundles to **954.5 kB raw / 210.6 kB gzip** for `{ startAuv, connect, createAuv, createUnixSocketTransport }` (tsdown 0.23.7 / rolldown 1.3.0). Simulated combined plugin bundle (`index.js` + current src + SDK import retained): **1.12 MB raw / 241 kB gzip** vs the current 162 kB / 31 kB. `@grpc/grpc-js` alone is ≈510 kB raw / ≈101 kB gzip of that; two lazy `@grpc/proto-loader` `require()`s stay unresolved but are in channelz/ORCA paths only. |
| Main risks | TCC/permission attribution of a Host-spawned daemon (empirically OK on this host), run/trace parity (SDK Runs ≠ CLI trace records), capture-ref lifetime + artifact file ownership (SDK returns bytes, not a file), plugin reload leaking a daemon, AUV binary/version distribution unchanged. Details in §7. |

---

# 1. Daemon lifecycle

## 1.1 `startAuv()` — app-owned daemon (Node/Electron main only)

`@auv-js/sdk/dist/node.d.ts:199-291` (`js/packages/sdk/src/node/daemon.ts`):

```ts
interface StartAuvOptions extends OperationOptions {          // OperationOptions = { signal?: AbortSignal }
  binaryPath?: string                  // default 'auv' (resolved through PATH by tinyexec)
  daemonIdleTimeoutSeconds?: number
  discoveryFile?: string               // publishing a descriptor registers the daemon; conflicts with noRegister: true
  environment?: NodeJS.ProcessEnv      // merged over process.env
  local?: LocalListenerOptions         // { auth?: { allowedMethods?: readonly LocalAuthMethod[] }, listen?: readonly { path: string }[] }
  noRegister?: boolean                 // default true, or false when discoveryFile is set
  overlay?: AuvOverlayOptions          // { theme?: OverlayTheme }  (AUV_OVERLAY_THEME equivalent)
  pairingStore?: string                // default '<storeRoot>/pairings.json'
  platforms?: AuvPlatformOptions       // { macos?: { helperApp?: string } }  (AUV_MACOS_HELPER_APP)
  remote?: RemoteListenerOptions       // { auth: { allowedMethods: ['paired-device'] }, listen: readonly { host, port }[] }
  runnerProviders?: readonly string[]  // default []
  shutdownTimeoutMs?: number           // default 5000
  signal?: AbortSignal                 // abort ⇒ daemon killed immediately (do NOT pass a per-tool signal)
  startupTimeoutMs?: number            // default 10000
  storeRoot?: string                   // default '<workingDirectory>/.auv/store'
  workingDirectory?: string            // default process.cwd()
}
type LocalAuthMethod = 'launcher-token' | 'os-user' | 'paired-device'   // local default: ['launcher-token']
// Local listener default: private socket dir under TMPDIR (mkdtemp 'auv-XXXXXX/s'); Windows: \\.\pipe\auv-<uuid>
// local.auth.allowedMethods must include 'launcher-token' or 'os-user' (only owner authority can issue pairing tokens).

interface AuvDaemon {                       // node.d.ts:104-145
  readonly binaryPath: string
  connect: (options?: AuvDaemonConnectOptions) => Promise<AuvConnection>
  readonly connectionOptions: AuvDaemonConnectionOptions   // { credential?, endpoint, local: true, transport: 'unix' | 'npipe' | 'http' }
  readonly endpoints: readonly string[]     // every listener URI ('unix:///…' or 'http://host:port')
  readonly exited: Promise<AuvDaemonExit>   // { code: number | null, signal: NodeJS.Signals | null }
  readonly id: string                       // fresh UUID for this launch; also health.check().id on every listener
  readonly pid: number
  stop: () => Promise<AuvDaemonExit>        // SIGINT then SIGKILL after shutdownTimeoutMs
  readonly storeRoot: string
}

class AuvDaemonStartError extends Error {   // node.d.ts:263-268
  readonly output: string                   // last ~64 KiB of daemon stdout+stderr
  constructor(message: string, output: string, cause?: unknown)
}
```

What `startAuv()` actually does (`dist/node.js:428-560`, `serveArguments()` at `dist/node.js:590-631`;
verified against `crates/auv-cli/src/commands/serve.rs`):

1. Generates `id = randomUUID()` and (default local auth) a 32-byte hex **launcher token**.
2. Spawns `auv serve --id <uuid> --exit-on-stdin-close --local-auth-allowed-methods launcher-token
   --local-socket <private-tmp-socket> --no-register` (plus `--store-root/--pairing-store/--remote-bind/
   --runner-provider/--overlay theme env/--platforms helper env` as configured). `noRegister` defaults to
   `true`, so **no `api-server.json` descriptor is written and the user's default `auv serve` daemon is not
   replaced**.
3. Writes `<token>\n` to the child's stdin and keeps the pipe open; `--exit-on-stdin-close` makes the daemon
   die with the host (a crash or `kill -9` of the host closes stdin).
4. Polls `health.check()` on every listener until `health.id === id` (`startupTimeoutMs`, 10 s default); stdout
   is diagnostic only.
5. Returns the handle. `daemon.connect({credential?})` opens an `AuvConnection` on
   `connectionOptions.endpoint` (`transport: 'unix'` on macOS/Linux, `npipe` on Windows) with the launcher
   token; `connectionOptions.credential` exposes the token for connections the host opens itself.

**Ownership vs `connect({ discover: true })` — the decisive facts:**

* The discovery descriptor (`~/Library/Application Support/ai.moeru.auv/api-server.json` on macOS;
  `crates/auv-daemon/src/discovery.rs::PublishedDescriptor::publish`) contains **only**
  `{ endpoint, instance_id, store_root }` — **no token, no credential**. `connect({discover:true})`
  (`dist/node.js:282-298`) resolves endpoint → `AUV_ENDPOINT` → descriptor, picks the transport
  (`unix://`→unix, `npipe://`→npipe, `http://`→grpc) and connects with whatever `credential` the caller
  passed (normally none).
* `auv serve`'s **default** local auth is `os-user` (`crates/auv-cli/src/commands/serve.rs`,
  `default_values_t = [LocalAuthMethod::OsUser]`), i.e. any process of the same OS user may use the socket.
  So a CLI-started / CLI-auto-started registered daemon **is** reachable credential-free.
* But `startAuv()`'s **default** local auth is `['launcher-token']`, and it also defaults to
  `noRegister: true`. `dist/node.d.ts:218-222` says explicitly: *"Keeps this child daemon from registering
  as the default local daemon: it publishes no discovery metadata. Discovery clients cannot use a
  registered daemon that requires a launcher token."* So an app-owned daemon is intentionally invisible to
  `connect({discover:true})`.
* Nothing auto-starts a daemon for discovery. Only `auv invoke` / `auv mcp` call
  `crates/auv-cli/src/local_daemon.rs::connect_or_start()`, which finds or starts a **detached, registered,
  `os-user`** daemon with `--idle-exit-after 300` (5 min after last request). On this host no
  `api-server.json` existed and no `auv serve` was running, so `connect({discover:true})` rejected with
  `AuvConfigurationError: no AUV daemon discovered; run `auv serve`, set AUV_ENDPOINT, or pass endpoint`
  (verified).
* Using a daemon owned by another host is supported explicitly: `connect({ endpoint, transport, local })`
  and close only that connection (README). `AUV_CONTEXT`/`connectFromContext` exist for `auv` plugin
  processes and never carry credentials; a Runner-side credential arrives on stdin with
  `AUV_CREDENTIAL_STDIN=1` and `inheritedCredential()`.

**Recommended Electron-main / Host pattern (from the SDK README, validated here):**

```ts
import { join } from 'node:path'
import { createAuv, startAuv } from '@auv-js/sdk/node'

// once per Host/plugin lifetime, lazily on first tool call (or at apply())
const daemon = await startAuv({
  binaryPath: await resolveAuvBinaryPath(),        // keep AUV_BIN/PATH handling from src/auv.mjs
  storeRoot: join(DSH_HOME, 'auv', 'daemon-store'),// absolute; default is <cwd>/.auv/store (bad for an app)
  // noRegister defaults to true: never touch the user's default `auv` daemon
  // local.auth.allowedMethods defaults to ['launcher-token']: private to this Host
})
const connection = await daemon.connect()          // AuvConnection, launcher token presented
const auv = createAuv(connection)                  // one client for all tools
// … tools call auv.runner({ runnerClass: 'auv.core.local' }) and friends …
// on plugin unload / app quit:
await connection.close()
await daemon.stop()
```

Notes for our Host plugin specifically:

* DSH Host plugins execute in the harness Host process (Node/Electron main), the same context that already
  spawns `auv` today; the README caution ("only import `startAuv` in Node.js or the Electron main process")
  is about renderers, not about us. This should be confirmed against DSH's plugin host process (open
  question §7).
* Keep the daemon as a **module-level singleton on `globalThis`** (symbol key) so a plugin HMR
  reload does not spawn a second daemon and leak the old one; stop it from the plugin's dispose path if
  DSH exposes one (the current `apply()` has no dispose hook; the tools registry is effect-scoped but the
  daemon is our resource). If no dispose hook exists, rely on `--exit-on-stdin-close`: the daemon follows the
  Host process down.
* Do **not** pass any tool-call `AbortSignal` to `startAuv()` — aborting it terminates the daemon (README
  warning). Only a lifetime signal if the Host wants one.
* `daemon.exited` is the observable for crash handling; on unexpected exit, drop the client and re-run
  `startAuv()` on the next call (a new launch gets a new `id`, a new private socket and a new token).
* `startAuv()` requires the AUV **binary**; the SDK does not ship it. `binaryPath` is spawned by tinyexec with
  `nodePath: false`, so pass an absolute path from our existing `resolveAuvBinary()` (AUV_BIN → PATH →
  Homebrew/local dirs). Keep `auv --version` probing separately: the SDK has no version API and health only
  returns `{ id, status: 'serving' }`. `startAuv` failures surface as `AuvDaemonStartError` with `output`
  (verified: `spawn /nonexistent/auv ENOENT` → `AUV daemon exited before becoming healthy (code -2, …)`).

**Strategy comparison:**

| Option | Works? | Verdict |
| --- | --- | --- |
| A. `startAuv()` in Host (app-owned) | Yes, verified end-to-end (`health`, `displays.list`, capture, OCR all OK in this sandbox) | **Recommended.** Deterministic version, private socket/token, no interference with the user's CLI daemon, no per-call process spawn. |
| B. `connect({ discover: true })` to CLI daemon | Only if a registered `os-user` daemon happens to exist (CLI auto-start, or user ran `auv serve`). Nothing starts it for us; app-started launcher-token daemons are not discoverable; idle-exit after 5 min | Fallback/attach mode only (`AUV_DSH_DAEMON=discover`), not primary. |
| C. `connectFromContext` / `AUV_CONTEXT` | Only for `auv` plugin child processes | Not applicable to the DSH plugin. |
| D. Current CLI transport (`auv [--no-daemon] invoke`) | Yes (shipped) | Keep as `AUV_DSH_TRANSPORT=cli` and as the fallback implementation for `auv_invoke`/`auv_doctor`. |

---

# 2. Client: connection, AuvClient, runner, runs, health, errors

## 2.1 Connect / close

```ts
// @auv-js/sdk/dist/http-BuUYgKEG.d.ts:5078-5084,5117-5129
interface ConnectOptions extends OperationOptions {
  credential?: DeviceCredential            // string, sent as `Authorization: Bearer <credential>`
  endpoint?: string | URL
  local?: boolean                          // constrain placement to the daemon's implicit local Device
  route?: ConnectionRoute                  // { deviceId?, runId? } inherited by every routed call
  transport?: 'grpc' | 'http' | 'npipe' | 'unix' | Transport
}
interface NodeConnectOptions extends ConnectOptions {   // node.d.ts:29-41
  discover?: boolean                       // endpoint → AUV_ENDPOINT → descriptor; mutually exclusive with transport
  env?: AuvEnvironment
}
declare function connect(options?: NodeConnectOptions): Promise<AuvConnection>

declare class AuvConnection {
  readonly local: boolean
  readonly route: Readonly<ConnectionRoute>
  close(options?: OperationOptions): Promise<void>
  unary<I,O>(definition: RpcDefinition<I,O>, input, options?: UnaryOptions): Promise<MessageShape<O>>
  duplex<I,O>(definition: RpcDefinition<I,O>, options?: UnaryOptions): Promise<TypedDuplexCall<I,O>>
}
```

* Every async public op takes `{ signal }` (`OperationOptions`). A signal passed to `connect` only controls
  connection establishment. A client-level default signal (`createAuv(connection, { signal })`) and a
  per-call signal are combined.
* `connect()` awaits `transport.connect()`: gRPC `waitForReady(Infinity)` for unix/npipe/grpc — **a call to
  an endpoint with no daemon hangs until aborted**; always pass a signal on connect (`AbortSignal.timeout`).
* `connect({discover:true, transport})` rejects with `AuvConfigurationError`; `connect({discover:true})` with no
  descriptor rejects with `AuvConfigurationError` (both verified).
* `node.d.ts` also exports `discoverEndpoint()`, `createUnixSocketTransport({path})`,
  `createNamedPipeTransport({path})`, `createGrpcTransport({endpoint})`, `createHttpTransport({endpoint?,
  fetch?, webSocket?})`, `contextFromEnv`, `connectFromContext`, `inheritedCredential`, `checkHealth`.
  (README mentions `createWebSocketTransport`; **not exported by 0.0.43** — docs/package mismatch.)
* `AuvConnection.close()` closes the transport only; it does not stop a `startAuv()` child.

## 2.2 `createAuv` and the client tree

`dist/http-BuUYgKEG.d.ts:6312-6359` (`js/packages/sdk/src/apis/auv/client.ts`):

```ts
function createAuv(connection: AuvConnection, options?: { signal?: AbortSignal }): AuvClient

interface AuvClient {
  readonly connection: AuvConnection
  readonly health: { check: (options?: OperationOptions) => Promise<Health> }        // { id, status: 'serving' }
  readonly devices: { get, list, getUserSession, listUserSessions, ensureUserSessionUnlocked }
  readonly pairing: { createToken, pair, revokeCredential, setEnabled, unpair }
  readonly runners: {
    create, delete, get, list, getClass, listClasses, discover
  }
  readonly runs: {
    create: (options?: CreateRunOptions) => Promise<Run>          // { deviceIds?, labels? }
    get:  (options: GetRunOptions) => Promise<Run>
    list: (options?: OperationOptions) => Promise<readonly Run[]>
    stop: (options: StopRunOptions) => Promise<Run>               // { runId, outcome: 'succeeded'|'failed'|'canceled' }
  }
  readonly runner: (options: RunnerRouteOptions) => RunnerClient
  readonly invoke: { unary, serverStream, duplex }
}

interface RunnerRouteOptions extends OperationOptions {   // d.ts:6073-6077
  deviceId?: string
  runId?: string            // optional; a route without runId does NOT create an implicit Run
  runnerClass: string       // 'auv.core.local'
}
```

`Run` = `{ id, phase: 'pending'|'running'|'succeeded'|'failed'|'canceled', deviceIds, labels, createdAt, completedAt }`.
`runs.create()` observed to return `phase: 'running'` immediately (32-hex id on this build; the CLI receipt
`run_id` is a UUID-shaped string — different generators, both opaque); `runs.stop({outcome:'succeeded'})`
returns the terminal Run.

Tracing: README §"Create a Run for each workflow…" — "Different Runs can share one Runner; stopping one Run
does not stop another. A route without `runId` does not create an implicit Run. A Run ID groups a workflow,
not each RPC within it. The control Run and its routing metadata do not by themselves promise complete
persisted tracing for every low-level call." CLI `auv invoke` still writes its own trace/run records under its
store root; SDK calls will not produce those records (see §5/§7).

## 2.3 Errors

`dist/http-BuUYgKEG.d.ts:5131-5173` (`js/packages/sdk/src/transport/errors.ts`):

| Class | Fields / meaning |
| --- | --- |
| `AuvAbortError` | `cause` = `signal.reason`; raised when any per-call/parent signal aborts (incl. `AbortSignal.timeout`). |
| `AuvConfigurationError` | Bad/conflicting caller options; also discovery failure (`no AUV daemon discovered…`). |
| `AuvRemoteError` | Base for daemon/Runner non-success results. |
| `AuvHttpError extends AuvRemoteError` | RFC 9457 problem from an HTTP endpoint: `status: number`, `type: string`. |
| `AuvRpcError extends AuvRemoteError` | Routed RPC non-success: `rpcCode: number` (raw gRPC code), `details?: Uint8Array` (`grpc-status-details-bin`). |
| `AuvProtocolError` | Malformed wire response (invalid Protobuf, broken discovery). |
| `AuvTransportError` | Connection/transport failure before a response (gRPC connect failure). |
| `AuvDaemonStartError` (node entry) | spawn/startup failure; `output` tail. |
| `AuvDeviceEntryError extends AuvRemoteError` | `reason: 'credentialRejected' \| 'unauthorized' \| 'unregistered' \| …`. |

No named gRPC-code constants are exported; map `AuvRpcError.rpcCode` numerically:

| rpcCode | gRPC | Typical AUV cause (observed/expected) |
| --- | --- | --- |
| 3 | INVALID_ARGUMENT | bad region/point args (verified: `region must be finite with positive width and height`) |
| 5 | NOT_FOUND | stale window id / evicted capture ref (verified: `window:no-such-window-id was not found`, `AuvRpcError | rpcCode: 5`) |
| 7 | PERMISSION_DENIED | macOS Accessibility/Screen Recording missing |
| 9 | FAILED_PRECONDITION | minimized/full-screen window where a mutation needs NORMAL first |
| 10 | ABORTED | server-side cancellation |
| 12 | UNIMPLEMENTED | platform unsupported (verified macOS `scrollPoint`: `rpcCode 12`, "scrolling without a target window is unavailable on this Runner platform") |
| 13 | INTERNAL | native failure (e.g. Vision OCR unknownError surfaces like this) |
| 14 | UNAVAILABLE | daemon gone / transport down (`AuvTransportError` may wrap instead) |

Helper: `inputActionProgress(error)` (`d.ts:6441-6448`) extracts `InputActionFailure.progress`
(`notDelivered` | `deliveryUncertain` | `submitted`) from a failed input RPC's rich status — use it to warn
"input may already have been delivered" on click/type/keys failures.

Success results are protobuf message objects (`MessageShape`) that include a `$typeName` property and
camelCase fields (e.g. `capture.pixelSize`, `window.applicationId`) — normalize before returning to tools,
which currently consume the CLI receipt's snake_case JSON (`result.capture.pixel_dimensions`,
`window.reference.id`, …).

---

# 3. Exact mapping for the 11 tools

Common prologue: `const runner = auv.runner({ runnerClass: 'auv.core.local', runId? })`; all calls accept
`{ signal }`; durations (`settle`, `interval`, `duration`, `timeout`) may be **numbers of milliseconds at any
depth** instead of `{ seconds, nanos }` (README). `windows.list`/`windows.resolve` hand back `WindowClient`s
that already carry their `Window` metadata and act directly.

## 3.1 Capture pipeline (screenshots) — the biggest semantic change

SDK captures leave a **reference** in the Runner; pixels leave only through `captures.image`:

```ts
// d.ts:5906-5989,1006-1055,1101-1150,935-962
interface CapturedFrame {
  bounds?: ScreenRect          // logical screen-space bounds (x,y,width,height)
  scaleFactor: number          // 2 on Retina, 1 for LOGICAL captures
  backend: string              // e.g. 'xcap.macos'
  fallbackReason?: string
  origin?: Position            // top-left of the image in its owning space
  ref?: CaptureRef             // { captureId } — always set
  pixelSize?: PixelSize        // { width, height }
  thumbhash: Uint8Array        // ~20-byte ThumbHash preview
}
interface CaptureImage { data: Uint8Array; encoding: ImageEncoding; width: number; height: number }
interface CaptureImageOptions {  // InputFields<GetCaptureImageRequestSchema,'capture'> & OperationOptions
  region?: RelativeRect        // fractions of the image
  screenRegion?: ScreenRect    // same area in logical screen coords
  maxSize?: { width: number; height: number }   // fit inside, keep aspect, never enlarge
  encoding?: ImageEncoding     // absent/UNSPECIFIED ⇒ RGBA
}
interface CaptureOptions extends OperationOptions { resolution?: CaptureResolution }  // NATIVE (default) | LOGICAL

runner.displays.list(options?): Promise<readonly Display[]>
runner.displays.capture(selector?: DisplaySelectorInit, options?: CaptureOptions)
  -> Promise<{ display: Display, capture: CapturedFrame }>
runner.displays.captureRegion(region: ScreenRectInit, selector?, options?: CaptureOptions)
  -> Promise<{ display: Display, capture: CapturedFrame }>
runner.displays.findText(selector: DisplaySelectorInit | undefined, query: string, options?: FindDisplayTextOptions)
  -> Promise<{ display, matches: TextMatch[], capture: CapturedFrame }>
runner.captures.image(capture: CaptureTarget, options?: CaptureImageOptions): Promise<CaptureImage>
```

* `DisplaySelectorInit` is the protobuf oneof init form:
  `{ selector: { case: 'display', value: { displayId } } }` or `{ selector: { case: 'name', value: name } }`.
  `runner.displays.capture()` with no selector captures the primary display. Unlike the CLI (`display.*`
  forbids `--target`), the SDK can address a display directly — nicer than the current
  `display_id → display.list → frame → captureRegion` workaround.
* `CaptureResolution.NATIVE` = backing pixels (2× on Retina); `LOGICAL` = 1 px per point (¼ pixels).
  CLI parity: `display.capture` artifacts were `scale_factor: 2` native, so default NATIVE matches.
* `ImageEncoding`: `RGBA` (raw rows, default), `PNG`, `JPEG` (q85), `WEBP` (lossless; `IMAGE_ENCODING_WEBP = 4`).
  Verified on this host: `captures.image(frame, {encoding: ImageEncoding.WEBP})` → `data` 172-byte
  `RIFF…WEBPVP8L` for a 40×30 LOGICAL region; window capture produced a 1.8 MB 1840×872 WebP; RGBA at
  `maxSize {20,20}` returned 20×15 × 4 = 1200 bytes exactly (aspect preserved, never enlarged).
* **File writing is now ours.** The CLI wrote `.webp` artifacts under the store root and returned
  `artifact_path`. With the SDK we get bytes and must persist, e.g.
  `await writeFile(join(capturesDir, `${frame.ref.captureId}.webp`), image.data)` (Uint8Array; `writeFile`
  accepts it) and return that path for DSH `read_image`. A capture ref fails with `rpcCode 5` after the
  Runner evicts it (LRU memory budget / 10 min idle), so fetch pixels in the same tool call and never cache
  refs in the tool result. Cleanup/retention policy is ours (§7).
* The tool's current output contract (`artifact_path`, `content_type`, `width`, `height`, `result`,
  `artifacts`, `warnings`) can be preserved by the transport implementation using
  `image.width/height` and `content_type: 'image/webp'`. (There is no SDK artifact/URI concept.)

**Screenshot mapping**

| Tool input | SDK call |
| --- | --- |
| `window_id` | `const w = await runner.windows.get(windowId, {signal}); const {window, capture} = await w.capture({signal, resolution}); const image = await runner.captures.image(capture, {encoding: ImageEncoding.WEBP, signal})` |
| `application_id` | `const w = await runner.windows.resolve({applicationId}, {signal}); …w.capture()…` (resolves the app's main visible window; CLI used `--target app:` + optional `--title`) |
| `display_id` | `runner.displays.capture({selector:{case:'display',value:{displayId}}}, {signal})` |
| `region` | `runner.displays.captureRegion({x,y,width,height}, undefined, {signal})` |
| none | `runner.displays.capture(undefined, {signal})` |
| size in output | `image.width × image.height` (pixels); `capture.bounds`/`pixelSize` also available |

## 3.2 OCR (`auv_ocr`)

```ts
// d.ts:1320-1568,5936-5967,6048-6049
interface TextMatch { text: string; bounds?: ScreenRect; confidence: number }
interface RecognizedText { text: string; bounds?: ScreenRect; confidence?: number }
interface RecognizeTextResponse { text: string; regions: RecognizedText[]; origin?: Position }
interface FindWindowTextResponse { window?: Window; matches: TextMatch[]; capture?: CapturedFrame }
runner.displays.findText(selector, query, options?): Promise<FindDisplayTextResponse>  // matches in screen space
runner.windows.* : WindowClient.findText(query, options?): Promise<FindWindowTextResponse>
runner.recognizeText(source: CaptureTarget | { frame: ImageFrameInit }, options?: RecognizeTextOptions)
  : Promise<RecognizeTextResponse>
// both findText options and recognizeText options accept: region (RelativeRect, fractions),
// screenRegion (ScreenRect, screen space), customWords: string[], recognitionLanguages: string[], signal
```

* `wait: true` has **no SDK equivalent**: the CLI `display.waitForText` / `window.waitForText` are CLI-side
  polling compositions (`runner_support.route: direct`; there is no WaitText RPC). Implement a loop:
  `while (!deadline) { const m = await runner.displays.findText(undefined, text, {signal}); if (m.matches.length) return m; await sleep(interval, signal) }`
  with `timeout_ms` mapped to a deadline + `AbortSignal.timeout`; return `timed_out: true` on expiry. This
  avoids the 0.0.43 `display.waitForText` quirk documented in `notes/auv-cli-contract.md` (timeouts for text
  `display.findText` finds) because each poll is a fresh `findText`.
* Windowed OCR: `runner.windows.get(windowId)` then `client.findText(text, {signal, ...})`, or
  `runner.windows.resolve({applicationId})` — better than the CLI, which forbids `window:<id>` for
  `window.findText` and forced the `window.get → app: → --title` dance.
* Observed on this host: `display.findText(undefined,'DeepSeek')` → 0 matches; `recognizeText(capture)` →
  2419 chars / 163 regions / `origin` in screen space; `window.findText` on the Finder window → 1 match.
* CLI result parity: CLI `result.matches` bounds are screen-space too; produce the same normalized shape
  (camelCase → snake_case if tools keep their current renderer).

## 3.3 Click (`auv_click`)

```ts
// d.ts:5944-5962,5996-6002,6115-6118,1597-1674
type PointTarget =
  | Init<typeof PositionSchema>                     // { x, y, coordinateSpace: { case: 'screen'|'displayId'|'windowId', value } }
  | { bounds?: ScreenRectInit }                      // center clicked (a text match)
  | { x: number; y: number }                         // window-local on a WindowClient, screen space on runner.input

interface ClickOptions { policy?: InputPolicy; click?: { count?: number; interval?: DurationInit };
                        windowStrategy?: WindowClickStrategy; modifiers?: {shift,control,alt,meta};
                        button?: MouseButton }
runner.input.click(target: PointTarget, clickOptions?: ClickOptions, options?: OperationOptions)
  -> Promise<{ window?, screenPoint?, windowPoint?, action?: InputActionResult }>
WindowClient.click(target: PointTarget, clickOptions?, options?)          // delivered to this window
Position.screen(x,y) | Position.display(display|{displayId},x,y) | Position.window(windowTarget,x,y)
```

| Tool input | SDK call |
| --- | --- |
| `text` + (none) | `const f = await runner.displays.findText(undefined, text, {signal, screenRegion: fence?}); await runner.input.click({bounds: f.matches[i].bounds}, {signal})` — global screen click at match center |
| `text` + `window_id` | `const w = await runner.windows.get(windowId); const f = await w.findText(text, {signal}); await w.click({bounds: f.matches[i].bounds})` |
| `text` + `application_id` | `const w = await runner.windows.resolve({applicationId}); …w.findText / w.click…` |
| `within` (screen fence) | pass `screenRegion: {x:left, y:top, width:right-left, height:bottom-top}` to `displays.findText` (CLI `--within LEFT,TOP,RIGHT,BOTTOM`) |
| `x`/`y` + window target | `w.click({x, y})` — plain `{x,y}` on a `WindowClient` is **window-local**, matching CLI default `--relative-to window` for app/window targets |
| `x`/`y` + display target | `runner.input.click(Position.display(displayId, x, y))` — display-relative global click (CLI `--relative-to display`) |
| `x`/`y` no target | `runner.input.click(Position.screen(x, y))` (CLI default screen) |
| `button` | `{ button: MouseButton.RIGHT }` (`LEFT=1, RIGHT=2, MIDDLE=3`) |

Caveats: a global click (screen/display position on `input` or a `{bounds}` target) has no target window, so
the Runner **rejects `policy` and `windowStrategy`** there; only `WindowClient.click` / `Position.window` get
window delivery semantics. CLI `display.clickText`/`window.clickText` are 2-RPC compositions in the SDK, so
there is a small OCR→click race window the CLI does not have (CLI still does OCR+click inside one process,
not atomically on the Runner either). `ClickOptions` has **no dryRun**; `auv_invoke` dry-run for clicks must
stay CLI.

## 3.4 Type / paste (`auv_type`)

```ts
// d.ts:1676-1732,6018-6029,6130-6136,6205
interface TypeTextOptions { policy?: InputPolicy; replaceExisting?: boolean; submit?: TextSubmit;
  interCharDelay?: DurationInit; allowClipboardFallback?: boolean; settle?: DurationInit }
interface PasteTextOptions { replaceExisting?: boolean; submit?: TextSubmit; settle?: DurationInit }
runner.input.typeText(text, inputOptions?: TypeTextOptions, options?: OperationOptions)   // focused app
runner.input.pasteText(text, inputOptions?: PasteTextOptions, options?: OperationOptions) // focused app
WindowClient.typeText(text, typeOptions?: Init<TypeTextOptions>, options?)   // window recipient; policy defaults FOREGROUND_PREFERRED
WindowClient.pasteText(text, pasteOptions?: PasteTextOptions & {policy?}, options?)
runner.input.keyboard(request: PerformKeyboardInputsRequest, options?)       // app/foreground recipient, ordered actions
```

| Tool input | SDK call |
| --- | --- |
| `mode: 'type'`, no target | `runner.input.typeText(text, {policy}, {signal})` (types into the focused control) |
| `mode: 'paste'`, no target | `runner.input.pasteText(text, {}, {signal})` |
| target `window_id` | `(await runner.windows.get(windowId)).typeText(text, {policy}, {signal})` / `.pasteText(text, {policy}, {signal})` |
| target `application_id` | `const w = await runner.windows.resolve({applicationId}); w.typeText(text, {policy}, {signal})` — or, for app-level (not window-level) recipient, `runner.input.keyboard({ target: { recipient: { case: 'applicationId', value: applicationId } }, inputs: [{ action: { case: 'typeText', value: { text, options: { policy } } } }], dryRun: false }, {signal})` |

`policy` ↔ `InputPolicy`: `'background-only'` → `InputPolicy.BACKGROUND_ONLY (1)`,
`'background-preferred'` → `BACKGROUND_PREFERRED (2)`, `'foreground-preferred'` → `FOREGROUND_PREFERRED (3)`.
Background policies post to the window's process without activating it; the control must already have
keyboard focus (README caveat, reproduced with NetEase Cloud Music). `TextSubmit` (`NONE/RETURN/SEARCH/DONE/GO`)
can replace a separate Return key press when needed. SDK typeText has no dryRun; `input.keyboard` does
(`PerformKeyboardInputsRequest.dryRun`) — verified with `dryRun: true` returning `{actions: []}` without
delivery.

## 3.5 Keys / hold (`auv_keys`)

```ts
// d.ts:3301-3461,3555-3597,6131-6136,6019-6024
type WindowPressKeysOptions = { keys: string[]; count?: number; interval?: DurationInit; settle?: DurationInit; policy?: InputPolicy }
WindowClient.pressKeys(keys: readonly string[] | string, pressOptions?: WindowPressKeysOptions, options?)
  : Promise<InputActionResult>                     // string forms: 'cmd+shift+z', 'cmd++' for plus
runner.input.pressKeys(request: PressKeysRequest, options?)
  // PressKeysRequest = { target: InputTarget, options: PressKeysOptions, policy: InputPolicy, dryRun: boolean }
  // PressKeysOptions = { keys: string[], count?: number, interval?: DurationInit, settle?: DurationInit }
runner.input.holdKeys(request: HoldKeysRequest, options?)
  // { target: InputTarget, keys: string[], policy: InputPolicy, duration: DurationInit }
type InputTargetInit = { recipient: { case: 'window', value: WindowInit }
                       | { case: 'applicationId', value: string }
                       | { case: 'foreground', value: true } }
```

| Tool input | SDK call |
| --- | --- |
| `keys`, no target | `runner.input.pressKeys({ target: {recipient:{case:'foreground',value:true}}, options: {keys, count: repeat, interval: interval_ms ?? 50}, policy: InputPolicy.FOREGROUND_PREFERRED, dryRun: false }, {signal})` |
| `keys`, `window_id` | `(await runner.windows.get(windowId)).pressKeys(keys, {count, interval, policy}, {signal})` |
| `keys`, `application_id` | resolve app main window → `.pressKeys(...)` |
| `repeat`/`interval_ms` | `count` + `interval` (number ms accepted). Same AUV rule as CLI: `count > 1` requires positive interval; keep the current default of 50 ms. |

`input.pressKey` is the legacy single-string focused-app helper; `splitKeyCombination('cmd+shift+z')` is
exported for validation. `runner.input.holdKeys` covers `input.holdKeys` (not one of our 11 tools but part of
generic invoke). CLI keyboard target rules are mirrored: background keyboard input requires an app/window
target.

## 3.6 Scroll (`auv_scroll`)

```ts
// d.ts:1892-1933,6142-6169,2762-2799
interface Scroll { deltaX: number; deltaY: number }             // logical px, positive deltaY = down, DOM WheelEvent-like
interface ScrollOptions { policy?: InputPolicy; deliveryCandidates?: ScrollDeliveryCandidate[]; settle?: DurationInit }
runner.windows.get(...).scroll(point: PointTarget, scroll: Scroll, scrollOptions?, options?)
  -> Promise<{ window?, point?, scroll?, action? }>
runner.windows.get(...).scrollUntil(point, request, options?)   // see below
WindowClient.scrollMotion / scrollStream / scrollWith             // animated/live variants
runner.input.scrollPoint — NOT wrapped by RunnerClient; use invokeUnary(InputService.ScrollPoint) (see §4)
```

| Tool input | SDK call |
| --- | --- |
| `window_id` (+ optional window-local x/y) | `const w = await runner.windows.get(windowId); const p = (x!==undefined && y!==undefined) ? {x, y} : {x: Math.round(w.window.frame.width/2), y: Math.round(w.window.frame.height/2)}; await w.scroll(p, {deltaX: dx ?? 0, deltaY: dy}, {}, {signal})` — plain `{x,y}` is window-local (CLI `window.scroll` parity) |
| screen x/y (non-macOS) | `invokeUnary(connection, {service:'auv.api.driver.v1.InputService', method:'ScrollPoint', input: InputService.method.scrollPoint.input, output: …scrollPoint.output, request:{position:{x,y,coordinateSpace:{case:'screen',value:true}}, scroll:{deltaX:dx??0, deltaY:dy}}})` — on macOS this returns **UNIMPLEMENTED (12)**, verified; keep the current macOS error/hint or keep CLI for this one branch |

`window.scrollUntil` (CLI `window.scrollUntil`) maps 1:1 to `WindowClient.scrollUntil(point, request, {signal,
until, onUpdate})` with:
`condition: {case:'textVisible', value:{query}}` or `{case:'end', value:{}}`, `step: {case:'instant'|'motion', value}`,
`maxSteps`, `noMotionConfirmations`, `settle`, `motionRegion`, `options`, `output:{omitText}`; result
`ScrollUntilCompleted {reason: ScrollUntilStopReason, steps, delivered, action, textMatch, lastMotion}`;
`SCROLL_UNTIL_DEFAULTS` exported (50 steps / 2 confirmations / 400 ms).

## 3.7 Windows list (`auv_windows`)

```ts
// d.ts:5938-5943,6050-6071,6115-6221
runner.windows.list(options?: { excludeMinimized?: boolean; excludeOtherDesktops?: boolean; signal? })
  : Promise<readonly WindowClient[]>          // default: COVERS minimized + other desktops (flags exclude)
runner.windows.resolve(selector: WindowSelectorInit | WindowQuery, options?): Promise<WindowClient>
runner.windows.get(target: WindowTarget, options?): Promise<WindowClient>   // fresh GetWindow; NOT_FOUND when gone
runner.windows.from(target: WindowTarget): WindowClient                     // no call; re-bind to this route
interface WindowQuery { applicationId?; appName?; frontmost?; pid?; title?; titleContains? }  // ≤1 app field, ≤1 title field
type WindowTarget = string | Window | WindowClient | WindowRef

interface Window {   // camelCase protobuf message + $typeName
  ref?: { windowId: string }; title?: string; applicationName?: string; applicationId?: string;
  processId?: number; frame?: ScreenRect; isMain: boolean; isVisible: boolean;
  state?: { isMinimized?, isMaximized?, isFullscreen?, isVisible?, isFocused?, isAlwaysOnTop?, stackIndex?, desktop?: {id, isCurrent} }
}
```

* Invert the tool params: `{ excludeMinimized: !include_minimized, excludeOtherDesktops: !include_other_desktops }`.
* Map each client to the current normalized row shape `{ reference: {id: client.id}, application_id:
  client.window.applicationId, app_name: client.window.applicationName, title, frame, state }`. Watch two
  differences from the CLI JSON: SDK `state.desktop` is an object `{id,isCurrent}` (CLI row printed it as a
  scalar), and system windows (Window Server) have **no `applicationId`** (same limitation as the CLI;
  `resolveWindow`-style targeting must fail with the current actionable message).
* Verified shape: 19 windows on this host; first Window Server window had `title: 'StatusIndicator'`, no
  `applicationId`; `resolve({applicationId:'com.apple.finder'})` returned the Finder main window
  (id 462) — the same resolution rule the CLI used (`window.get → app:`).
* `windows.get` on an unknown id: `AuvRpcError rpcCode 5`, message `window:<id> was not found` — map to
  "call auv_windows to refresh window ids".

## 3.8 Activate (`auv_activate`)

```ts
// d.ts:536-600,767-781,5972-5981
runner.applications.activate(request: { applicationId: string; settle?: DurationInit }, options?)
  -> Promise<ActivateApplicationResponse>
// { requestedApplicationId, applicationIdKind: BUNDLE_ID|PROCESS_NAME|DESKTOP_APP_ID,
//   method: APPLE_SCRIPT_ACTIVATE|FOREGROUND_WINDOW, activatedWindow?, verification?:
//     {case:'verifiedForeground'|'foregroundMismatch', …}|{case:'unavailable'}, windowObservation? }
```

Current tool: `application.activate --target app:<id>`. SDK: `runner.applications.activate({applicationId},
{signal})`. Same caveat: `verification` may report `foregroundMismatch` when the app is not running/does not
come forward; surface it as a warning instead of claiming success (CLI receipt had the same field).
`--dry-run` for activate is **not side-effect free in the CLI** (documented in `notes/auv-cli-contract.md`);
the SDK has no dryRun here at all — keep `auv_invoke` dry-run on the CLI path.

## 3.9 Doctor (`auv_doctor`) — CLI-only

There is **no doctor API** in the SDK. `PermissionService` (`d.ts:42-78`) only probes four macOS permissions
and returns enum statuses, not the doctor report fields (`platform, process_id, executable, accessibility,
screen_recording_preflight, screen_capture_kit, screen_capture_kit_error, all_ok, warnings, recommendation`).
Keep `auv doctor --json` exactly as today (`runAuvDoctor`). It needs no daemon and is cheap. Optionally
augment with `runner.macos.permissions.probe()` inside the SDK transport only if we want a permission
fast-path — not worth losing the doctor contract.

## 3.10 Generic invoke (`auv_invoke`) — CLI fallback

See §4: the typed client covers 41/43 commands, but `auv_invoke` must accept arbitrary catalog argv
semantics, `--dry-run`, `scan.*` (no SDK surface), and the CLI-composed overlay commands. Keep the existing
catalog + argv builder + CLI runner for `auv_invoke` (and route it at the owned daemon, see §5). The offline
`auv_help` tool is unaffected (catalog is bundled).

## 3.11 Abort, timeouts, cleanup

* SDK has **no timeout option anywhere**; every call takes only `{ signal }`. Timeouts must be composed:

```js
const timeout = AbortSignal.timeout(timeoutMs)
const signal = execSignal ? AbortSignal.any([execSignal, timeout]) : timeout
try { await runner.displays.capture(undefined, { signal }) }
catch (error) {
  if (error instanceof AuvAbortError) {
    if (timeout.aborted) throw new AuvToolError(`AUV timed out after ${timeoutMs} ms`, { code: 'AUV_TIMEOUT' })
    throw new AuvToolError('AUV call was aborted', { code: 'ABORTED' })
  }
  …map rpcCode…
}
```

`AbortSignal.any` needs Node ≥ 20.3 (Host is Electron/Node 20+; keep `target: 'node20'`).
* Cancellation stops local waiting and asks the transport to cancel; it is **not** a rollback guarantee once
  a mutating request reached the daemon.
* Cleanup: `connection.close()` → `daemon.stop()` (or process exit). Captures are Runner resources — fetch
  pixels in-call, do not persist `captureId`s beyond the call.

---

# 4. Coverage gaps: all 43 `auv invoke` commands through the SDK

Legend: **direct** = one typed call; **composed** = 2–3 typed calls; **escape** = typed `RunnerClient` lacks a
wrapper but `invokeUnary` + the exported service descriptor works (verified pattern); **CLI-only** = no SDK
surface.

| # | CLI command | SDK path | Coverage |
| --- | --- | --- | --- |
| 1 | `accessibility.focusText` | `runner.accessibility.focusText({application, selector:{case:'query',value}, expectedRole?})` (`AccessibilityService.FocusText`) | direct |
| 2 | `application.activate` | `runner.applications.activate({applicationId})` | direct |
| 3 | `display.capture` | `runner.displays.capture(selector?, {resolution})` | direct (+ display selector) |
| 4 | `display.captureRegion` | `runner.displays.captureRegion(region, selector?, opts)` | direct |
| 5 | `display.clickText` | `displays.findText(…, {screenRegion})` → `input.click({bounds})` | composed |
| 6 | `display.findText` | `runner.displays.findText(selector?, query, opts)` | direct |
| 7 | `display.list` | `runner.displays.list()` | direct |
| 8 | `display.waitForText` | loop `displays.findText` + deadline/interval | composed (no RPC) |
| 9 | `input.clickPoint` | `runner.input.click(PointTarget, ClickOptions)` | direct |
| 10 | `input.dragMouse` | `runner.input.dragMouse({movement, button})` | direct |
| 11 | `input.getPointerPosition` | `invokeUnary(InputService.GetPointerPosition)` — no `RunnerClient` method | escape (verified) |
| 12 | `input.holdKeys` | `runner.input.holdKeys({target, keys, policy, duration})` | direct |
| 13 | `input.moveMouse` | `runner.input.moveMouse(MoveMouseRequest)` (server-streaming events) | direct (must rebuild CLI's straight-line request: `start:{source:{case:'point',value:{x,y}}}`, one cubic-bezier segment + `options {sampleRateHz:60, curveTolerance:0.5}`) |
| 14 | `input.pasteText` | `runner.input.pasteText` / `WindowClient.pasteText` | direct |
| 15 | `input.performKeyboardInputs` | `runner.input.keyboard({target, inputs:[{action:{case:'press'|'typeText'|'pasteText', value}}], dryRun})` | direct |
| 16 | `input.pressKeys` | `runner.input.pressKeys(request)` / `WindowClient.pressKeys` | direct |
| 17 | `input.scrollPoint` | `invokeUnary(InputService.ScrollPoint)` — no `RunnerClient` method; macOS returns UNIMPLEMENTED | escape |
| 18 | `input.typeText` | `runner.input.typeText` / `WindowClient.typeText` / `input.keyboard` | direct |
| 19 | `media.getNowPlaying` | `runner.macos.media.nowPlaying()` (`GetNowPlayingResponse.state`) | direct (macOS) |
| 20 | `media.pause` | `runner.macos.media.pause()` → `{outcome:{before,after,verified}}` | direct (macOS) |
| 21 | `media.play` | `runner.macos.media.play()` | direct (macOS) |
| 22 | `media.skipToNextTrack` | `runner.macos.media.nextTrack()` | direct (macOS) |
| 23 | `media.skipToPreviousTrack` | `runner.macos.media.previousTrack()` | direct (macOS) |
| 24 | `media.togglePlayback` | `runner.macos.media.togglePlayPause()` | direct (macOS) |
| 25 | `overlay.captureFrame` | `runner.overlay.show({overlay:{layers:[outline]}, options:{motion, lifecycle}})` | primitive reachable; CLI composes capture-frame defaults ("cells"), not binary-identical |
| 26 | `overlay.clickTarget` | `overlay.show` with cursor+outline+status layers | primitive reachable |
| 27 | `overlay.cursor` | `overlay.show` cursor layer | primitive reachable |
| 28 | `overlay.outline` | `overlay.show` outline layer | primitive reachable |
| 29 | `overlay.status` | `overlay.show` status layer | primitive reachable |
| 30 | `permission.probe` | `runner.macos.permissions.probe()` → `{screenRecording, screenCaptureKit, accessibility, automationToSystemEvents}` (enum statuses) | direct (macOS; not the doctor report) |
| 31 | `scan.coverage` | none — no service in SDK; `runner_support: no_route` (fixture dir) | **CLI-only** |
| 32 | `scan.frame` | none — same | **CLI-only** |
| 33 | `window.capture` | `(await runner.windows.get/resolve(...)).capture({resolution})` | direct |
| 34 | `window.clickText` | `w.findText(query)` → `w.click({bounds})` | composed |
| 35 | `window.findText` | `w.findText(query, opts)` | direct |
| 36 | `window.focus` | `w.setFocus()` (raise + focus, FAILED_PRECONDITION if minimized) | direct |
| 37 | `window.get` | `runner.windows.get(target)` / `w.refresh()` | direct |
| 38 | `window.list` | `runner.windows.list({excludeMinimized, excludeOtherDesktops})` | direct |
| 39 | `window.scroll` | `w.scroll(point, {deltaX,deltaY}, scrollOptions?)` | direct |
| 40 | `window.scrollUntil` | `w.scrollUntil(point, request, {until,onUpdate})` | direct (full parity incl. predicate) |
| 41 | `window.setFrame` | `w.setFrame({origin?, size?})` → `WindowMutationResult` | direct |
| 42 | `window.setState` | `w.setState(WindowStateTarget.NORMAL\|MINIMIZED\|MAXIMIZED)` | direct |
| 43 | `window.waitForText` | loop `w.findText` | composed (no RPC) |

Counts: **35 direct + 4 composed + 2 escape = 41 reachable**, 2 CLI-only. `auv_doctor` is not one of the 43
(CLI root command) and stays CLI.

### Can `runners.discover()` + `invokeUnaryJson` cover the gaps generically?

Partially — and not as a drop-in for `auv invoke`:

* `auv.runners.discover({runnerClass:'auv.core.local'})` performs a gRPC Reflection session and returns
  `apis: DiscoveredRpcMethod[]` — methods carrying AUV's `discoverable` annotation. **On 0.0.43 the entire
  core driver surface is discoverable**: verified 49 discoverable methods, all with presentation ids, such as `display.list`,
  `display.capture`, `input.getPointerPosition`, `input.scrollPoint`, `window.scrollUntil`,
  `permission.probe`, `media.*`, `overlay.show`, `capture.getImage`, `text.recognize`, plus
  `frameBuffer.*`. `core.invokeUnaryJson({method:'/auv.api.driver.v1.DisplayService/ListDisplays', input:{}})`
  returned the correct ProtoJSON response; `GetPointerPosition` through it also worked.
* `describeMethod('/pkg.Service/Method')` describes any reflected method (also non-discoverable), but
  **`invokeUnaryJson` only resolves methods present in `apis`** (`discover.ts::resolve` throws
  `AuvProtocolError: … does not expose …` otherwise), so "reflection covers everything" is not an invoke
  guarantee.
* The request/response are **ProtoJSON of the RPC messages**, not CLI argv. `input.clickPoint 10 20
  --target app:… --relative-to window` requires building `ClickPointRequest{position, options, window}`,
  recreating CLI defaults (`relative-to`, `normalized`, `click-count`, policy validation, output shaping).
  That is the same per-command mapping work as the typed path, i.e. no generic shortcut.
* `scan.frame`/`scan.coverage` have **no RPC service at all** (`runner_support: no_route`, fixture-dir
  commands executed by the CLI) → genuinely CLI-only.
* Verdict: keep `auv_invoke` on the CLI (it is the arbitrary-command escape hatch we already have), and only
  use discovery/invokeUnaryJson for extension runners or future tools. The typed service escape hatch
  (`invokeUnary` + `InputService.method.*`) is what covers `getPointerPosition`/`scrollPoint` inside a typed
  transport.

`auv_help` (catalog) stays offline and bundle-local; `auv_doctor` stays CLI; `auv_invoke` stays CLI (hybrid,
see §5). So a full SDK migration still ships the CLI spawn path for 2 of 11 tools — by design.

---

# 5. Proposed semantic transport interface

Goal: `src/tools.mjs` should depend on a **transport object**, not on argv/catalog or SDK types. Both the
existing CLI implementation (wrapping `src/auv.mjs` + `src/catalog.mjs`) and a new SDK implementation can
satisfy it; the tool definitions, parameter schemas, and output renderers stay unchanged. All shapes below
are the *normalized* shapes the tools currently consume (snake_case, no `$typeName`, no protobuf `Buffer`
leaks), so the adapter absorbs CLI-vs-SDK differences.

```ts
// JSDoc/TS shape only (plugin stays plain ESM JS)
interface AuvTransport {
  /** Resolve binary, probe `auv --version`, start/attach daemon, health-check, warm the client. Idempotent. */
  init(options: { signal?: AbortSignal }): Promise<void>
  /** Close connections and stop an owned daemon; safe to call twice. */
  close(): Promise<void>
  /** Which backend is live, for auv_doctor output and debugging. */
  readonly kind: 'cli' | 'sdk'
  /** Optional: whether this transport can serve a given catalog command id itself (else falls back to invoke). */
  supports?(commandId: string): boolean

  doctor(opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<DoctorReport>
  // DoctorReport = { platform, process_id?, executable?, accessibility, screen_recording_preflight?,
  //                  screen_capture_kit?, screen_capture_kit_error?, all_ok, warnings?, recommendation? }

  screenshot(opts: {
    signal?: AbortSignal; timeoutMs?: number
    windowId?: string; applicationId?: string; displayId?: string
    region?: { x: number; y: number; width: number; height: number }
  }): Promise<CaptureResult>
  // CaptureResult = { command_id, status: 'completed', run_id: string | null,
  //                   artifact_path: string, content_type: 'image/webp',
  //                   width: number, height: number, result: unknown, artifacts: Artifact[], warnings: string[] }

  ocr(opts: {
    signal?: AbortSignal; timeoutMs?: number; text: string
    windowId?: string; applicationId?: string; wait?: boolean; pollTimeoutMs?: number
  }): Promise<OcrResult>
  // OcrResult = { command_id, status, run_id: string | null,
  //               result: { matches: TextMatch[], capture?, display?/window? },
  //               timed_out: boolean, warnings: string[] }
  // TextMatch = { text, bounds: {x,y,width,height}, confidence? }

  click(opts: {
    signal?: AbortSignal; timeoutMs?: number
    text?: string; x?: number; y?: number
    windowId?: string; applicationId?: string; displayId?: string
    button?: 'left' | 'right' | 'middle'
    within?: { left: number; top: number; right: number; bottom: number }
  }): Promise<InputResult>

  type(opts: {
    signal?: AbortSignal; timeoutMs?: number; text: string; mode?: 'type' | 'paste'
    windowId?: string; applicationId?: string
    policy?: 'background-only' | 'background-preferred' | 'foreground-preferred'
  }): Promise<InputResult>

  keys(opts: {
    signal?: AbortSignal; timeoutMs?: number
    keys: string[]; repeat?: number; intervalMs?: number
    windowId?: string; applicationId?: string
  }): Promise<InputResult>

  scroll(opts: {
    signal?: AbortSignal; timeoutMs?: number
    dy: number; dx?: number
    windowId?: string; x?: number; y?: number
  }): Promise<ScrollResult>

  windows(opts: {
    signal?: AbortSignal; timeoutMs?: number
    includeMinimized?: boolean; includeOtherDesktops?: boolean
  }): Promise<WindowsResult>
  // WindowsResult = { command_id, status, run_id, windows: WindowRow[], warnings }
  // WindowRow = { reference: { id: string }, application_id: string | null, app_name?: string,
  //               title: string | null, frame: { origin: {x,y}, size: {width,height} } | null,
  //               state: { is_minimized?, is_maximized?, is_fullscreen?, is_visible?, is_focused?, is_always_on_top?, desktop? } }

  activate(opts: {
    signal?: AbortSignal; timeoutMs?: number; applicationId: string
  }): Promise<InputResult>   // result = ActivateApplicationResponse-like normalized object

  /** Arbitrary catalog command with CLI argv semantics. In the SDK transport this delegates to the CLI
   *  fallback (credential routed to the owned daemon); it is the one method allowed to spawn `auv`. */
  invoke(opts: {
    signal?: AbortSignal; timeoutMs?: number
    commandId: string
    inputs?: Record<string, unknown>
    target?: { application_id?: string; window_id?: string; display_id?: string }
    dryRun?: boolean
  }): Promise<InvokeResult>
  // InvokeResult = { command_id, status, run_id, result, artifacts: Artifact[], warnings }
  // Artifact = { file_path, content_type?, uri?, ... }  (CLI receipts only; SDK-side captures synthesize one)

  /** Catalog-only; offline, no AUV calls (shared by both transports). */
  help(opts: { signal?: AbortSignal; commandId?: string }): Promise<HelpResult>
  // HelpResult = { mode: 'summary' | 'command', command_id?, count?, text: string }

  /** Optional: surface the live daemon/client for tests/inspection. */
  debug?(): { daemonId?: string; pid?: number; endpoint?: string; runnerId?: string }
}
```

### Per-method input/output shapes (exact)

`CaptureResult.result` (normalized from either backend) keeps the fields the screenshot renderer reads:
`{ capture: { backend, bounds: {x,y,width,height}, pixel_dimensions: {width,height}, scale_factor, fallback_reason }, display?/window? }`.
`InputResult` / `ScrollResult` normalize `InputActionResult`:
`{ selected_path, attempts: [{path, succeeded, message?}], mouse_disturbance, focus_disturbance, clipboard_disturbance, verified }`,
plus `target`, `window?/display?`, `point?`.

### Where CLI and SDK semantics differ (and must be absorbed by the adapter)

| Aspect | Current CLI implementation | SDK implementation |
| --- | --- | --- |
| Process model | one `auv [--no-daemon] invoke` child per call | one long-lived `auv serve` child + unix-socket gRPC client (per-run route optional) |
| Daemon ownership | none (CLI auto-starts/hits the user's registered daemon, or `--no-daemon` in-process) | app-owned (or discover-attach), private socket + launcher token |
| Capture output | AUV writes `.webp` artifact; receipt has `file_path`/`content_type`/pixel dims | bytes from `captures.image` + `CapturedFrame` metadata; **transport must write the file** and clean it up |
| Coordinate spaces | `--relative-to` defaults: window for app/window target, display for display target, screen otherwise | `Position.screen/display/window` explicit; plain `{x,y}` = window-local on `WindowClient`, screen on `input`; `{bounds}` = center |
| Scanning/text wait | single CLI call per command; `waitForText`/`clickText` are CLI-side compositions with `--interval-ms` | `findText` + client loop; no interval/exact stop semantics — mirror the CLI's `timeout_ms`/`interval_ms` contract ourselves |
| `--dry-run` | CLI supports it for the catalog (but not side-effect-free for `application.activate`) | only `PerformKeyboardInputsRequest.dryRun` / `PressKeysRequest.dryRun`; all other typed calls have no dry-run |
| Tracing/runs | per-invoke `run_id`, CLI trace records under store root, `records.jsonl` | Runs must be created explicitly (`auv.runs.create/stop`); no persisted per-RPC trace promise; CLI trace files absent |
| Overlays | `--no-overlay` suppresses CLI implicit overlay effects | no implicit overlays; only explicit `overlay.show(...)` |
| Artifact/URI | `artifacts[].uri` (`auv://runs/…`), sha256, byte_length | none — synthesize the minimal artifact record for parity, or drop fields |
| Errors | non-JSON clap errors + JSON `failure_details.code` (`invalid_target`, …) | typed `AuvRpcError.rpcCode`, `AuvHttpError`, `AuvConfigurationError`, …; map to the same user-facing messages/hints |
| Version check | `auv` binary on PATH/`AUV_BIN`; version = CLI version | `binaryPath` (we pass the resolved absolute path); no version API → run `auv --version` once |
| `AUV_DSH_NO_DAEMON` / `AUV_DSH_OVERLAY` | existing env flags control spawn mode | unused for typed calls; keep `AUV_DSH_TRANSPORT=cli\|sdk` and reuse `AUV_DSH_STORE_ROOT` for run store/artifact dirs |
| Startup latency | ~one process spawn (~100 ms) per call + daemon hop | first call starts daemon (up to 10 s) and lazily starts `auv.core.local` Runner (5 min idle lifetime after last request); subsequent calls are ms |

Implementation split proposal:

* `src/transport/interface` (JSDoc types + `createTransport()` selector from `AUV_DSH_TRANSPORT`).
* `src/transport/cli.mjs` = today's `src/auv.mjs` logic behind the interface (doctor/invoke/help/capture…),
  including catalog argv building (`invoke`, `help`).
* `src/transport/sdk.mjs` = `@auv-js/sdk/node` client, daemon singleton, run-per-call (optional), typed
  methods, and **delegating `invoke`/`doctor` to the CLI harness pointed at the owned daemon**:
  `AUV_ENDPOINT = daemon.connectionOptions.endpoint`; `auv --credential-stdin invoke … --json --no-overlay
  --store-root <DSH store>` with `daemon.connectionOptions.credential + '\n'` on stdin (verified working —
  receipt came back `status: completed`, `run_id`, `store_root` = CLI store, `result.displays`).
  For `doctor` no credential is needed. Fallbacks: if the token is unavailable or the daemon start failed,
  CLI `--no-daemon` / plain CLI behavior stays available.
* `src/auv.mjs` remains the binary resolver + child-process runner used by the CLI transport and SDK
  fallback; `src/tools.mjs` calls only the transport interface (plus `help`).
* `auv_doctor` should also report `transport.kind`, daemon id/pid/endpoint, and AUV version so debugging is
  possible; permission hints continue to key off error text.

---

# 6. Practical bundling notes

## 6.1 How AUV itself builds the SDK

`js/packages/sdk/tsdown.config.ts` (fetched from `main`):

```ts
export default defineConfig({
  deps: { neverBundle: [/^@auv-js\/api-client$/u, /^node:/u] },
  dts: { sourcemap: true },
  entry: { index: 'src/web/index.ts', node: 'src/node/index.ts' },
  fixedExtension: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
})
```

The published `dist/node.js` therefore keeps **all package.json dependencies external** (imports for
`@auv-js/api-client`, `@bufbuild/protobuf`, `@grpc/grpc-js`, `@moeru/std/merge`, `date-fns`, `es-toolkit/object`,
`std-env`, `tinyexec`, `node:*`); only AUV's own code is in the two chunks (`dist/node.js` 30 kB +
`dist/http-CsZ_w91Z.js` 222 kB). AUV ships those deps as npm dependencies. We cannot: our install model is a
linked/single `.mjs`, so **we must bundle the deps into our output** (tsdown bundles dependencies by default,
as observed; `platform: 'node'` keeps `node:*` external).

## 6.2 Measured bundle sizes (this host, tsdown 0.23.7 / rolldown 1.3.0)

Test project `/tmp/auv-bundle-test`: SDK 0.0.43 + pinned deps extracted by hand into `node_modules`, plain
`index.js` importing from `@auv-js/sdk/node`, built with the same config style as the plugin
(`format: ['esm']`, `platform: 'node'`, `target: 'node20'`, `dts: false`).

| Build | Raw | gzip |
| --- | --- | --- |
| `import { connect, createAuv, startAuv, createUnixSocketTransport } from '@auv-js/sdk/node'` | **954.50 kB** | **210.62 kB** |
| same, with `external: ['@grpc/grpc-js']` (not single-file) | 444.08 kB | 109.77 kB |
| node entry subset `import { connect, createAuv }` (tree-shakes daemon/tinyexec) | 925.01 kB | 201.69 kB |
| current plugin bundle (checked-in `dist/index.mjs`, catalog + tools + es-toolkit) | 162.21 kB | 31.42 kB |
| **simulated combined bundle**: current `index.js`+`src` with an SDK import retained (catalog 57 kB + SDK graph + grpc-js) | **1.12 MB** | **241.21 kB** |

So budget **≈ +960 kB raw / ≈ +210 kB gzip** for the SDK, final plugin bundle **≈1.1 MB raw / ≈240 kB gzip**.
`@grpc/grpc-js` (+ `@js-sdsl/ordered-map`) is ≈510 kB raw / ≈101 kB gzip of it — unavoidable while the Node
entry statically imports grpc transports (needed for the app-owned unix socket; the HTTP/WebSocket transports
are for paired remote listeners, not the local socket).

## 6.3 Bundling risks and configuration

* **CJS interop works.** `@grpc/grpc-js` is a CJS package; rolldown wrapped it successfully. The bundled
  entry loads and works: `createUnixSocketTransport({path})` creates a gRPC `Client`; `connect({endpoint:
  '/tmp/nonexistent', transport:'unix', signal: AbortSignal.timeout(400)})` rejects with `AuvAbortError`
  (rather than crashing); a full `startAuv()` lifecycle from the bundled output succeeded (spawn → health →
  displays → `daemon.stop()` exit code 0). Capture/OCR probes used the unbundled package for convenience;
  the daemon/transport paths were exercised from the bundle.
* **Two lazy dynamic requires remain unresolved**: `@grpc/grpc-js/build/src/channelz.js:580` and `orca.js:36`
  do `require('@grpc/proto-loader')` (channelz/ORCA server-side instrumentation). rolldown emits
  `__require("@grpc/proto-loader")` shims (34 `__require` occurrences in the bundle), which throw only if
  called. They are not on the client unary/duplex path, but add a guard/test that keeps them unreachable, or
  alias `@grpc/proto-loader` to a throwing stub with a clear message. Do not add proto-loader to the bundle
  (it would pull protobufjs + yargs, several MB) unless needed.
* `node:*` builtins are external automatically under `platform: 'node'` (tsdown/rolldown default). `platform:
  'neutral'` (AUV's choice) would need explicit externals — use `platform: 'node'`.
* tsdown prints a hint ("consider adding deps.onlyBundle") on every build because packages were bundled; it is
  cosmetic. If the SDK ends up in package.json `dependencies` (for types/dev), tsdown still bundles it by
  default; `deps.neverBundle` would *exclude* it (do not do that for the published artifact).
* `es-toolkit` is already in the plugin (`^1.53.2`) and SDK accepts `^1.50.0`; one copy is bundled/tree-shaken.
  `date-fns` (milliseconds helper) and `@bufbuild/protobuf` are bundled; `date-fns` is fully tree-shaken to the
  used import.
* Keep `target: 'node20'`, `format: ['esm']`, `dts: false`, `sourcemap: false` (current config). No
  `noExternal` list needed for node builtins. If a single-file artifact stops being a hard requirement,
  `external: ['@grpc/grpc-js']` + shipping it as a real dependency roughly halves the raw size (444 kB /
  110 kB gzip) — but that breaks the zero-dependency install model the plugin has today (linked directory;
  no `node_modules` guarantee).
* Startup cost: daemon spawn + first Runner start is the slow path (health wait up to 10 s; lazy Runner stays
  5 min). Warm the client lazily on the first tool call and keep it; `daemonIdleTimeoutSeconds`/lifecycle of
  the runner are daemon-side defaults.

---

# 7. Risks / uncertainties / questions for the SDK maintainer

Risks (ranked):

1. **TCC/permission attribution of the owned daemon.** A daemon spawned by the Host is a child of the Host
   process; macOS attributes Screen Recording/Accessibility to the responsible app. Empirically it works
   when spawned from this session's process tree (screen capture + Vision OCR succeeded with AUV 0.0.43),
   but it may differ from the CLI-spawned detached daemon path (which has its own TCC identity/consent
   flow). Must be verified in the real DSH Host and documented for users (grant to DeepSeek Harness, then
   `auv_doctor`).
2. **Daemon lifecycle vs plugin HMR/reload.** Without a dispose hook a reload can leak a daemon (new private
   socket each `startAuv`, old daemon alive until Host exit). Mitigate with `globalThis` singleton + best-effort
   `daemon.stop()` when the tools registry unloads; confirm whether the DSH Host exposes plugin dispose.
3. **Tracing/run parity.** CLI calls produce `run_id` + trace files; SDK calls need explicit
   `runs.create/stop` and still do not promise persisted per-RPC tracing. Decide whether `run_id` remains in
   tool output (recommend: yes, per-call Run) and document that CLI trace artifacts may be absent.
4. **Capture artifact ownership.** SDK returns bytes; we must write/retain/clean files for `read_image`.
   Need a directory under DSH data (reuse `AUV_DSH_STORE_ROOT`/`~/.dsh/auv/runs`), naming scheme, and an
   eviction policy; capture refs expire (~10 min idle / LRU), so no cross-call reuse.
5. **Binary/version distribution unchanged.** The SDK still needs the external `auv` executable
   (`binaryPath`), so users keep the current install instructions; we must add a version check (`auv
   --version` ≈ 0.0.43) because the SDK has no version API and RPC drift surfaces as UNIMPLEMENTED.
6. **Hybrid complexity.** Two transports + credential plumbing (`AUV_ENDPOINT` + `--credential-stdin`) for
   `auv_invoke`/`auv_doctor`; `--no-daemon` fallback when the token/daemon is unavailable. Handle mid-session
   daemon crashes (`daemon.exited`) by recreating on next call.
7. **Semantic drift in composed tools** (`display.clickText`, `window.clickText`, `*waitForText`): extra RPCs,
   small race windows, and different stop/timeout semantics than the CLI. Keep timeouts/behavior contracts in
   the adapter and test against the CLI baseline.
8. **0.0.x churn.** `0.0.43` is pre-1.0; README/package mismatches already exist (`auv-js/node` bare specifier
   in examples, `createWebSocketTransport` not exported, README transport list ahead of code). Pin exactly
   `0.0.43` and re-read the README when bumping.
9. **Bundle size** (~1.1 MB, ~240 kB gzip) and the two lazy `@grpc/proto-loader` requires; if DSH enforces a
   plugin size budget, revisit `external`/side-by-side dependency strategy.
10. **`startAuv` startup failures** are clean (`AuvDaemonStartError` with output) but there is no retry/backoff
    policy; decide behavior (surface install/permission guidance, keep tools registered, retry on next call).
11. **macOS-only permissions/commands** (`permission.probe`, `media.*`, `input.scrollPoint`) — Linux/Windows
    parity degrades to the CLI's support matrix; keep `auv_doctor` as the source of truth.
12. **Plugin host process question**: DSH Host plugins are Node/ESM and can spawn processes, but confirm they
    run in the Electron main process (where `startAuv` is documented safe) rather than a renderer/utility
    process with different TCC/stdio semantics.

Questions for the AUV SDK maintainer (nekomeowww / moeru-ai):

1. Is `startAuv()` + `daemon.connect()` the intended embedding for a desktop host that already ships its own
   UI, and is there a supported "reuse an existing app-owned daemon across host restarts/updates" story
   (socket/token stability, `storeRoot` reuse, version bump handling)?
2. Can the SDK expose an AUV daemon/binary version (health currently returns only `{id, status}`)? What is the
   compatibility contract between SDK `0.0.x` and `auv` binary versions?
3. Recommended way for a host to run **CLI fallback** against its owned daemon — is
   `AUV_ENDPOINT` + `--credential-stdin` the supported, stable contract (we verified it works)?
4. Capture lifecycle: should hosts persist `captures.image` output themselves (we do), is `captureId` stable
   only within a Runner route, and is there a supported artifact/URI store we should prefer?
5. Runs/tracing: what is the expected usage for per-tool-call correlation (one Run per call vs long-lived
   Run), and will typed SDK calls ever write the same trace records as `auv invoke`?
6. Overlay: are the CLI `overlay.outline/cursor/status/captureFrame/clickTarget` conveniences going to be
   exposed as typed SDK helpers, or is raw `overlay.show` the supported API? Are their CLI defaults stable?
7. `@grpc/proto-loader`: are the lazy `require`s in channelz/ORCA safe to stub out in a bundled client? Any
   plans to ship an ESM-friendly grpc build (or an HTTP-only local transport) to avoid bundling grpc-js?
8. Bundling: is `@auv-js/sdk/node` tested as a bundled single file (non-npm install), and are there known
   issues bundling `@grpc/grpc-js`/`@bufbuild/protobuf` (we found only the two proto-loader requires)?
9. Discovery: should a host prefer `connect({discover:true})` to attach to a user's registered daemon, and is
   there a supported "start if absent" API without owning the child (shared ownership contract)? (README
   explicitly says shared connect-or-start discovery is deferred.)
10. Electron packaging: has the AUV team tested `startAuv` from an Electron main process with an app-specific
    macOS helper (`platforms.macos.helperApp`) and TCC attribution? Any recommended permission flow?

---

# 8. Evidence / reproduction (all under /tmp, no workspace changes)

SDK inspection:

```sh
curl -sL https://registry.npmjs.org/@auv-js/sdk/-/sdk-0.0.43.tgz -o /tmp/auv-sdk.tgz
mkdir -p /tmp/auv-sdk-pack && tar -xzf /tmp/auv-sdk.tgz -C /tmp/auv-sdk-pack
# type map: /tmp/auv-sdk-pack/package/dist/node.d.ts + http-BuUYgKEG.d.ts
curl -sL https://raw.githubusercontent.com/moeru-ai/auv/main/js/packages/sdk/tsdown.config.ts
curl -sL https://raw.githubusercontent.com/moeru-ai/auv/main/js/packages/sdk/src/node/daemon.ts
curl -sL https://raw.githubusercontent.com/moeru-ai/auv/main/crates/auv-cli/src/commands/serve.rs
curl -sL https://raw.githubusercontent.com/moeru-ai/auv/main/crates/auv-daemon/src/discovery.rs
curl -sL https://raw.githubusercontent.com/moeru-ai/auv/main/crates/auv-cli/src/local_daemon.rs
```

Runtime probes (`/tmp/auv-bundle-test` contains the extracted SDK + pinned deps and a tsdown test project):

| Script | What it proved |
| --- | --- |
| `lifecycle-test.mjs` | `startAuv()` → private unix socket `unix:///private/var/folders/…/T/auv-XXXX/s`, `connectionOptions {local:true, transport:'unix', hasCredential:true}`, `health {id, status:'serving'}` matching `daemon.id`, `displays.list()` → `[{displayId:'1', scaleFactor:2, primary:true, frame 1728×1117}]`, `daemon.stop()` → `{code:0}`. |
| `capture-test.mjs` | `CapturedFrame {scaleFactor, backend:'xcap.macos', thumbhash, bounds, origin, ref:{captureId}, pixelSize}`; WEBP 172 bytes `RIFF…WEBPVP8L`; RGBA `maxSize {20,20}` → 20×15 = 1200 bytes; `windows.list` 19 clients; `resolve({applicationId:'com.apple.finder'})`; `AuvRpcError rpcCode 5/3` messages. |
| `ocr-test.mjs` | `display.findText` 0 matches for "DeepSeek"; `recognizeText(capture)` → 2419 chars / 163 regions / screen `origin`; `window.findText` 1 match. |
| `shapes-test.mjs` | display selector capture; window capture 1840×872 WEBP; `keyboard`/`pressKeys` dry-run (no delivery); `invokeUnary(InputService.GetPointerPosition)` works; `ScrollPoint` → rpc 12 on macOS; `runs.create/stop`. |
| `discover-test.mjs` | `runners.discover('auv.core.local')` returns 50+ discoverable core methods with presentation ids; `invokeUnaryJson('/…DisplayService/ListDisplays')` and `/…InputService/GetPointerPosition` both work. |
| `hybrid-test.mjs` | `auv --credential-stdin invoke display.list --json` against the SDK-owned daemon via `AUV_ENDPOINT`: exit 0, receipt `status:'completed'`, CLI `run_id`, `store_root`/tmp/auv-scout-cli-store. |
| `npm-free bundling` | raw/gzip numbers in §6.2; bundled entry loads, grpc Client creation/abort works, startAuv lifecycle works from the bundled file. |

Also relied on `notes/auv-cli-contract.md` (verified CLI argv/receipt contract for the current transport) and
the installed `auv 0.0.43` binary; no desktop input was delivered during this research (only read-only
capture/OCR/window/discovery calls and `dryRun: true` keyboard validation).

---

# 9. File reference map

SDK package (paths relative to `node_modules/@auv-js/sdk/`, tarball `/tmp/auv-sdk-pack/package/`):

| API area | `dist/node.d.ts` | `dist/http-BuUYgKEG.d.ts` | GitHub source (`js/packages/sdk/src/`) |
| --- | --- | --- | --- |
| daemon start/handle | 29-41 (`connect`), 103-291 (`AuvDaemon`, listeners, `StartAuvOptions`, `AuvDaemonStartError`) | — | `node/daemon.ts`, `node/index.ts` |
| discovery / credential / context | 3-27, 43-54, 293-312 | — | `node/discovery.ts`, `node/credential.ts`, `node/context.ts` |
| transports | 314-330 | 5028-5130 | `node/grpc.ts`, `web/http.ts`, `transport/*` |
| connection + errors | — | 5078-5173 | `transport/connection.ts`, `transport/errors.ts` |
| client / health / runners / runs | — | 5174-5367, 6312-6359 | `apis/auv-daemon/*`, `apis/auv/client.ts` |
| RunnerClient / WindowClient / captures / OCR / input | — | 5906-6282 | `apis/auv/driver.ts` |
| invoke + discovery | — | 6284-6310, 5368-5449 | `apis/auv/invoke.ts`, `apis/auv/discover.ts` |
| geometry helpers | — | 6361-6440 | `apis/auv/geometry.ts` |
| generated protobuf types/enums/services | — | 5-1569, 1570-4246, 4247-4673, 4674-5027, 5450-5569, 5583-5905, 5863-5904, 6449-6814 | `src/gen/…` (regenerated by `@bufbuild/protoc-gen-es`) |
| capture/OCR data shapes | — | 990-1568 (`CapturedFrame`, `ImageFrame`, `GetCaptureImage*`, `RecognizeText*`, `Find*Text*`) | `src/gen/auv/api/driver/v1/capture_pb.ts`, `text_recognition_pb.ts`, `image/v1/*` |
| input protos | — | 1570-4246 (`ClickOptions`, `TypeTextOptions`, `PressKeys*`, `PerformKeyboardInputs*`, `Scroll*`, `InputActionResult/Failure`, `InputPolicy`, `MouseButton`, …) | `src/gen/auv/api/driver/v1/input_pb.ts` |
| window/display/application/overlay/media/permission/accessibility protos | — | 211-535, 783-874, 536-782, 4247-4673, 5583-5862, 5-78, 5450-5569 | matching `src/gen/auv/api/driver/v1|macos/v1/*_pb.ts` |
| README (Electron example, local auth, capture refs, discovery, runs) | — | — | `js/packages/sdk/README.md` (0.0.43 tarball `README.md`) |
| build config | — | — | `js/packages/sdk/tsdown.config.ts`, `package.json` |

AUV Rust sources referenced:

* `crates/auv-cli/src/commands/serve.rs` — `serve` flags, default `--local-auth-allowed-methods os-user`,
  `--exit-on-stdin-close`, `--no-register`, discovery registration.
* `crates/auv-daemon/src/discovery.rs` — descriptor publish (`{endpoint, instance_id, store_root}`), lock,
  private permissions, drop-on-exit.
* `crates/auv-cli/src/local_daemon.rs` — CLI auto-start: detached registered `os-user` daemon,
  `--idle-exit-after 300`, `AUV_ENDPOINT` precedence.
* `crates/auv-cli/src/cli.rs` — root `--credential-stdin`, `--no-daemon` (invoke/mcp only), `--run`.
* `crates/auv-cli-invoke/src/runner.rs`, `commands/input.rs`, `commands/window.rs`, `commands/overlay.rs`,
  `commands/scan.rs` — Runner-route vs direct execution, CLI defaults that a generic SDK `auv_invoke`
  replacement would have to reproduce.
