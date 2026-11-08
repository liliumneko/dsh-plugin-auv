/**
 * `@auv-js/sdk` transport for @local/dsh-auv — attach-first, SDK-only.
 *
 * The plugin never invokes the `auv` CLI. On the first tool call it:
 *
 *   1. **Attaches** to the user's already-running AUV daemon through
 *      `connect({ discover: true })` (the discovery descriptor is published by
 *      `auv serve` / `auv invoke` and accepts any process of the same OS user,
 *      so no credential is needed). The attempt is bounded by a short timeout.
 *   2. **Starts its own daemon** with `startAuv()` only when no discoverable
 *      daemon is reachable. The owned daemon keeps the private socket,
 *      launcher-token auth, no-discovery-registration and
 *      exit-on-stdin-close behaviour from the previous design.
 *
 * Ownership is tracked so that dispose only stops the daemon the plugin
 * started: an attached daemon is left running (only the connection is closed).
 * `auv_doctor`, diagnostics and typed tool values report `attached` vs `owned`.
 *
 * The singleton lives on `globalThis` (symbol key) so a DSH plugin reload can
 * reuse the connection/daemon instead of leaking one. A transport-level failure
 * (daemon exited / socket gone) forgets the client so the next tool call can
 * re-attach or start again.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  AuvAbortError,
  AuvConfigurationError,
  AuvDaemonStartError,
  AuvProtocolError,
  AuvRemoteError,
  AuvRpcError,
  AuvTransportError,
  CaptureResolution,
  ImageEncoding,
  InputPolicy,
  InputService,
  MouseButton,
  Position,
  connect,
  createAuv,
  discoverEndpoint,
  inputActionProgress,
  invokeUnary,
  startAuv,
} from '@auv-js/sdk/node'

import { AuvError, clampTimeout, permissionHint, resolveAuvBinary } from '../auv.mjs'
import {
  INPUT_POLICY_VALUES,
  PERMISSION_RECOMMENDATION,
  activationWarning,
  buildClickOptions,
  buildPressKeysRequest,
  displaySelector,
  formatTargetString,
  mapActivateResult,
  mapCapturedFrame,
  mapDisplay,
  mapTextMatches,
  mapWindowRow,
  messageOf,
  normalizeMessage,
  permissionsAllOk,
  summarizePermissions,
} from './sdk-format.mjs'

// ---------------------------------------------------------------------------
// Constants / paths / environment
// ---------------------------------------------------------------------------

const RUNNER_CLASS = 'auv.core.local'
const CAPTURE_MAX_SIZE = 2048
const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_ATTACH_TIMEOUT_MS = 2_000
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000

function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh')
}

/** Owned-daemon store root: AUV_DSH_SDK_STORE_ROOT, else <DSH data>/auv/sdk. */
export function sdkStoreRoot() {
  const override = (process.env.AUV_DSH_SDK_STORE_ROOT ?? '').trim()
  return override !== '' ? override : path.join(dshHome(), 'auv', 'sdk')
}

/** Capture artifact directory: AUV_DSH_CAPTURE_DIR, else <DSH data>/auv/sdk-captures. */
export function sdkCaptureRoot() {
  const override = (process.env.AUV_DSH_CAPTURE_DIR ?? '').trim()
  return override !== '' ? override : path.join(dshHome(), 'auv', 'sdk-captures')
}

/** First line of an error message, for compact diagnostics. */
function firstLine(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const newline = value.indexOf('\n')
  return newline === -1 ? value : value.slice(0, newline)
}

