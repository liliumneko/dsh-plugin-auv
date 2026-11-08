/**
 * `@auv-js/sdk` transport for @local/dsh-auv.
 *
 * One app-owned `auv serve` daemon (started lazily on the first typed tool
 * call), one `AuvConnection`, and one typed `RunnerClient` serve every SDK
 * tool call. The daemon publishes no discovery descriptor and uses a
 * launcher-token socket, so it never interferes with the user's own
 * `auv serve` / CLI daemon; `--exit-on-stdin-close` makes it follow the Host
 * down even if dispose never runs.
 *
 * The singleton lives on `globalThis` (symbol key) so a DSH plugin reload can
 * reuse it instead of leaking a daemon; `disposeSdkTransport()` closes the
 * connection and stops the child, and is idempotent.
 *
 * `AUV_DSH_TRANSPORT` (see ./config.mjs) selects the behaviour:
 *   - `cli`: this module never starts a daemon (`activeSdkTransport()` → null).
 *   - `sdk`: daemon startup errors are surfaced to the tool call.
 *   - `auto` (default): one failed startup logs a warning and permanently falls
 *     back to the CLI for this process.
 *
 * `auv_doctor` and `auv_invoke` stay CLI tools by design (the SDK has no
 * doctor report and no generic argv entry point); when this transport owns a
 * daemon they route that CLI child at the same daemon with `AUV_ENDPOINT` +
 * `--credential-stdin`, otherwise the plain CLI path is used.
 */

import { spawn } from 'node:child_process'
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
  createAuv,
  inputActionProgress,
  invokeUnary,
  startAuv,
} from '@auv-js/sdk/node'

import {
  AuvError,
  childEnvironment,
  clampTimeout,
  defaultStoreRoot,
  permissionHint,
  resolveAuvBinary,
  runAuv,
  runAuvDoctor,
} from '../auv.mjs'
import { resolveTransportConfig } from './config.mjs'
import {
  INPUT_POLICY_VALUES,
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
  parseActivateArgs,
  parseClickArgs,
  parseKeysArgs,
  parseOcrArgs,
  parseScreenshotArgs,
  parseScrollArgs,
  parseTypeArgs,
  parseWindowsArgs,
} from './sdk-format.mjs'

// ---------------------------------------------------------------------------
// Paths / environment
// ---------------------------------------------------------------------------

const CAPTURE_MAX_SIZE = 2048
const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000
const CLI_STDERR_TAIL = 4_000
const CLI_STDOUT_TAIL = 2_000

function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh')
}

/** Daemon store root: AUV_DSH_SDK_STORE_ROOT, else <DSH data>/auv/sdk. */
export function sdkStoreRoot() {
  const override = (process.env.AUV_DSH_SDK_STORE_ROOT ?? '').trim()
  return override !== '' ? override : path.join(dshHome(), 'auv', 'sdk')
}

/** Capture artifact directory: AUV_DSH_CAPTURE_DIR, else <DSH data>/auv/sdk-captures. */
export function sdkCaptureRoot() {
  const override = (process.env.AUV_DSH_CAPTURE_DIR ?? '').trim()
  return override !== '' ? override : path.join(dshHome(), 'auv', 'sdk-captures')
}

