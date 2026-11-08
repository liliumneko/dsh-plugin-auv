/**
 * Pure argument planning and value normalization for the SDK transport.
 *
 * This module is deliberately free of `@auv-js/sdk` imports and side effects so
 * the offline self-check (`tools/check-tools.mjs`) can unit-test the mapping
 * without starting a daemon. `src/transport/sdk.mjs` imports it and performs
 * the actual RPCs.
 *
 * The input planners run in the tool bodies *before* the transport is started,
 * so malformed requests never attach to or spawn a daemon. The mappers convert
 * protobuf-style shapes (`MessageShape`, camelCase, `$typeName`) into the plain
 * snake_case JSON shapes the tool renderers understand.
 */

import { isPlainObject } from 'es-toolkit'

// ---------------------------------------------------------------------------
// Small helpers (mirrors of the helpers in src/tools.mjs)
// ---------------------------------------------------------------------------

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function optionalString(args, key) {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function requiredString(args, key, label = key) {
  const value = optionalString(args, key)
  if (value === undefined) throw new Error(`Missing required parameter "${label}".`)
  return value
}

function optionalNumber(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Parameter "${key}" must be a finite number.`)
  return number
}

function optionalInteger(args, key) {
  const number = optionalNumber(args, key)
  if (number === undefined) return undefined
  if (!Number.isInteger(number)) throw new Error(`Parameter "${key}" must be an integer.`)
  return number
}

function optionalEnum(args, key, allowed) {
  const value = optionalString(args, key)
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw new Error(`Parameter "${key}" must be one of ${allowed.map((entry) => `"${entry}"`).join(', ')}.`)
  return value
}

function optionalObject(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw new Error(`Parameter "${key}" must be an object.`)
  return value
}

function optionalRegion(args) {
  const region = optionalObject(args, 'region')
  if (region === undefined) return undefined
  const values = {}
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(region[key])
    if (!Number.isFinite(value)) throw new Error(`region.${key} must be a finite number.`)
    values[key] = value
  }
  if (values.width <= 0 || values.height <= 0) throw new Error('region.width and region.height must be greater than zero.')
  return values
}

function optionalFence(args) {
  const within = optionalObject(args, 'within')
  if (within === undefined) return undefined
  const values = {}
  for (const key of ['left', 'top', 'right', 'bottom']) {
    const value = Number(within[key])
    if (!Number.isFinite(value)) throw new Error(`within.${key} must be a finite number.`)
    values[key] = value
  }
  return values
}

// ---------------------------------------------------------------------------
// Input planners (one per SDK-routed tool)
// ---------------------------------------------------------------------------

/** Plan `auv_screenshot`; mirrors the CLI body's target exclusivity checks. */
export function parseScreenshotArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  const displayId = optionalString(args, 'display_id')
  const region = optionalRegion(args)
  const selected = [windowId, applicationId, displayId, region === undefined ? undefined : 'region'].filter((entry) => entry !== undefined)
  if (selected.length > 1) {
    throw new Error('Pass only one of window_id, application_id, display_id, or region to auv_screenshot.')
  }
  if (displayId !== undefined && region !== undefined) {
    throw new Error('Pass either display_id or region to auv_screenshot, not both.')
  }
  return { windowId, applicationId, displayId, region }
}

/** Plan `auv_ocr` (findText / polled waitForText). */
export function parseOcrArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const text = requiredString(args, 'text')
  const wait = args.wait === true
  const timeoutMs = optionalInteger(args, 'timeout_ms')
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  if (timeoutMs !== undefined && !wait) throw new Error('timeout_ms is only valid with wait: true.')
  if (timeoutMs !== undefined && (timeoutMs < 100 || timeoutMs > 120_000)) {
    throw new Error('timeout_ms must be between 100 and 120000.')
  }
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error('Pass only one of window_id or application_id to auv_ocr.')
  }
  return { text, wait, timeoutMs, windowId, applicationId }
}

/**
 * Plan `auv_click`.
 *
 * @returns {{kind: 'text', text: string, windowId?: string, applicationId?: string, within?: object}
 *          | {kind: 'point', x: number, y: number, windowId?: string, applicationId?: string, displayId?: string, button?: string}}
 */
export function parseClickArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const text = optionalString(args, 'text')
  const x = optionalNumber(args, 'x')
  const y = optionalNumber(args, 'y')
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  const displayId = optionalString(args, 'display_id')
  const button = optionalEnum(args, 'button', ['left', 'right', 'middle'])
  const within = optionalFence(args)
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error('Pass only one of window_id or application_id to auv_click.')
  }

  if (text !== undefined) {
    if (x !== undefined || y !== undefined) throw new Error('Pass either "text" or both "x" and "y" to auv_click, not both forms.')
    if (button !== undefined && button !== 'left') throw new Error('button applies only to x/y clicks; OCR text clicks use the left button.')
    if (displayId !== undefined) throw new Error('display_id cannot be used with OCR text clicks. Omit it, or pass x and y for a display click.')
    if (within !== undefined && (windowId !== undefined || applicationId !== undefined)) {
      throw new Error('within is only supported for screen-wide OCR clicks; omit window_id and application_id when using within.')
    }
    return { kind: 'text', text, windowId, applicationId, within }
  }

  if (x === undefined || y === undefined) {
    throw new Error('auv_click requires either "text" or both "x" and "y".')
  }
  if (within !== undefined) throw new Error('within applies only to OCR text clicks; omit it for x/y clicks.')
  if (displayId !== undefined && windowId !== undefined) throw new Error('Pass only one of window_id or display_id to auv_click.')
  return { kind: 'point', x, y, windowId, applicationId, displayId, button }
}

/** Plan `auv_type`. */
export function parseTypeArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const text = requiredString(args, 'text')
  const mode = optionalEnum(args, 'mode', ['type', 'paste']) ?? 'type'
  const policy = optionalEnum(args, 'policy', ['background-only', 'background-preferred', 'foreground-preferred'])
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error('Pass only one of window_id or application_id to auv_type.')
  }
  return { text, mode, policy, windowId, applicationId }
}

/** Plan `auv_keys`. */
export function parseKeysArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const rawKeys = args.keys
  const keys = Array.isArray(rawKeys) ? rawKeys.filter((key) => typeof key === 'string' && key !== '') : []
  if (keys.length === 0) throw new Error('auv_keys requires "keys" as a non-empty array of key names, for example ["ctrl","l"].')
  const repeat = optionalInteger(args, 'repeat')
  if (repeat !== undefined && (repeat < 1 || repeat > 255)) throw new Error('repeat must be between 1 and 255.')
  const intervalMs = optionalInteger(args, 'interval_ms')
  if (intervalMs !== undefined && intervalMs < 1) throw new Error('interval_ms must be a positive integer.')
  if (repeat === undefined || repeat <= 1) {
    if (intervalMs !== undefined) throw new Error('interval_ms is only valid with repeat greater than 1.')
  }
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error('Pass only one of window_id or application_id to auv_keys.')
  }
  return { keys, repeat, intervalMs, windowId, applicationId }
}

/** Plan `auv_scroll`. The macOS screen-point rejection happens in the SDK op. */
export function parseScrollArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const dy = optionalNumber(args, 'dy')
  if (dy === undefined) throw new Error('auv_scroll requires "dy", the vertical delta in logical pixels (positive scrolls down).')
  const dx = optionalNumber(args, 'dx')
  const windowId = optionalString(args, 'window_id')
  const x = optionalNumber(args, 'x')
  const y = optionalNumber(args, 'y')
  if (windowId === undefined && (x === undefined || y === undefined)) {
    throw new Error('auv_scroll requires "window_id", or both "x" and "y" screen coordinates. On macOS AUV cannot scroll at a raw screen point, so prefer window_id.')
  }
  if (windowId !== undefined && (x === undefined) !== (y === undefined)) {
    throw new Error('Pass both window-local x and y, or neither (the window center is used).')
  }
  return { dy, dx, windowId, x, y }
}

/** Plan `auv_windows`. */
export function parseWindowsArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  return {
    includeMinimized: args.include_minimized === true,
    includeOtherDesktops: args.include_other_desktops === true,
  }
}

/** Plan `auv_activate`. */
export function parseActivateArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  return { applicationId: requiredString(args, 'application_id') }
}

// ---------------------------------------------------------------------------
// Value normalization (protobuf MessageShape -> CLI-receipt-like JSON)
// ---------------------------------------------------------------------------

/** camelCase -> snake_case for protobuf field names. */
export function snakeCase(key) {
  return String(key).replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
}

/**
 * Recursively normalize a protobuf `MessageShape` into plain JSON: drop
 * `$typeName`, snake_case keys, expand Uint8Array to a byte length, stringify
 * bigint values.
 */
export function normalizeMessage(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return { byte_length: value.byteLength }
  if (Array.isArray(value)) return value.map(normalizeMessage)
  if (typeof value !== 'object') return value
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$typeName') continue
    output[snakeCase(key)] = normalizeMessage(entry)
  }
  return output
}

/** A `ScreenRect`-like object -> `{origin:{x,y}, size:{width,height}}` (CLI receipt shape). */
export function mapRect(rect) {
  if (rect === null || rect === undefined || typeof rect !== 'object') return null
  const x = Number(rect.x)
  const y = Number(rect.y)
  const width = Number(rect.width)
  const height = Number(rect.height)
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null
  return { origin: { x, y }, size: { width, height } }
}

/** Map one SDK `Window` + its id to the CLI `window.list` row shape. */
export function mapWindowRow(window, id) {
  const source = window !== null && typeof window === 'object' ? window : {}
  const state = source.state !== null && typeof source.state === 'object' ? source.state : {}
  const desktop = state.desktop !== null && typeof state.desktop === 'object' ? state.desktop : null
  return {
    app_name: typeof source.applicationName === 'string' && source.applicationName !== '' ? source.applicationName : null,
    application_id: typeof source.applicationId === 'string' && source.applicationId !== '' ? source.applicationId : null,
    coordinate_space: 'screen',
    frame: mapRect(source.frame),
    is_main: source.isMain === true,
    is_visible: source.isVisible === true,
    process_id: Number.isFinite(Number(source.processId)) ? Number(source.processId) : null,
    reference: { id: typeof id === 'string' && id !== '' ? id : String(source.ref?.windowId ?? '') },
    state: {
      desktop: desktop === null ? null : typeof desktop.id === 'string' && desktop.id !== '' ? desktop.id : null,
      is_always_on_top: state.isAlwaysOnTop === true,
      is_focused: state.isFocused === true,
      is_fullscreen: state.isFullscreen === true,
      is_maximized: state.isMaximized === true,
      is_minimized: state.isMinimized === true,
      is_visible: state.isVisible === true,
      stack_index: Number.isFinite(Number(state.stackIndex)) ? Number(state.stackIndex) : null,
    },
    title: typeof source.title === 'string' && source.title !== '' ? source.title : null,
  }
}

/** Map an SDK `Display` to the CLI `display.list`/`display.capture` shape. */
export function mapDisplay(display) {
  if (display === null || display === undefined || typeof display !== 'object') return null
  return {
    coordinate_space: 'screen',
    frame: mapRect(display.frame),
    id: typeof display.displayId === 'string' ? display.displayId : String(display.displayId ?? ''),
    is_builtin: display.builtin === true,
    is_primary: display.primary === true,
    name: typeof display.name === 'string' && display.name !== '' ? display.name : null,
    scale_factor: Number(display.scaleFactor),
  }
}

/** Map a `CapturedFrame` to the CLI `result.capture` shape (pixel dimensions from the frame when present). */
export function mapCapturedFrame(capture) {
  if (capture === null || capture === undefined || typeof capture !== 'object') return null
  const pixelSize = capture.pixelSize !== null && typeof capture.pixelSize === 'object' ? capture.pixelSize : null
  const pixelWidth = Number(pixelSize?.width)
  const pixelHeight = Number(pixelSize?.height)
  return {
    backend: typeof capture.backend === 'string' ? capture.backend : null,
    bounds: mapRect(capture.bounds),
    fallback_reason: typeof capture.fallbackReason === 'string' && capture.fallbackReason !== '' ? capture.fallbackReason : null,
    pixel_dimensions:
      Number.isFinite(pixelWidth) && Number.isFinite(pixelHeight) && pixelWidth > 0 && pixelHeight > 0
        ? { width: pixelWidth, height: pixelHeight }
        : null,
    scale_factor: Number(capture.scaleFactor),
  }
}

/** Map an SDK `TextMatch` to the CLI `matches[]` shape. */
export function mapTextMatch(match) {
  if (match === null || match === undefined || typeof match !== 'object') return null
  return {
    bounds: mapRect(match.bounds),
    confidence: Number.isFinite(Number(match.confidence)) ? Number(match.confidence) : null,
    text: typeof match.text === 'string' ? match.text : String(match.text ?? ''),
  }
}

/** Map an SDK list of `TextMatch` values. */
export function mapTextMatches(matches) {
  return Array.isArray(matches) ? matches.map(mapTextMatch).filter((match) => match !== null) : []
}

const APPLICATION_ID_KINDS = ['unspecified', 'bundle_id', 'process_name', 'desktop_app_id']
const APPLICATION_ACTIVATION_METHODS = ['unspecified', 'apple_script_activate', 'foreground_window']

function enumName(names, value) {
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 && index < names.length ? names[index] : null
}

/** Map `ActivateApplicationResponse` to a CLI-like `result`. */
export function mapActivateResult(response) {
  if (response === null || response === undefined || typeof response !== 'object') return null
  const normalized = normalizeMessage(response)
  normalized.application_id_kind = enumName(APPLICATION_ID_KINDS, response.applicationIdKind)
  normalized.method = enumName(APPLICATION_ACTIVATION_METHODS, response.method)
  const verification = response.verification
  const oneof = verification !== null && typeof verification === 'object' ? verification.verification : null
  if (oneof !== null && typeof oneof === 'object' && typeof oneof.case === 'string') {
    if (oneof.case === 'verifiedForeground') {
      normalized.verification = { status: 'verified_foreground', observed_application_id: oneof.value?.observedApplicationId ?? null }
    } else if (oneof.case === 'foregroundMismatch') {
      normalized.verification = { status: 'foreground_mismatch', observed_application_id: oneof.value?.observedApplicationId ?? null }
    } else if (oneof.case === 'unavailable') {
      normalized.verification = { status: 'unavailable', reason: oneof.value?.reason ?? null }
    } else {
      normalized.verification = null
    }
  } else {
    normalized.verification = null
  }
  return normalized
}

/** Warning text when activation could not be verified, or null. */
export function activationWarning(response) {
  const oneof = response?.verification?.verification
  if (oneof === null || typeof oneof !== 'object') return null
  if (oneof.case === 'foregroundMismatch') {
    const observed = oneof.value?.observedApplicationId
    return `AUV could not bring the application to the front${typeof observed === 'string' && observed !== '' ? ` (${observed} is frontmost instead)` : ''}; check auv_doctor permissions.`
  }
  return null
}

/** Build AUV's `PressKeysRequest` init object for one key combination. */
export function buildPressKeysRequest({ keys, repeat, intervalMs, applicationId, policy, dryRun = false }) {
  const options = { keys: [...keys] }
  if (repeat !== undefined && repeat > 1) {
    options.count = repeat
    options.interval = intervalMs ?? 50
  }
  const request = {
    options,
    policy,
    dryRun,
  }
  if (applicationId !== undefined) {
    request.target = { recipient: { case: 'applicationId', value: applicationId } }
  } else {
    request.target = { recipient: { case: 'foreground', value: true } }
  }
  return request
}

/** Build the `ClickOptions` init object for an x/y click. */
export function buildClickOptions({ button, mouseButton }) {
  if (button === undefined || button === 'left') return undefined
  return { button: mouseButton }
}

/** A display id -> the `DisplaySelector` init object SDK calls take. */
export function displaySelector(displayId) {
  return { selector: { case: 'display', value: { displayId } } }
}

/** Format the CLI-style target string used for tool output. */
export function formatTargetString({ windowId, applicationId, displayId }) {
  if (typeof windowId === 'string' && windowId !== '') return `window:${windowId}`
  if (typeof applicationId === 'string' && applicationId !== '') return `app:${applicationId}`
  if (typeof displayId === 'string' && displayId !== '') return `display:${displayId}`
  return null
}

/** Map the public policy names to AUV `InputPolicy` numeric values (see sdk.mjs). */
export const INPUT_POLICY_VALUES = {
  'background-only': 1,
  'background-preferred': 2,
  'foreground-preferred': 3,
}

// ---------------------------------------------------------------------------
// Diagnostics helpers (permission probe -> plain doctor fields)
// ---------------------------------------------------------------------------

/**
 * AUV `PermissionStatus` enum values
 * (`PERMISSION_STATUS_UNSPECIFIED/GRANTED/MISSING/UNKNOWN` = 0/1/2/3).
 */
export const PERMISSION_STATUS_NAMES = ['unknown', 'granted', 'missing', 'unknown']

/** AUV `PermissionStatus` numeric value -> plain name. */
export function permissionStatusName(value) {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0 || index >= PERMISSION_STATUS_NAMES.length) return 'unknown'
  return PERMISSION_STATUS_NAMES[index]
}

/**
 * `runner.macos.permissions.probe()` response -> plain doctor permission fields.
 *
 * @param {object|null|undefined} probe
 * @returns {{accessibility: string, screen_recording: string, screen_capture_kit: string, automation: string}|null}
 */
export function summarizePermissions(probe) {
  if (probe === null || probe === undefined || typeof probe !== 'object') return null
  return {
    accessibility: permissionStatusName(probe.accessibility),
    screen_recording: permissionStatusName(probe.screenRecording),
    screen_capture_kit: permissionStatusName(probe.screenCaptureKit),
    automation: permissionStatusName(probe.automationToSystemEvents),
  }
}

/**
 * Whether the probed permissions are enough for the typed tools.
 *
 * Screen text/capture needs Screen Recording (and ScreenCaptureKit when the
 * backend reports it); clicks/typing/keys need Accessibility. Automation to
 * System Events is optional (some activation paths fall back without it).
 */
export function permissionsAllOk(permissions) {
  if (permissions === null || permissions === undefined) return false
  return (
    permissions.accessibility === 'granted' &&
    permissions.screen_recording === 'granted' &&
    permissions.screen_capture_kit !== 'missing'
  )
}

/** Plain recommendation shown when a macOS permission is missing. */
export const PERMISSION_RECOMMENDATION =
  'Open System Settings → Privacy & Security, enable DeepSeek Harness (macOS 27+ merges the permission list into "Device Control and Data Access"; older macOS shows Accessibility and Screen Recording as separate items), restart DeepSeek Harness, then run auv_doctor again.'