function tail(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`
}

// ---------------------------------------------------------------------------
// Global singleton state (HMR-safe)
// ---------------------------------------------------------------------------

const STATE_KEY = Symbol.for('@local/dsh-auv/sdk-transport.v2')

/** Fresh transport state. Exported for the offline self-check. */
export function createSdkTransportState() {
  return {
    connection: null,
    auv: null,
    runner: null,
    daemon: null,
    mode: null,
    endpoint: null,
    daemonId: null,
    pid: null,
    transport: null,
    initPromise: null,
    closing: null,
    attachAttempted: false,
    attachError: null,
    lastError: null,
  }
}

function getState() {
  if (globalThis[STATE_KEY] === undefined) globalThis[STATE_KEY] = createSdkTransportState()
  return globalThis[STATE_KEY]
}

/** Drop the client fields without closing anything (used on transport death). */
function forgetTransport(shared, reason) {
  shared.connection = null
  shared.auv = null
  shared.runner = null
  shared.daemon = null
  shared.mode = null
  shared.endpoint = null
  shared.daemonId = null
  shared.pid = null
  shared.transport = null
  if (reason !== undefined) shared.lastError = reason
}

// ---------------------------------------------------------------------------
// Init: attach-first, start-owned fallback
// ---------------------------------------------------------------------------

/** SDK entry points, overridable by the offline self-check. */
export const SDK_DEPENDENCIES = Object.freeze({
  connect,
  createAuv,
  startAuv,
  discoverEndpoint,
  resolveBinary: resolveAuvBinary,
})

function adoptTransport(shared, adopted) {
  shared.connection = adopted.connection
  shared.auv = adopted.auv
  shared.runner = adopted.runner
  shared.daemon = adopted.daemon
  shared.mode = adopted.mode
  shared.endpoint = adopted.endpoint
  shared.daemonId = adopted.daemonId
  shared.pid = adopted.pid
  shared.lastError = null
  const facade = createFacade(shared)
  shared.transport = facade
  if (adopted.daemon !== null) {
    // An owned daemon exiting must drop our client so the next call can start
    // (or attach to) a fresh one. The daemon handle itself is not ours to stop.
    const drop = () => {
      if (shared.daemon !== adopted.daemon) return
      forgetTransport(shared, 'The AUV daemon exited.')
    }
    adopted.daemon.exited.then(drop, drop)
  }
  return facade
}

/**
 * Try `connect({ discover: true })`: attach to the user's registered daemon.
 * Returns the facade on success or null when nothing discoverable is reachable.
 */
async function tryAttach(shared, deps) {
  let connection
  try {
    let endpoint = null
    if (typeof deps.discoverEndpoint === 'function') {
      try {
        const discovered = await deps.discoverEndpoint()
        if (discovered !== null && typeof discovered?.endpoint === 'string') endpoint = discovered.endpoint
      } catch {
        /* discovery failures resurface through connect() below */
      }
    }
    connection = await deps.connect({ discover: true, signal: AbortSignal.timeout(DEFAULT_ATTACH_TIMEOUT_MS) })
    const auv = deps.createAuv(connection)
    const health = await auv.health.check({ signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS) })
    const runner = auv.runner({ runnerClass: RUNNER_CLASS })
    shared.attachError = null
    void pruneCaptures().catch(() => {})
    return adoptTransport(shared, {
      mode: 'attached',
      connection,
      auv,
      runner,
      daemon: null,
      endpoint,
      daemonId: typeof health?.id === 'string' ? health.id : null,
      pid: null,
    })
  } catch (error) {
    if (connection !== null && connection !== undefined) {
      try {
        await connection.close()
      } catch {
        /* ignore */
      }
    }
    shared.attachError = firstLine(messageOf(error))
    return null
  }
}

/** Start the plugin-owned private daemon (no discovery registration). */
async function startOwnedDaemon(shared, deps) {
  const binaryPath = deps.resolveBinary()
  const daemon = await deps.startAuv({
    binaryPath,
    storeRoot: sdkStoreRoot(),
    workingDirectory: os.homedir(),
    environment: { ...process.env },
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  })

  let connection
  try {
    connection = await daemon.connect({ signal: AbortSignal.timeout(DEFAULT_CONNECT_TIMEOUT_MS) })
    const auv = deps.createAuv(connection)
    const health = await auv.health.check({ signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS) })
    if (health?.id !== daemon.id) {
      throw new AuvConfigurationError(
        `AUV SDK health check returned daemon "${health?.id ?? 'unknown'}", expected "${daemon.id}".`,
      )
    }
    const runner = auv.runner({ runnerClass: RUNNER_CLASS })
    void pruneCaptures().catch(() => {})
    return adoptTransport(shared, {
      mode: 'owned',
      connection,
      auv,
      runner,
      daemon,
      endpoint: daemon.connectionOptions?.endpoint ?? null,
      daemonId: daemon.id,
      pid: daemon.pid ?? null,
    })
  } catch (error) {
    try {
      if (connection !== null && connection !== undefined) await connection.close()
    } catch {
      /* ignore */
    }
    try {
      await daemon.stop()
    } catch {
      /* ignore */
    }
    throw error
  }
}

/** Wrap a raw SDK init failure into the tool-facing `AuvError`. */
function wrapInitError(shared, error) {
  if (error instanceof AuvError) {
    if (shared.attachError === null) return error
    return new AuvError(
      `${error.message}\n\nNo running AUV daemon was found to attach to (${shared.attachError}).`,
      { code: error.code },
    )
  }
  const parts = []
  if (error instanceof AuvDaemonStartError) {
    parts.push('The AUV SDK could not start its own `auv serve` daemon and no running daemon was discovered.')
    parts.push(messageOf(error))
    const output = typeof error.output === 'string' ? tail(error.output, 2_000) : ''
    if (output.trim() !== '') parts.push(`Daemon output (tail):\n${output}`)
  } else {
    parts.push(`The AUV SDK transport could not be initialized: ${messageOf(error)}`)
  }
  if (shared.attachError !== null) parts.push(`Attach attempt: ${shared.attachError}`)
  parts.push(
    'Install AUV (or start it with `auv serve`), grant macOS Accessibility/Screen Recording to DeepSeek Harness, then retry. Run auv_doctor for a diagnostic report.',
  )
  const message = parts.join('\n')
  const hint = permissionHint(message)
  return new AuvError(hint === undefined ? message : `${message}\n${hint}`, { code: 'AUV_SDK_INIT_FAILED' })
}

/**
 * Initialize the SDK transport for a state object.
 *
 * Exported for the offline self-check (`tools/check-tools.mjs`) so the
 * attach/owned decision and dispose ownership can be unit-tested with injected
 * `connect`/`startAuv`/`createAuv` implementations.
 *
 * @param {object} shared state created by createSdkTransportState()
 * @param {object} [deps] SDK_DEPENDENCIES-shaped dependency set
 */
export async function initializeSdkTransport(shared, deps = SDK_DEPENDENCIES) {
  shared.attachAttempted = true
  const attached = await tryAttach(shared, deps)
  if (attached !== null) return attached
  try {
    return await startOwnedDaemon(shared, deps)
  } catch (error) {
    throw wrapInitError(shared, error)
  }
}

/**
 * Ensure the SDK transport is initialized and return its facade.
 *
 * Attaches to a discoverable AUV daemon first; starts a plugin-owned daemon only
 * when nothing is reachable. Init failures surface as `AuvError` (with install
 * guidance when AUV is missing); the next call retries.
 *
 * @returns {Promise<object>} facade
 * @throws {AuvError} when neither attach nor the owned daemon can start
 */
export async function ensureSdkTransport() {
  const shared = getState()
  if (shared.closing !== null) {
    try {
      await shared.closing
    } catch {
      /* ignore */
    }
  }
  if (shared.transport !== null) return shared.transport
  if (shared.initPromise === null) {
    shared.initPromise = initializeSdkTransport(shared, SDK_DEPENDENCIES).then(
      (facade) => {
        shared.initPromise = null
        return facade
      },
      (error) => {
        shared.initPromise = null
        const wrapped = error instanceof AuvError ? error : wrapInitError(shared, error)
        shared.lastError = firstLine(wrapped.message)
        throw wrapped
      },
    )
  }
  return await shared.initPromise
}

/** Tool-facing alias: ensure the transport (attach first) and return the facade. */
export async function activeSdkTransport() {
  return await ensureSdkTransport()
}

/** Return the started facade without initializing anything, or null. */
export function sdkTransportIfStarted() {
  const shared = globalThis[STATE_KEY]
  if (shared === undefined) return null
  return shared.transport ?? null
}

/**
 * Tear the transport down: close the connection always; stop the daemon only
 * when this plugin started (owns) it. Idempotent.
 */
export async function disposeSdkTransport() {
  const shared = globalThis[STATE_KEY]
  if (shared === undefined) return
  await disposeTransportState(shared)
}

/** Dispose a specific transport state object. Exported for the offline self-check. */
export async function disposeTransportState(shared) {
  if (shared.closing !== null) {
    try {
      await shared.closing
    } catch {
      /* ignore */
    }
    return
  }
  shared.closing = (async () => {
    if (shared.initPromise !== null) {
      try {
        await shared.initPromise
      } catch {
        /* an init failure has nothing to clean up */
      }
    }
    const connection = shared.connection
    const daemon = shared.mode === 'owned' ? shared.daemon : null
    forgetTransport(shared)
    shared.initPromise = null
    shared.attachAttempted = false
    shared.attachError = null
    shared.lastError = null
    if (connection !== null) {
      try {
        await connection.close()
      } catch {
        /* ignore */
      }
    }
    if (daemon !== null) {
      try {
        await daemon.stop()
      } catch {
        /* ignore */
      }
    }
  })()
  try {
    await shared.closing
  } finally {
    shared.closing = null
  }
}

/**
 * Diagnostic snapshot for `auv_doctor`-style reporting and offline checks.
 *
 * @returns {{started: boolean, mode: 'attached'|'owned'|null, endpoint: string|null,
 *            daemonId: string|null, pid: number|null, attachAttempted: boolean,
 *            attachError: string|null, lastError: string|null,
 *            storeRoot: string, captureRoot: string}}
 */
export function sdkTransportStatus() {
  const shared = globalThis[STATE_KEY]
  return {
    started: shared?.transport != null,
    mode: shared?.mode ?? null,
    endpoint: shared?.endpoint ?? null,
    daemonId: shared?.daemonId ?? null,
    pid: shared?.pid ?? null,
    attachAttempted: shared?.attachAttempted === true,
    attachError: shared?.attachError ?? null,
    lastError: shared?.lastError ?? null,
    storeRoot: sdkStoreRoot(),
    captureRoot: sdkCaptureRoot(),
  }
}

/** Test-only: forget the singleton without touching any daemon. */
export function resetSdkTransportState() {
  delete globalThis[STATE_KEY]
}

// ---------------------------------------------------------------------------
// Capture file handling
// ---------------------------------------------------------------------------

async function writeCaptureFile(image, capture) {
  const directory = sdkCaptureRoot()
  await mkdir(directory, { recursive: true })
  const captureId = typeof capture?.ref?.captureId === 'string' ? capture.ref.captureId.replace(/[^a-zA-Z0-9._-]/gu, '_') : 'capture'
  const filePath = path.join(directory, `${Date.now()}-${captureId}-${randomUUID().slice(0, 8)}.webp`)
  await writeFile(filePath, image.data)
  return filePath
}

function captureArtifactRecord(image, filePath) {
  return {
    purpose: 'auv.driver.capture',
    content_type: 'image/webp',
    file_extension: 'webp',
    byte_length: image.data.byteLength,
    sha256: createHash('sha256').update(image.data).digest('hex'),
    file_path: filePath,
  }
}

/** Best-effort deletion of capture files older than the retention window. */
async function pruneCaptures() {
  const directory = sdkCaptureRoot()
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.endsWith('.webp')) continue
    const filePath = path.join(directory, entry)
    try {
      const info = await stat(filePath)
      if (now - info.mtimeMs > CAPTURE_RETENTION_MS) await unlink(filePath)
    } catch {
      /* ignore individual file races */
    }
  }
}

// ---------------------------------------------------------------------------
// Abort / timeout plumbing (the SDK has no timeout option, only `{ signal }`)
// ---------------------------------------------------------------------------

function combineSignals(first, second) {
  if (first === undefined) return second
  if (second === undefined) return first
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second])
  const controller = new AbortController()
  const onAbort = (event) => controller.abort(event?.target?.reason)
  if (first.aborted || second.aborted) {
    controller.abort(first.aborted ? first.reason : second.reason)
    return controller.signal
  }
  first.addEventListener('abort', onAbort, { once: true })
  second.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

function beginCall(execSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(clampTimeout(timeoutMs))
  return {
    signal: combineSignals(execSignal, timeout),
    timeout,
    timedOut: () => timeout.aborted,
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const RPC_NAME_HINTS = {
  3: { name: 'INVALID_ARGUMENT', code: 'AUV_INVALID_ARGUMENT' },
  5: {
    name: 'NOT_FOUND',
    code: 'AUV_NOT_FOUND',
    hint: 'The window id or capture reference may be stale. Call auv_windows to refresh window ids and retry; AUV capture references expire quickly.',
  },
  7: {
    name: 'PERMISSION_DENIED',
    code: 'AUV_PERMISSION_DENIED',
    hint: 'Run auv_doctor, then grant Accessibility and Screen Recording to DeepSeek Harness in System Settings → Privacy & Security (macOS 27+ merges them under "Device Control and Data Access") and restart the app.',
  },
  9: {
    name: 'FAILED_PRECONDITION',
    code: 'AUV_FAILED_PRECONDITION',
    hint: 'The target window may be minimized or full screen. Restore or focus it first (for example with auv_windows to find a visible window, then auv_activate).',
  },
  10: { name: 'ABORTED', code: 'ABORTED' },
  12: {
    name: 'UNIMPLEMENTED',
    code: 'AUV_UNIMPLEMENTED',
    hint: 'This Runner platform does not implement the operation (for example scrolling without a target window on macOS). Pass window_id instead.',
  },
  13: {
    name: 'INTERNAL',
    code: 'AUV_INTERNAL',
    hint: 'The AUV Runner hit a native failure. For screen text/OCR failures, confirm Screen Recording is granted and restart DeepSeek Harness; auv_doctor reports the permission state.',
  },
  14: {
    name: 'UNAVAILABLE',
    code: 'AUV_UNAVAILABLE',
    hint: 'The AUV daemon may have stopped. The next tool call attaches to a running daemon or starts one again; run auv_doctor if this persists.',
  },
}

function inputProgressHint(error) {
  try {
    const progress = inputActionProgress(error)
    if (progress === undefined || progress === null) return null
    if (progress.case === 'deliveryUncertain') return 'The input was interrupted but may already have been delivered; verify the target state before retrying.'
    if (progress.case === 'submitted') return 'AUV submitted the input but could not verify its effect; verify the target state before retrying.'
    return null
  } catch {
    return null
  }
}

/** Whether an SDK error means the daemon/connection itself is gone. */
function isDeadTransport(error) {
  if (error instanceof AuvTransportError) return true
  if (error instanceof AuvProtocolError) return true
  if (error instanceof AuvRemoteError) return true
  if (error instanceof AuvRpcError) return error.rpcCode === 14
  return false
}

/**
 * Forget a dead client so the next tool call re-attaches or starts a daemon.
 * Only when the transport that failed is still the active one.
 */
function invalidateDeadTransport(context, message) {
  const shared = context.shared
  if (shared.runner !== context.runner) return
  const connection = shared.connection
  const daemon = shared.mode === 'owned' ? shared.daemon : null
  forgetTransport(shared, firstLine(message))
  if (connection !== null) {
    void connection.close().catch(() => {})
  }
  if (daemon !== null) {
    void daemon.stop().catch(() => {})
  }
}

/** Map an SDK error into the tool-facing `AuvError`, dropping dead transports. */
function fail(context, error, operation, call) {
  const mapped = mapSdkError(error, operation, call)
  if (isDeadTransport(error)) invalidateDeadTransport(context, mapped.message)
  return mapped
}

function mapSdkError(error, operation, call) {
  if (error instanceof AuvError) return error
  if (error instanceof AuvAbortError || error?.name === 'AuvAbortError') {
    if (call !== undefined && call.timedOut()) {
      return new AuvError(`AUV ${operation} timed out. The AUV SDK daemon did not finish in time; retry or narrow the request.`, {
        code: 'AUV_TIMEOUT',
      })
    }
    return new AuvError(`AUV ${operation} call was aborted.`, { code: 'ABORTED' })
  }
  if (error instanceof AuvRpcError) {
    const details = RPC_NAME_HINTS[error.rpcCode]
    const name = details?.name ?? 'UNKNOWN'
    const parts = [`AUV ${operation} failed: ${messageOf(error)} (rpc ${error.rpcCode} ${name})`]
    const hint = permissionHint(messageOf(error)) ?? details?.hint
    if (hint !== undefined && hint !== null) parts.push(hint)
    const progressHint = inputProgressHint(error)
    if (progressHint !== null) parts.push(progressHint)
    return new AuvError(parts.join('\n'), { code: details?.code ?? 'AUV_RPC_ERROR' })
  }
  if (
    error instanceof AuvDaemonStartError ||
    error instanceof AuvConfigurationError ||
    error instanceof AuvTransportError ||
    error instanceof AuvProtocolError ||
    error instanceof AuvRemoteError
  ) {
    return new AuvError(`AUV SDK transport error during ${operation}: ${messageOf(error)}`, { code: 'AUV_SDK_ERROR' })
  }
  return new AuvError(`AUV ${operation} failed: ${messageOf(error)}`, { code: 'AUV_SDK_ERROR' })
}

// ---------------------------------------------------------------------------
// Shared SDK operations
// ---------------------------------------------------------------------------

function inputPolicyValue(policy) {
  if (policy === undefined) return undefined
  return INPUT_POLICY_VALUES[policy]
}

const MOUSE_BUTTONS = { left: MouseButton.LEFT, right: MouseButton.RIGHT, middle: MouseButton.MIDDLE }

/** Standard completed tool value, annotated with daemon ownership diagnostics. */
function completedValue(context, commandId, extra = {}) {
  return {
    run_id: null,
    command_id: commandId,
    status: 'completed',
    daemon_mode: context.mode,
    daemon_endpoint: context.endpoint,
    ...extra,
  }
}

async function resolveWindowClient(context, plan, signal) {
  if (plan.windowId !== undefined) return await context.runner.windows.get(plan.windowId, { signal })
  if (plan.applicationId !== undefined) return await context.runner.windows.resolve({ applicationId: plan.applicationId }, { signal })
  return null
}

async function screenshot(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const warnings = []
    let commandId
    let response
    if (plan.windowId !== undefined || plan.applicationId !== undefined) {
      if (plan.applicationId !== undefined) {
        warnings.push("Capturing the application's main visible window; pass window_id to choose a specific window.")
      }
      const client = await resolveWindowClient(context, plan, call.signal)
      response = await client.capture({ resolution: CaptureResolution.LOGICAL, signal: call.signal })
      commandId = 'window.capture'
    } else if (plan.displayId !== undefined) {
      response = await context.runner.displays.capture(displaySelector(plan.displayId), {
        resolution: CaptureResolution.LOGICAL,
        signal: call.signal,
      })
      commandId = 'display.capture'
    } else if (plan.region !== undefined) {
      response = await context.runner.displays.captureRegion(plan.region, undefined, {
        resolution: CaptureResolution.LOGICAL,
        signal: call.signal,
      })
      commandId = 'display.captureRegion'
    } else {
      response = await context.runner.displays.capture(undefined, {
        resolution: CaptureResolution.LOGICAL,
        signal: call.signal,
      })
      commandId = 'display.capture'
    }

    // Fetch pixels in this same call: capture refs are evicted/expired later.
    const image = await context.runner.captures.image(response.capture, {
      encoding: ImageEncoding.WEBP,
      maxSize: { width: CAPTURE_MAX_SIZE, height: CAPTURE_MAX_SIZE },
      signal: call.signal,
    })
    const artifactPath = await writeCaptureFile(image, response.capture)
    const resultCapture = mapCapturedFrame(response.capture)
    if (resultCapture !== null) resultCapture.pixel_dimensions = { height: image.height, width: image.width }
    const result = { capture: resultCapture }
    if (response.window !== undefined && response.window !== null) {
      result.window = mapWindowRow(response.window, response.window.ref?.windowId)
    }
    if (response.display !== undefined && response.display !== null) result.display = mapDisplay(response.display)
    return completedValue(context, commandId, {
      artifact_path: artifactPath,
      content_type: 'image/webp',
      width: image.width,
      height: image.height,
      result,
      artifacts: [captureArtifactRecord(image, artifactPath)],
      warnings,
    })
  } catch (error) {
    throw fail(context, error, 'screenshot', call)
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function ocr(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  const windowed = plan.windowId !== undefined || plan.applicationId !== undefined
  const commandId = windowed ? (plan.wait ? 'window.waitForText' : 'window.findText') : plan.wait ? 'display.waitForText' : 'display.findText'
  try {
    const client = await resolveWindowClient(context, plan, call.signal)
    const findOnce = async () => {
      const options = { signal: call.signal }
      if (client !== null) return await client.findText(plan.text, options)
      return await context.runner.displays.findText(undefined, plan.text, options)
    }
    let response = await findOnce()
    let timedOut = false
    if (plan.wait && response.matches.length === 0) {
      const deadline = Date.now() + (plan.timeoutMs ?? 10_000)
      while (!call.signal.aborted && response.matches.length === 0 && Date.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())), call.signal)
        if (call.signal.aborted) break
        response = await findOnce()
      }
      timedOut = response.matches.length === 0
    }
    const result = { matches: mapTextMatches(response.matches) }
    if (response.capture !== undefined && response.capture !== null) result.capture = mapCapturedFrame(response.capture)
    if (response.display !== undefined && response.display !== null) result.display = mapDisplay(response.display)
    if (response.window !== undefined && response.window !== null) {
      result.window = mapWindowRow(response.window, response.window.ref?.windowId)
    }
    return completedValue(context, commandId, { result, warnings: [], timed_out: timedOut })
  } catch (error) {
    throw fail(context, error, 'ocr', call)
  }
}

async function click(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  const warnings = []
  try {
    if (plan.kind === 'text') {
      const windowed = plan.windowId !== undefined || plan.applicationId !== undefined
      const commandId = windowed ? 'window.clickText' : 'display.clickText'
      const target = formatTargetString(plan)
      if (windowed) {
        const client = await resolveWindowClient(context, plan, call.signal)
        const found = await client.findText(plan.text, { signal: call.signal })
        const matches = mapTextMatches(found.matches)
        if (matches.length === 0) {
          warnings.push(`No visible text matched "${plan.text}"; nothing was clicked.`)
          return completedValue(context, commandId, { target, result: { matches, click: null }, warnings })
        }
        const response = await client.click({ bounds: found.matches[0].bounds }, undefined, { signal: call.signal })
        return completedValue(context, commandId, { target, result: { matches, click: normalizeMessage(response) }, warnings })
      }
      const findOptions = { signal: call.signal }
      if (plan.within !== undefined) {
        findOptions.screenRegion = {
          x: plan.within.left,
          y: plan.within.top,
          width: plan.within.right - plan.within.left,
          height: plan.within.bottom - plan.within.top,
        }
      }
      const found = await context.runner.displays.findText(undefined, plan.text, findOptions)
      const matches = mapTextMatches(found.matches)
      if (matches.length === 0) {
        warnings.push(`No visible text matched "${plan.text}"; nothing was clicked.`)
        return completedValue(context, commandId, { target, result: { matches, click: null }, warnings })
      }
      const response = await context.runner.input.click({ bounds: found.matches[0].bounds }, undefined, { signal: call.signal })
      return completedValue(context, commandId, { target, result: { matches, click: normalizeMessage(response) }, warnings })
    }

    const commandId = 'input.clickPoint'
    const target = formatTargetString(plan)
    const clickOptions = buildClickOptions({
      button: plan.button,
      mouseButton: plan.button === undefined ? undefined : MOUSE_BUTTONS[plan.button],
    })
    let response
    if (plan.windowId !== undefined || plan.applicationId !== undefined) {
      const client = await resolveWindowClient(context, plan, call.signal)
      response = await client.click({ x: plan.x, y: plan.y }, clickOptions, { signal: call.signal })
    } else if (plan.displayId !== undefined) {
      response = await context.runner.input.click(Position.display(plan.displayId, plan.x, plan.y), clickOptions, { signal: call.signal })
    } else {
      response = await context.runner.input.click(Position.screen(plan.x, plan.y), clickOptions, { signal: call.signal })
    }
    return completedValue(context, commandId, { target, result: normalizeMessage(response), warnings })
  } catch (error) {
    throw fail(context, error, 'click', call)
  }
}

function foregroundRecipient() {
  return { recipient: { case: 'foreground', value: true } }
}

function applicationRecipient(applicationId) {
  return { recipient: { case: 'applicationId', value: applicationId } }
}

async function type(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  const commandId = plan.mode === 'paste' ? 'input.pasteText' : 'input.typeText'
  const policy = inputPolicyValue(plan.policy)
  try {
    const client = await resolveWindowClient(context, plan, call.signal)
    let response
    if (client !== null) {
      response =
        plan.mode === 'paste'
          ? await client.pasteText(plan.text, policy === undefined ? {} : { policy }, { signal: call.signal })
          : await client.typeText(plan.text, policy === undefined ? {} : { policy }, { signal: call.signal })
    } else if (plan.applicationId !== undefined) {
      // App-level recipient: one KeyboardInput on the application.
      const action =
        plan.mode === 'paste'
          ? { case: 'pasteText', value: { text: plan.text, policy: policy ?? InputPolicy.FOREGROUND_PREFERRED } }
          : { case: 'typeText', value: { text: plan.text, options: { policy: policy ?? InputPolicy.FOREGROUND_PREFERRED } } }
      response = await context.runner.input.keyboard(
        {
          target: applicationRecipient(plan.applicationId),
          inputs: [{ action }],
          dryRun: false,
        },
        { signal: call.signal },
      )
    } else if (plan.mode === 'paste' && policy === undefined) {
      response = await context.runner.input.pasteText(plan.text, {}, { signal: call.signal })
    } else if (plan.mode === 'paste') {
      response = await context.runner.input.keyboard(
        {
          target: foregroundRecipient(),
          inputs: [{ action: { case: 'pasteText', value: { text: plan.text, policy } } }],
          dryRun: false,
        },
        { signal: call.signal },
      )
    } else {
      response = await context.runner.input.typeText(plan.text, policy === undefined ? {} : { policy }, { signal: call.signal })
    }
    return completedValue(context, commandId, { target: formatTargetString(plan), result: normalizeMessage(response), warnings: [] })
  } catch (error) {
    throw fail(context, error, 'type', call)
  }
}

async function keys(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const client = await resolveWindowClient(context, plan, call.signal)
    let response
    if (client !== null) {
      response = await client.pressKeys(plan.keys, {
        count: plan.repeat !== undefined && plan.repeat > 1 ? plan.repeat : undefined,
        interval: plan.repeat !== undefined && plan.repeat > 1 ? (plan.intervalMs ?? 50) : undefined,
      }, { signal: call.signal })
    } else {
      const request = buildPressKeysRequest({
        keys: plan.keys,
        repeat: plan.repeat,
        intervalMs: plan.intervalMs,
        applicationId: plan.applicationId,
        policy: InputPolicy.FOREGROUND_PREFERRED,
        dryRun: false,
      })
      response = await context.runner.input.pressKeys(request, { signal: call.signal })
    }
    return completedValue(context, 'input.pressKeys', { target: formatTargetString(plan), result: normalizeMessage(response), warnings: [] })
  } catch (error) {
    throw fail(context, error, 'keys', call)
  }
}

async function scroll(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    if (plan.windowId !== undefined) {
      const client = await context.runner.windows.get(plan.windowId, { signal: call.signal })
      let pointX = plan.x
      let pointY = plan.y
      if (pointX === undefined || pointY === undefined) {
        const frame = client.window?.frame
        const width = Number(frame?.width)
        const height = Number(frame?.height)
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new AuvError(`AUV could not read the frame of window "${plan.windowId}"; pass window-local x and y explicitly.`, {
            code: 'AUV_BAD_WINDOW_FRAME',
          })
        }
        if (pointX === undefined) pointX = Math.round(width / 2)
        if (pointY === undefined) pointY = Math.round(height / 2)
      }
      const response = await client.scroll(
        { x: pointX, y: pointY },
        { deltaX: plan.dx ?? 0, deltaY: plan.dy },
        undefined,
        { signal: call.signal },
      )
      return completedValue(context, 'window.scroll', { result: normalizeMessage(response), warnings: [] })
    }

    if (process.platform === 'darwin') {
      throw new Error(
        'macOS cannot scroll at a screen point: AUV\'s input.scrollPoint is available only on Linux and Windows. Pass window_id (and optionally window-local x and y) so the scroll goes through window.scroll.',
      )
    }
    const response = await invokeUnary(context.connection, {
      service: 'auv.api.driver.v1.InputService',
      method: 'ScrollPoint',
      input: InputService.method.scrollPoint.input,
      output: InputService.method.scrollPoint.output,
      request: { position: Position.screen(plan.x, plan.y), scroll: { deltaX: plan.dx ?? 0, deltaY: plan.dy } },
      runnerClass: RUNNER_CLASS,
      signal: call.signal,
    })
    return completedValue(context, 'input.scrollPoint', { result: normalizeMessage(response), warnings: [] })
  } catch (error) {
    throw fail(context, error, 'scroll', call)
  }
}

async function windows(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const clients = await context.runner.windows.list({
      excludeMinimized: !plan.includeMinimized,
      excludeOtherDesktops: !plan.includeOtherDesktops,
      signal: call.signal,
    })
    return completedValue(context, 'window.list', {
      windows: clients.map((client) => mapWindowRow(client.window, client.id)),
      warnings: [],
    })
  } catch (error) {
    throw fail(context, error, 'windows', call)
  }
}

async function activate(context, plan, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const response = await context.runner.applications.activate({ applicationId: plan.applicationId }, { signal: call.signal })
    const warnings = []
    const warning = activationWarning(response)
    if (warning !== null) warnings.push(warning)
    return completedValue(context, 'application.activate', {
      target: `app:${plan.applicationId}`,
      result: mapActivateResult(response),
      warnings,
    })
  } catch (error) {
    throw fail(context, error, 'activate', call)
  }
}

/**
 * SDK-backed `auv_doctor`: platform, daemon ownership/endpoint/health, and the
 * macOS permission probe. Never throws: probe failures become report fields.
 */
async function doctor(context, exec, timeoutMs) {
  const call = beginCall(exec?.signal, timeoutMs)
  const report = {
    platform: process.platform,
    daemon: {
      mode: context.mode,
      endpoint: context.endpoint,
      daemon_id: context.daemonId,
      pid: context.pid,
      health: 'unknown',
    },
    permissions_checked: false,
    accessibility: null,
    screen_recording: null,
    screen_capture_kit: null,
    automation: null,
    all_ok: false,
    recommendation: null,
    error: null,
    warnings: [],
  }
  try {
    const health = await context.auv.health.check({ signal: call.signal })
    report.daemon.health = typeof health?.status === 'string' ? health.status : 'unknown'
    if (process.platform !== 'darwin') {
      report.all_ok = true
      report.warnings.push('Permission checks are macOS-only; the AUV daemon is reachable on this platform.')
      return report
    }
    const probe = await context.runner.macos.permissions.probe({ signal: call.signal })
    const permissions = summarizePermissions(probe)
    if (permissions === null) {
      report.error = 'AUV returned no permission status.'
      report.recommendation = PERMISSION_RECOMMENDATION
      return report
    }
    report.permissions_checked = true
    report.accessibility = permissions.accessibility
    report.screen_recording = permissions.screen_recording
    report.screen_capture_kit = permissions.screen_capture_kit
    report.automation = permissions.automation
    report.all_ok = permissionsAllOk(permissions)
    if (!report.all_ok) report.recommendation = PERMISSION_RECOMMENDATION
    if (permissions.automation === 'missing') {
      report.warnings.push('Automation to System Events is missing; some apps may refuse AppleScript activation.')
    }
    return report
  } catch (error) {
    report.error = mapSdkError(error, 'doctor', call).message
    report.recommendation = permissionHint(report.error) ?? PERMISSION_RECOMMENDATION
    report.warnings.push('The permission probe failed; grant macOS permissions to DeepSeek Harness and retry.')
    return report
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

function createFacade(shared) {
  const context = {
    shared,
    mode: shared.mode,
    connection: shared.connection,
    auv: shared.auv,
    runner: shared.runner,
    endpoint: shared.endpoint,
    daemonId: shared.daemonId,
    pid: shared.pid,
  }
  return {
    kind: 'sdk',
    mode: context.mode,
    debug() {
      return { mode: context.mode, daemonId: context.daemonId, pid: context.pid, endpoint: context.endpoint }
    },
    screenshot: (plan, exec, timeoutMs) => screenshot(context, plan, exec, timeoutMs),
    ocr: (plan, exec, timeoutMs) => ocr(context, plan, exec, timeoutMs),
    click: (plan, exec, timeoutMs) => click(context, plan, exec, timeoutMs),
    type: (plan, exec, timeoutMs) => type(context, plan, exec, timeoutMs),
    keys: (plan, exec, timeoutMs) => keys(context, plan, exec, timeoutMs),
    scroll: (plan, exec, timeoutMs) => scroll(context, plan, exec, timeoutMs),
    windows: (plan, exec, timeoutMs) => windows(context, plan, exec, timeoutMs),
    activate: (plan, exec, timeoutMs) => activate(context, plan, exec, timeoutMs),
    doctor: (exec, timeoutMs) => doctor(context, exec, timeoutMs),
  }
}