function tail(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`
}

// ---------------------------------------------------------------------------
// Global singleton state (HMR-safe)
// ---------------------------------------------------------------------------

const STATE_KEY = Symbol.for('@local/dsh-auv/sdk-transport.v1')

function createState() {
  return {
    daemon: null,
    connection: null,
    auv: null,
    runner: null,
    transport: null,
    initPromise: null,
    closing: null,
    fallback: false,
    failed: null,
    warningShown: false,
    configWarningShown: false,
  }
}

function getState() {
  if (globalThis[STATE_KEY] === undefined) globalThis[STATE_KEY] = createState()
  return globalThis[STATE_KEY]
}

// ---------------------------------------------------------------------------
// Init / dispose
// ---------------------------------------------------------------------------

function wrapInitError(error) {
  if (error instanceof AuvError) return error
  const parts = []
  if (error instanceof AuvDaemonStartError) {
    parts.push('The AUV SDK could not start its own `auv serve` daemon.')
    parts.push(messageOf(error))
    const output = typeof error.output === 'string' ? tail(error.output, 2_000) : ''
    if (output.trim() !== '') parts.push(`Daemon output (tail):\n${output}`)
  } else {
    parts.push(`The AUV SDK transport could not be initialized: ${messageOf(error)}`)
  }
  parts.push(
    'Check that AUV works (`auv --version`), grant macOS Accessibility/Screen Recording to DeepSeek Harness, and retry. Set AUV_DSH_TRANSPORT=cli to use the auv CLI transport instead.',
  )
  const message = parts.join('\n')
  const hint = permissionHint(message)
  return new AuvError(hint === undefined ? message : `${message}\n${hint}`, { code: 'AUV_SDK_INIT_FAILED' })
}

async function initSdkTransport(shared) {
  const binaryPath = resolveAuvBinary()
  const storeRoot = sdkStoreRoot()
  const daemon = await startAuv({
    binaryPath,
    storeRoot,
    workingDirectory: os.homedir(),
    environment: { ...process.env },
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  })

  let connection
  try {
    connection = await daemon.connect({ signal: AbortSignal.timeout(DEFAULT_CONNECT_TIMEOUT_MS) })
    const auv = createAuv(connection)
    const health = await auv.health.check({ signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS) })
    if (health?.id !== daemon.id) {
      throw new AuvConfigurationError(
        `AUV SDK health check returned daemon "${health?.id ?? 'unknown'}", expected "${daemon.id}".`,
      )
    }
    const runner = auv.runner({ runnerClass: 'auv.core.local' })
    shared.daemon = daemon
    shared.connection = connection
    shared.auv = auv
    shared.runner = runner
    shared.failed = null
    shared.fallback = false

    // Drop the client if the daemon dies; the next call starts a fresh one.
    const drop = () => {
      if (shared.daemon !== daemon) return
      shared.daemon = null
      shared.connection = null
      shared.auv = null
      shared.runner = null
      shared.transport = null
    }
    daemon.exited.then(drop, drop)

    // Captures are transient; trim stale ones in the background.
    void pruneCaptures().catch(() => {})

    return createFacade(daemon, connection, auv, runner)
  } catch (error) {
    try {
      if (connection !== undefined) await connection.close()
    } catch {
      /* ignore */
    }
    try {
      await daemon.stop()
    } catch {
      /* ignore */
    }
    throw wrapInitError(error)
  }
}

function warnFallback(error) {
  const shared = getState()
  if (shared.warningShown) return
  shared.warningShown = true
  const firstLine = messageOf(error).split('\n')[0]
  console.warn(
    `[dsh-auv] @auv-js/sdk transport unavailable (${firstLine}). Falling back to the auv CLI for this process; set AUV_DSH_TRANSPORT=sdk to require the SDK or =cli to silence this.`,
  )
}

/**
 * Ensure the SDK transport is initialized and return its facade.
 *
 * @returns {Promise<object|null>} facade, or null when the CLI path must be used
 * @throws {AuvError} in `AUV_DSH_TRANSPORT=sdk` mode when initialization fails
 */
export async function activeSdkTransport() {
  const config = resolveTransportConfig()
  if (config.mode === 'cli') return null
  const shared = getState()

  if (config.warning !== null && !shared.configWarningShown) {
    shared.configWarningShown = true
    console.warn(`[dsh-auv] ${config.warning}`)
  }
  if (shared.closing !== null) {
    try {
      await shared.closing
    } catch {
      /* ignore */
    }
  }
  if (shared.transport !== null) {
    if (shared.fallback) return null
    return shared.transport
  }
  if (shared.failed !== null) {
    if (config.mode === 'sdk') throw shared.failed
    return null
  }
  if (shared.fallback) return null

  if (shared.initPromise === null) {
    const mode = config.mode
    shared.initPromise = initSdkTransport(shared)
      .then((transport) => {
        shared.transport = transport
        return transport
      })
      .catch((error) => {
        const wrapped = wrapInitError(error)
        shared.initPromise = null
        if (mode === 'sdk') {
          shared.failed = wrapped
          throw wrapped
        }
        shared.fallback = true
        shared.failed = wrapped
        warnFallback(wrapped)
        return null
      })
  }
  return await shared.initPromise
}

/** Return the started SDK facade without initializing anything, or null. */
export function sdkTransportIfStarted() {
  const shared = globalThis[STATE_KEY]
  if (shared === undefined) return null
  return shared.transport ?? null
}

/** Crash/reload-safe teardown: close the connection and stop the owned daemon. */
export async function disposeSdkTransport() {
  const shared = globalThis[STATE_KEY]
  if (shared === undefined) return
  if (shared.closing !== null) {
    try {
      await shared.closing
    } catch {
      /* ignore */
    }
    return
  }
  shared.closing = (async () => {
    const pending = shared.initPromise
    if (pending !== null) {
      try {
        await pending
      } catch {
        /* an init failure has nothing to clean up */
      }
    }
    const daemon = shared.daemon
    const connection = shared.connection
    shared.daemon = null
    shared.connection = null
    shared.auv = null
    shared.runner = null
    shared.transport = null
    shared.initPromise = null
    shared.failed = null
    shared.fallback = false
    shared.warningShown = false
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
 * @returns {{mode: 'auto'|'sdk'|'cli', started: boolean, daemonId: string|null, pid: number|null,
 *            endpoint: string|null, storeRoot: string, captureRoot: string, fallback: boolean,
 *            failed: boolean, error: string|null}}
 */
export function sdkTransportStatus() {
  const config = resolveTransportConfig()
  const shared = globalThis[STATE_KEY]
  const daemon = shared?.daemon ?? null
  return {
    mode: config.mode,
    started: shared?.transport != null,
    daemonId: daemon?.id ?? null,
    pid: daemon?.pid ?? null,
    endpoint: daemon?.connectionOptions?.endpoint ?? null,
    storeRoot: sdkStoreRoot(),
    captureRoot: sdkCaptureRoot(),
    fallback: shared?.fallback === true,
    failed: shared?.failed != null,
    error: shared?.failed != null ? messageOf(shared.failed).split('\n')[0] : null,
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
    hint: 'The target window may be minimized or full screen. Restore it first (auv_invoke window.setState, or auv_activate).',
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
    hint: 'The AUV SDK daemon may have stopped; the next tool call starts a fresh one. Run auv_doctor if this persists.',
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

/** Map an SDK error into the tool-facing `AuvError` (same shape as CLI errors). */
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

function completedValue(commandId, extra = {}) {
  return { run_id: null, command_id: commandId, status: 'completed', ...extra }
}

async function resolveWindowClient(runner, plan, signal) {
  if (plan.windowId !== undefined) return await runner.windows.get(plan.windowId, { signal })
  if (plan.applicationId !== undefined) return await runner.windows.resolve({ applicationId: plan.applicationId }, { signal })
  return null
}

async function screenshot(context, rawArgs, exec, timeoutMs) {
  const plan = parseScreenshotArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const warnings = []
    let commandId
    let response
    if (plan.windowId !== undefined || plan.applicationId !== undefined) {
      if (plan.applicationId !== undefined) {
        warnings.push("Capturing the application's main visible window; pass window_id to choose a specific window.")
      }
      const client = await resolveWindowClient(context.runner, plan, call.signal)
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
    return completedValue(commandId, {
      artifact_path: artifactPath,
      content_type: 'image/webp',
      width: image.width,
      height: image.height,
      result,
      artifacts: [captureArtifactRecord(image, artifactPath)],
      warnings,
    })
  } catch (error) {
    throw mapSdkError(error, 'screenshot', call)
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

async function ocr(context, rawArgs, exec, timeoutMs) {
  const plan = parseOcrArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  const windowed = plan.windowId !== undefined || plan.applicationId !== undefined
  const commandId = windowed ? (plan.wait ? 'window.waitForText' : 'window.findText') : plan.wait ? 'display.waitForText' : 'display.findText'
  try {
    const client = await resolveWindowClient(context.runner, plan, call.signal)
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
    return completedValue(commandId, { result, warnings: [], timed_out: timedOut })
  } catch (error) {
    throw mapSdkError(error, 'ocr', call)
  }
}

async function click(context, rawArgs, exec, timeoutMs) {
  const plan = parseClickArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  const warnings = []
  try {
    if (plan.kind === 'text') {
      const windowed = plan.windowId !== undefined || plan.applicationId !== undefined
      const commandId = windowed ? 'window.clickText' : 'display.clickText'
      const target = formatTargetString(plan)
      if (windowed) {
        const client = await resolveWindowClient(context.runner, plan, call.signal)
        const found = await client.findText(plan.text, { signal: call.signal })
        const matches = mapTextMatches(found.matches)
        if (matches.length === 0) {
          warnings.push(`No visible text matched "${plan.text}"; nothing was clicked.`)
          return completedValue(commandId, { target, result: { matches, click: null }, warnings })
        }
        const response = await client.click({ bounds: found.matches[0].bounds }, undefined, { signal: call.signal })
        return completedValue(commandId, { target, result: { matches, click: normalizeMessage(response) }, warnings })
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
        return completedValue(commandId, { target, result: { matches, click: null }, warnings })
      }
      const response = await context.runner.input.click({ bounds: found.matches[0].bounds }, undefined, { signal: call.signal })
      return completedValue(commandId, { target, result: { matches, click: normalizeMessage(response) }, warnings })
    }

    const commandId = 'input.clickPoint'
    const target = formatTargetString(plan)
    const clickOptions = buildClickOptions({
      button: plan.button,
      mouseButton: plan.button === undefined ? undefined : MOUSE_BUTTONS[plan.button],
    })
    let response
    if (plan.windowId !== undefined || plan.applicationId !== undefined) {
      const client = await resolveWindowClient(context.runner, plan, call.signal)
      response = await client.click({ x: plan.x, y: plan.y }, clickOptions, { signal: call.signal })
    } else if (plan.displayId !== undefined) {
      response = await context.runner.input.click(Position.display(plan.displayId, plan.x, plan.y), clickOptions, { signal: call.signal })
    } else {
      response = await context.runner.input.click(Position.screen(plan.x, plan.y), clickOptions, { signal: call.signal })
    }
    return completedValue(commandId, { target, result: normalizeMessage(response), warnings })
  } catch (error) {
    throw mapSdkError(error, 'click', call)
  }
}

function foregroundRecipient() {
  return { recipient: { case: 'foreground', value: true } }
}

function applicationRecipient(applicationId) {
  return { recipient: { case: 'applicationId', value: applicationId } }
}

async function type(context, rawArgs, exec, timeoutMs) {
  const plan = parseTypeArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  const commandId = plan.mode === 'paste' ? 'input.pasteText' : 'input.typeText'
  const policy = inputPolicyValue(plan.policy)
  try {
    const client = await resolveWindowClient(context.runner, plan, call.signal)
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
    return completedValue(commandId, { target: formatTargetString(plan), result: normalizeMessage(response), warnings: [] })
  } catch (error) {
    throw mapSdkError(error, 'type', call)
  }
}

async function keys(context, rawArgs, exec, timeoutMs) {
  const plan = parseKeysArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const client = await resolveWindowClient(context.runner, plan, call.signal)
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
    return completedValue('input.pressKeys', { target: formatTargetString(plan), result: normalizeMessage(response), warnings: [] })
  } catch (error) {
    throw mapSdkError(error, 'keys', call)
  }
}

async function scroll(context, rawArgs, exec, timeoutMs) {
  const plan = parseScrollArgs(rawArgs)
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
      return completedValue('window.scroll', { result: normalizeMessage(response), warnings: [] })
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
      runnerClass: 'auv.core.local',
      signal: call.signal,
    })
    return completedValue('input.scrollPoint', { result: normalizeMessage(response), warnings: [] })
  } catch (error) {
    throw mapSdkError(error, 'scroll', call)
  }
}

async function windows(context, rawArgs, exec, timeoutMs) {
  const plan = parseWindowsArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const clients = await context.runner.windows.list({
      excludeMinimized: !plan.includeMinimized,
      excludeOtherDesktops: !plan.includeOtherDesktops,
      signal: call.signal,
    })
    return completedValue('window.list', {
      windows: clients.map((client) => mapWindowRow(client.window, client.id)),
      warnings: [],
    })
  } catch (error) {
    throw mapSdkError(error, 'windows', call)
  }
}

async function activate(context, rawArgs, exec, timeoutMs) {
  const plan = parseActivateArgs(rawArgs)
  const call = beginCall(exec?.signal, timeoutMs)
  try {
    const response = await context.runner.applications.activate({ applicationId: plan.applicationId }, { signal: call.signal })
    const warnings = []
    const warning = activationWarning(response)
    if (warning !== null) warnings.push(warning)
    return completedValue('application.activate', {
      target: `app:${plan.applicationId}`,
      result: mapActivateResult(response),
      warnings,
    })
  } catch (error) {
    throw mapSdkError(error, 'activate', call)
  }
}

// ---------------------------------------------------------------------------
// CLI child process routed at the owned daemon (auv_doctor / auv_invoke)
// ---------------------------------------------------------------------------

function receiptFailure(receipt) {
  const details = receipt?.failure_details ?? {}
  const summary = typeof receipt?.failure === 'string' && receipt.failure !== '' ? receipt.failure : (typeof details.message === 'string' ? details.message : 'unknown failure')
  const code = typeof details.code === 'string' ? details.code : 'AUV_COMMAND_FAILED'
  let message = `AUV command "${receipt?.command_id ?? 'unknown'}" failed: ${summary} (${code})`
  if (typeof details.message === 'string' && details.message !== '' && details.message !== summary) message += `\n${details.message}`
  const hint = permissionHint(`${summary}\n${details.message ?? ''}`)
  if (hint !== undefined) message += `\n${hint}`
  return new AuvError(message, { code, receipt })
}

/**
 * Spawn the auv CLI talking to this transport's daemon.
 *
 * The launcher token goes on stdin (`--credential-stdin`), never into argv or
 * the environment; `AUV_ENDPOINT` selects our private socket.
 */
function spawnOwnedDaemonCli(context, { args, signal, timeoutMs }) {
  const credential = context.daemon.connectionOptions?.credential
  const endpoint = context.daemon.connectionOptions?.endpoint
  const binary = resolveAuvBinary()
  const effectiveTimeout = clampTimeout(timeoutMs)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...childEnvironment(), AUV_ENDPOINT: String(endpoint) },
        windowsHide: true,
      })
    } catch (error) {
      reject(new AuvError(`Failed to start AUV (${binary}): ${messageOf(error)}`, { code: 'AUV_SPAWN_ERROR' }))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (handler, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      handler(value)
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
    }
    const onAbort = () => {
      kill()
      finish(reject, new AuvError('AUV call was aborted.', { code: 'ABORTED' }))
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr = tail(`${stderr}${chunk}`, CLI_STDERR_TAIL)
    })
    child.stdin.on('error', () => {
      /* the CLI may close stdin before we finish writing */
    })
    child.on('error', (error) => {
      finish(reject, new AuvError(`Failed to run AUV (${binary}): ${messageOf(error)}. Install AUV or set AUV_BIN.`, { code: 'AUV_SPAWN_ERROR', stderr }))
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      const text = stdout.trim()
      if (text !== '') {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
          if (typeof parsed.status === 'string' && parsed.status === 'failed') {
            finish(reject, receiptFailure(parsed))
            return
          }
          finish(resolve, parsed)
          return
        }
      }
      const stderrTail = tail(stderr, CLI_STDERR_TAIL)
      const stdoutTail = tail(stdout, CLI_STDOUT_TAIL)
      let message = `AUV exited with code ${code ?? 'unknown'}${signalName === null || signalName === undefined ? '' : ` (signal ${signalName})`}`
      if (stderrTail !== '') message += `\nstderr: ${stderrTail}`
      if (stdoutTail !== '') message += `\nstdout: ${stdoutTail}`
      const hint = permissionHint(`${stderrTail}\n${stdoutTail}`)
      if (hint !== undefined) message += `\n${hint}`
      finish(reject, new AuvError(message, { code: 'AUV_CLI_ERROR', stderr, stdout }))
    })
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      kill()
      finish(reject, new AuvError(`AUV timed out after ${effectiveTimeout} ms.`, { code: 'AUV_TIMEOUT', stderr }))
    }, effectiveTimeout)

    try {
      child.stdin.write(`${credential ?? ''}\n`)
      child.stdin.end()
    } catch {
      /* handled by the close/error paths */
    }
  })
}

function isCliConnectionFailure(error) {
  if (!(error instanceof AuvError)) return false
  if (error.code === 'AUV_SPAWN_ERROR') return true
  if (error.code !== 'AUV_CLI_ERROR') return false
  const text = `${error.message ?? ''}\n${error.stderr ?? ''}`
  return /connect|connection|daemon|socket|unavailable|transport|credential|UNAVAILABLE|deadline exceeded/i.test(text)
}

function buildInvokeArgs(options) {
  const { commandId, argv = [], target, dryRun = false, storeRoot = defaultStoreRoot() } = options
  const args = ['--credential-stdin', 'invoke', commandId]
  if (typeof storeRoot === 'string' && storeRoot !== '') args.push('--store-root', storeRoot)
  if (typeof target === 'string' && target !== '') args.push('--target', target)
  if (dryRun) args.push('--dry-run')
  args.push('--no-overlay', '--json', ...argv.map((entry) => String(entry)))
  return args
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

function createFacade(daemon, connection, auv, runner) {
  const context = { daemon, connection, auv, runner }
  return {
    kind: 'sdk',
    debug() {
      return { daemonId: daemon.id, pid: daemon.pid, endpoint: daemon.connectionOptions?.endpoint ?? null }
    },
    screenshot: (rawArgs, exec, timeoutMs) => screenshot(context, rawArgs, exec, timeoutMs),
    ocr: (rawArgs, exec, timeoutMs) => ocr(context, rawArgs, exec, timeoutMs),
    click: (rawArgs, exec, timeoutMs) => click(context, rawArgs, exec, timeoutMs),
    type: (rawArgs, exec, timeoutMs) => type(context, rawArgs, exec, timeoutMs),
    keys: (rawArgs, exec, timeoutMs) => keys(context, rawArgs, exec, timeoutMs),
    scroll: (rawArgs, exec, timeoutMs) => scroll(context, rawArgs, exec, timeoutMs),
    windows: (rawArgs, exec, timeoutMs) => windows(context, rawArgs, exec, timeoutMs),
    activate: (rawArgs, exec, timeoutMs) => activate(context, rawArgs, exec, timeoutMs),
    runInvokeCli: async (options) =>
      await spawnOwnedDaemonCli(context, {
        args: buildInvokeArgs(options),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
    runDoctorCli: async (options = {}) =>
      await spawnOwnedDaemonCli(context, {
        args: ['--credential-stdin', 'doctor', '--json'],
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
  }
}

// ---------------------------------------------------------------------------
// CLI-tool fallbacks (auv_doctor / auv_invoke stay CLI tools)
// ---------------------------------------------------------------------------

/**
 * Run an `auv invoke` receipt, preferring the SDK-owned daemon when one is
 * active. Falls back to an independent CLI child when no daemon is running, or
 * when the routed child cannot reach the daemon (connection-level failures).
 */
export async function runAuvWithSdkFallback(options) {
  const started = sdkTransportIfStarted()
  if (started !== null) {
    try {
      return await started.runInvokeCli(options)
    } catch (error) {
      if (!isCliConnectionFailure(error)) throw error
      console.warn(`[dsh-auv] CLI could not reach the SDK daemon; retrying with an independent auv CLI: ${messageOf(error).split('\n')[0]}`)
      return await runAuv(options)
    }
  }
  if (resolveTransportConfig().mode === 'sdk') {
    const transport = await activeSdkTransport()
    if (transport !== null) return await transport.runInvokeCli(options)
  }
  return await runAuv(options)
}

/**
 * Run `auv doctor --json`. The doctor report is CLI-only; it is routed at the
 * SDK-owned daemon only when one is already running (it never forces startup,
 * so it keeps working when the daemon cannot start at all).
 */
export async function runAuvDoctorWithSdkFallback(options = {}) {
  const started = sdkTransportIfStarted()
  if (started !== null) {
    try {
      return await started.runDoctorCli(options)
    } catch (error) {
      if (!isCliConnectionFailure(error)) throw error
      console.warn(`[dsh-auv] doctor could not reach the SDK daemon; retrying with an independent auv CLI: ${messageOf(error).split('\n')[0]}`)
      return await runAuvDoctor(options)
    }
  }
  return await runAuvDoctor(options)
}
