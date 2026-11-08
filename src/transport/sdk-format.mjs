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
// Shared literals for the 0.2.0 tools
// ---------------------------------------------------------------------------

/** Delivery policies accepted by `auv_keys` (mirrors AUV `InputPolicy`). */
export const KEY_POLICIES = ['background-only', 'background-preferred', 'foreground-preferred']

/** Coordinate spaces accepted by `auv_drag`. */
export const DRAG_SPACES = ['screen', 'window', 'display']

/** Mouse buttons accepted by `auv_drag` / `auv_click` x/y clicks. */
export const MOUSE_BUTTONS = ['left', 'right', 'middle']

/** AUV `MouseButton` numeric values, used to build SDK requests. */
export const MOUSE_BUTTON_VALUES = Object.freeze({ left: 1, right: 2, middle: 3 })

/** `auv_drag` defaults/limits. */
export const DEFAULT_DRAG_DURATION_MS = 300
export const MAX_DRAG_DURATION_MS = 30_000

/** `auv_wait_for_change` defaults/limits. */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000
export const MIN_WAIT_TIMEOUT_MS = 100
export const MAX_WAIT_TIMEOUT_MS = 120_000
export const DEFAULT_WAIT_INTERVAL_MS = 200
export const MIN_WAIT_INTERVAL_MS = 50
export const MAX_WAIT_INTERVAL_MS = 5_000

/** Pixel-ratio comparison defaults for `auv_wait_for_change`. */
export const DEFAULT_MIN_CHANGED_RATIO = 0.01
export const DEFAULT_PIXEL_THRESHOLD = 24

/** `auv_capture_state`: downscaled RGBA snapshots kept in memory. */
export const CAPTURE_STATE_MAX_SIZE = 320
export const CAPTURE_STATE_MAX_ENTRIES = 20
export const CAPTURE_STATE_TTL_MS = 5 * 60 * 1000

/** Coordinate spaces accepted by `auv_click` x/y clicks. */
export const CLICK_SPACES = ['screen', 'window', 'display']

/** Repeat guard tuning: the Nth identical mutation inside the window is blocked. */
export const REPEAT_GUARD_LIMIT = 3
export const REPEAT_GUARD_WINDOW_MS = 30_000

/** Returned as `message` when the repeat guard blocks a mutating call. */
export const REPEAT_GUARD_MESSAGE =
  'Same call repeated without a change; take a new screenshot and re-locate before trying again. Pass allow_repeat:true to send it anyway.'

/**
 * Shown in screenshot/OCR values: how to turn screen points into image pixels
 * and window points.
 */
export const COORDINATE_NOTE =
  'All points are logical screen points. image_pixel = (screen_point - bounds.origin) * pixel_ratio, where pixel_ratio = pixel_size.width / bounds.size.width (equal to scale_factor for LOGICAL captures); window_point = screen_point - window.frame.origin.'


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

function optionalBoundedNumber(args, key, fallback, minimum, maximum) {
  const number = optionalNumber(args, key)
  if (number === undefined) return fallback
  if (number < minimum || number > maximum) throw new Error(`Parameter "${key}" must be between ${minimum} and ${maximum}.`)
  return number
}

function optionalBoundedInteger(args, key, fallback, minimum, maximum) {
  const number = optionalInteger(args, key)
  if (number === undefined) return fallback
  if (number < minimum || number > maximum) throw new Error(`Parameter "${key}" must be between ${minimum} and ${maximum}.`)
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

function optionalPoint(args, key) {
  const point = optionalObject(args, key)
  if (point === undefined) return undefined
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${key}.x and ${key}.y must be finite numbers.`)
  return { x, y }
}

function requiredPoint(args, key) {
  const point = optionalPoint(args, key)
  if (point === undefined) throw new Error(`Missing required parameter "${key}" (an object with x and y).`)
  return point
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
 * For x/y clicks `space` selects how the point is interpreted:
 * `window` (window-local; the default when a window or application target is
 * given), `screen` (logical screen coordinates; the default otherwise) or
 * `display` (display-local; requires display_id). Unity/Canvas callers should
 * prefer `space: 'screen'` because window-targeted clicks are often ignored.
 *
 * @returns {{kind: 'text', text: string, windowId?: string, applicationId?: string, within?: object}
 *          | {kind: 'point', x: number, y: number, space: 'screen'|'window'|'display',
 *              windowId?: string, applicationId?: string, displayId?: string, button?: string}}
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
  const requestedSpace = optionalEnum(args, 'space', CLICK_SPACES)
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error('Pass only one of window_id or application_id to auv_click.')
  }

  if (text !== undefined) {
    if (x !== undefined || y !== undefined) throw new Error('Pass either "text" or both "x" and "y" to auv_click, not both forms.')
    if (button !== undefined && button !== 'left') throw new Error('button applies only to x/y clicks; OCR text clicks use the left button.')
    if (displayId !== undefined) throw new Error('display_id cannot be used with OCR text clicks. Omit it, or pass x and y for a display click.')
    if (requestedSpace !== undefined) throw new Error('space applies only to x/y clicks; OCR text clicks use the matched bounds.')
    if (within !== undefined && (windowId !== undefined || applicationId !== undefined)) {
      throw new Error('within is only supported for screen-wide OCR clicks; omit window_id and application_id when using within.')
    }
    return { kind: 'text', text, windowId, applicationId, within, allowRepeat: args.allow_repeat === true }
  }

  if (x === undefined || y === undefined) {
    throw new Error('auv_click requires either "text" or both "x" and "y".')
  }
  if (within !== undefined) throw new Error('within applies only to OCR text clicks; omit it for x/y clicks.')
  if (displayId !== undefined && windowId !== undefined) throw new Error('Pass only one of window_id or display_id to auv_click.')
  const space = requestedSpace ?? (windowId !== undefined || applicationId !== undefined ? 'window' : 'screen')
  if (space === 'window' && windowId === undefined && applicationId === undefined) {
    throw new Error('space: "window" requires window_id or application_id so AUV can interpret x/y in window coordinates.')
  }
  if (space === 'display' && displayId === undefined) {
    throw new Error('space: "display" requires display_id so AUV can interpret x/y in display coordinates.')
  }
  if (space === 'display' && (windowId !== undefined || applicationId !== undefined)) {
    throw new Error('Pass either a window/application target or display_id with space: "display", not both.')
  }
  if (space === 'window' && displayId !== undefined) {
    throw new Error('display_id is not valid with space: "window"; pass space: "display" for display-local points.')
  }
  return {
    kind: 'point',
    x,
    y,
    space,
    windowId,
    applicationId,
    displayId,
    button,
    allowRepeat: args.allow_repeat === true,
  }
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
  return { text, mode, policy, windowId, applicationId, allowRepeat: args.allow_repeat === true }
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
  const policy = optionalEnum(args, 'policy', KEY_POLICIES)
  const targeted = windowId !== undefined || applicationId !== undefined
  if (args.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('Parameter "focus" must be a boolean.')
  const focus = args.focus === undefined ? targeted : args.focus
  if (focus && !targeted) throw new Error('focus: true requires a window_id or application_id target; omit focus to press keys into the foreground app.')
  if (policy !== undefined && policy !== 'foreground-preferred' && !targeted) {
    throw new Error(`policy "${policy}" requires a window_id or application_id target; omit policy to deliver keys to the foreground app.`)
  }
  return {
    keys,
    repeat,
    intervalMs,
    windowId,
    applicationId,
    policy,
    focus,
    allowRepeat: args.allow_repeat === true,
  }
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
  return { dy, dx, windowId, x, y, allowRepeat: args.allow_repeat === true }
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

/**
 * Plan `auv_drag`.
 *
 * `space` defaults to the target that was given: `window` for a window/app
 * target, `display` for display_id, `screen` otherwise.
 * @returns {{from: object, to: object, space: 'screen'|'window'|'display',
 *            windowId?: string, applicationId?: string, displayId?: string,
 *            button: 'left'|'right'|'middle', durationMs: number,
 *            activate: boolean, allowRepeat: boolean}}
 */
export function parseDragArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const from = requiredPoint(args, 'from')
  const to = requiredPoint(args, 'to')
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  const displayId = optionalString(args, 'display_id')
  const button = optionalEnum(args, 'button', MOUSE_BUTTONS) ?? 'left'
  const durationMs = optionalInteger(args, 'duration_ms') ?? DEFAULT_DRAG_DURATION_MS
  if (durationMs < 0 || durationMs > MAX_DRAG_DURATION_MS) {
    throw new Error(`duration_ms must be between 0 and ${MAX_DRAG_DURATION_MS}.`)
  }
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error('Pass only one of window_id or application_id to auv_drag.')
  }
  if ((windowId !== undefined || applicationId !== undefined) && displayId !== undefined) {
    throw new Error('Pass either a window/application target or display_id to auv_drag, not both.')
  }
  const targeted = windowId !== undefined || applicationId !== undefined
  const inferredSpace = targeted ? 'window' : displayId !== undefined ? 'display' : 'screen'
  const space = optionalEnum(args, 'space', DRAG_SPACES) ?? inferredSpace
  if (space === 'window' && !targeted) {
    throw new Error('space: "window" requires window_id or application_id so AUV can convert window-local points to screen points.')
  }
  if (space === 'display' && displayId === undefined) {
    throw new Error('space: "display" requires display_id so AUV can convert display-local points to screen points.')
  }
  if (space !== 'display' && displayId !== undefined) {
    throw new Error('display_id is only valid with space: "display" (or omit space and let it be inferred); pass a window target for window-space drags.')
  }
  if (args.activate !== undefined && typeof args.activate !== 'boolean') throw new Error('Parameter "activate" must be a boolean.')
  const activate = args.activate === undefined ? targeted : args.activate
  return { from, to, space, windowId, applicationId, displayId, button, durationMs, activate, allowRepeat: args.allow_repeat === true }
}

/**
 * Validate the target part shared by `auv_wait_for_change` and
 * `auv_capture_state`.
 */
function parseCaptureTargetArgs(rawArgs, toolName) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const windowId = optionalString(args, 'window_id')
  const applicationId = optionalString(args, 'application_id')
  const displayId = optionalString(args, 'display_id')
  const region = optionalRegion(args)
  if (windowId !== undefined && applicationId !== undefined) {
    throw new Error(`Pass only one of window_id or application_id to ${toolName}.`)
  }
  if (displayId !== undefined && (windowId !== undefined || applicationId !== undefined)) {
    throw new Error(`Pass either a window/application target or display_id to ${toolName}, not both.`)
  }
  if (region !== undefined && (windowId !== undefined || applicationId !== undefined)) {
    throw new Error(`region is only supported for screen/display targets; omit window_id and application_id when using region in ${toolName}.`)
  }
  return { windowId, applicationId, displayId, region }
}

/** Plan `auv_capture_state` (target only; the frame is stored in memory). */
export function parseCaptureStateArgs(rawArgs) {
  return parseCaptureTargetArgs(rawArgs, 'auv_capture_state')
}

/**
 * Plan `auv_wait_for_change`.
 *
 * Baseline resolution order: `state_token` (pixels from `auv_capture_state`),
 * then `baseline_hash` (legacy ThumbHash comparison only), then a fresh
 * baseline capture with pixel comparison.
 *
 * @returns {{windowId?: string, applicationId?: string, displayId?: string,
 *            region?: {x:number,y:number,width:number,height:number},
 *            timeoutMs: number, intervalMs: number, stateToken?: string,
 *            baselineHash?: string, minChangedRatio: number, pixelThreshold: number}}
 */
export function parseWaitForChangeArgs(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {}
  const target = parseCaptureTargetArgs(args, 'auv_wait_for_change')
  const timeoutMs = optionalInteger(args, 'timeout_ms') ?? DEFAULT_WAIT_TIMEOUT_MS
  if (timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be between ${MIN_WAIT_TIMEOUT_MS} and ${MAX_WAIT_TIMEOUT_MS}.`)
  }
  const intervalMs = optionalInteger(args, 'interval_ms') ?? DEFAULT_WAIT_INTERVAL_MS
  if (intervalMs < MIN_WAIT_INTERVAL_MS || intervalMs > MAX_WAIT_INTERVAL_MS) {
    throw new Error(`interval_ms must be between ${MIN_WAIT_INTERVAL_MS} and ${MAX_WAIT_INTERVAL_MS}.`)
  }
  const stateToken = optionalString(args, 'state_token')
  const baselineHash = optionalString(args, 'baseline_hash')
  if (baselineHash !== undefined && !/^(thumbhash|sha256):[0-9a-f]+$/i.test(baselineHash)) {
    throw new Error('baseline_hash must look like "thumbhash:<hex>" or "sha256:<hex>", copied from an earlier before_hash/after_hash.')
  }
  const minChangedRatio = optionalBoundedNumber(args, 'min_changed_ratio', DEFAULT_MIN_CHANGED_RATIO, 0, 1)
  const pixelThreshold = optionalBoundedInteger(args, 'pixel_threshold', DEFAULT_PIXEL_THRESHOLD, 0, 255)
  return { ...target, timeoutMs, intervalMs, stateToken, baselineHash, minChangedRatio, pixelThreshold }
}

/** A plain target description stored alongside a capture-state snapshot. */
export function captureTargetPlan(plan = {}) {
  return {
    windowId: plan.windowId ?? plan.window_id,
    applicationId: plan.applicationId ?? plan.application_id,
    displayId: plan.displayId ?? plan.display_id,
    region:
      plan.region === undefined
        ? undefined
        : { x: plan.region.x, y: plan.region.y, width: plan.region.width, height: plan.region.height },
  }
}

/** Stable string identity for a capture target, for diagnostics/LRU keys. */
export function captureTargetKey(plan = {}) {
  const target = captureTargetPlan(plan)
  if (target.windowId !== undefined) return `window:${target.windowId}`
  if (target.applicationId !== undefined) return `app:${target.applicationId}`
  if (target.region !== undefined) {
    const region = `${target.region.x},${target.region.y},${target.region.width},${target.region.height}`
    return target.displayId === undefined ? `region:${region}` : `region:${region}:display:${target.displayId}`
  }
  if (target.displayId !== undefined) return `display:${target.displayId}`
  return 'screen'
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
// 0.2.0 pure helpers: coordinate conversion, drag, wait-for-change,
// keys policy/focus planning, and the repeat guard.
//
// These are side-effect free so tools/check-tools.mjs can verify them without
// a daemon, a transport, or any real input.
// ---------------------------------------------------------------------------

/** A `{x,y}`-like value -> `{x,y}` when both coordinates are finite, else null. */
export function normalizePoint(value) {
  if (value === null || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/** Top-left of a flat `{x,y,width,height}` rect or a mapped `{origin,size}` rect. */
export function rectOrigin(rect) {
  if (rect === null || typeof rect !== 'object') return null
  const source = rect.origin !== null && typeof rect.origin === 'object' ? rect.origin : rect
  const x = Number(source.x)
  const y = Number(source.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/** Size of a flat `{x,y,width,height}` rect or a mapped `{origin,size}` rect. */
export function rectSize(rect) {
  if (rect === null || typeof rect !== 'object') return null
  const source = rect.size !== null && typeof rect.size === 'object' ? rect.size : rect
  const width = Number(source.width)
  const height = Number(source.height)
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null
}

/** Either rect shape -> flat `{x,y,width,height}`, or null. */
export function flatRect(rect) {
  const origin = rectOrigin(rect)
  const size = rectSize(rect)
  if (origin === null || size === null) return null
  return { x: origin.x, y: origin.y, width: size.width, height: size.height }
}

/** Center of either rect shape (logical screen points), or null. */
export function rectCenter(rect) {
  const flat = flatRect(rect)
  if (flat === null) return null
  return { x: flat.x + flat.width / 2, y: flat.y + flat.height / 2 }
}

/** Window-local point + window frame origin -> logical screen point. */
export function screenPointFromWindowPoint(point, windowFrame) {
  const origin = rectOrigin(windowFrame)
  if (origin === null) return null
  return { x: origin.x + point.x, y: origin.y + point.y }
}

/** Logical screen point - window frame origin -> window-local point. */
export function windowPointFromScreenPoint(point, windowFrame) {
  const origin = rectOrigin(windowFrame)
  if (origin === null) return null
  return { x: point.x - origin.x, y: point.y - origin.y }
}

/** Display-local point + display frame origin -> logical screen point. */
export const screenPointFromDisplayPoint = screenPointFromWindowPoint
/** Logical screen point - display frame origin -> display-local point. */
export const displayPointFromScreenPoint = windowPointFromScreenPoint

/**
 * Pixels per logical point for a capture: `pixel_size.width / bounds.width`
 * when both are known, otherwise the reported `scale_factor`; null otherwise.
 */
export function capturePixelRatio(capture) {
  if (capture === null || typeof capture !== 'object') return null
  const bounds = flatRect(capture.bounds)
  const pixel = capture.pixelSize ?? capture.pixel_size ?? capture.pixel_dimensions ?? null
  const pixelWidth = Number(pixel?.width)
  if (bounds !== null && Number.isFinite(pixelWidth) && pixelWidth > 0 && bounds.width > 0) {
    return pixelWidth / bounds.width
  }
  const scale = Number(capture.scaleFactor ?? capture.scale_factor)
  return Number.isFinite(scale) && scale > 0 ? scale : null
}

/** Screen point -> center in the captured image's pixel space (see COORDINATE_NOTE). */
export function imagePixelFromScreenPoint(screenPoint, capture) {
  const bounds = flatRect(capture?.bounds)
  const ratio = capturePixelRatio(capture)
  if (bounds === null || ratio === null) return null
  return { x: (screenPoint.x - bounds.x) * ratio, y: (screenPoint.y - bounds.y) * ratio }
}

/**
 * Add coordinate fields to mapped OCR matches while keeping `bounds` and the
 * other existing fields: `screen_point` (bounds center), `image_pixel` (center
 * in captured pixel space), `window_point` (when a window target is used),
 * `scale_factor`, and `pixel_ratio`.
 */
export function enrichTextMatches(matches, capture, windowFrame) {
  if (!Array.isArray(matches)) return []
  const ratio = capturePixelRatio(capture)
  const scale = Number(capture?.scaleFactor ?? capture?.scale_factor)
  return matches.map((match) => {
    const center = rectCenter(match?.bounds)
    return {
      ...match,
      screen_point: center,
      image_pixel: center === null ? null : imagePixelFromScreenPoint(center, capture),
      window_point: center === null || windowFrame === null || windowFrame === undefined ? null : windowPointFromScreenPoint(center, windowFrame),
      scale_factor: Number.isFinite(scale) ? scale : null,
      pixel_ratio: ratio,
    }
  })
}

/**
 * Build the AUV `MoveMouseRequest` init the CLI uses for a straight-line drag:
 * start at the source point, then one cubic Bézier segment from screen
 * `{dx/3, dy/3}` / `{2dx/3, 2dy/3}` to `{dx, dy}`.
 */
export function buildDragMovement({ startScreen, endScreen, durationMs = DEFAULT_DRAG_DURATION_MS }) {
  const dx = endScreen.x - startScreen.x
  const dy = endScreen.y - startScreen.y
  return {
    start: { source: { case: 'point', value: { x: startScreen.x, y: startScreen.y } } },
    curve: {
      start: { x: 0, y: 0 },
      segments: [
        {
          control1: { x: dx / 3, y: dy / 3 },
          control2: { x: (dx * 2) / 3, y: (dy * 2) / 3 },
          end: { x: dx, y: dy },
        },
      ],
    },
    mapping: { width: 1, height: 1 },
    options: { duration: durationMs, sampleRateHz: 60, curveTolerance: 0.5 },
  }
}

/** Default keys delivery policy when the caller omits `policy`. */
export const DEFAULT_KEYS_POLICY = 'foreground-preferred'

/**
 * Decide whether `auv_keys` focuses first and which policy to use.
 * @returns {{targeted: boolean, effectivePolicy: string, focus: boolean, focusTarget: 'window'|'application'|null}}
 */
export function planKeysDelivery(plan = {}) {
  const targeted = plan.windowId !== undefined || plan.applicationId !== undefined
  const effectivePolicy = plan.policy ?? DEFAULT_KEYS_POLICY
  const focus = targeted && plan.focus === true
  const focusTarget = focus ? (plan.windowId !== undefined ? 'window' : 'application') : null
  // Unity/canvas apps often ignore window-recipient key events. When the caller
  // asks for foreground delivery, activate the target and send a real
  // foreground key event instead of a window-targeted one.
  const deliveryVia = effectivePolicy === 'foreground-preferred' ? 'foreground' : targeted ? 'window' : 'foreground'
  return { targeted, effectivePolicy, focus, focusTarget, deliveryVia }
}

// --- auv_wait_for_change ----------------------------------------------------

/** Lowercase hex of a `Uint8Array`/byte view; '' when not byte-like. */
export function bytesToHex(bytes) {
  if (bytes === null || bytes === undefined) return ''
  let data
  if (bytes instanceof Uint8Array) data = bytes
  else if (ArrayBuffer.isView(bytes)) data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  else return ''
  let hex = ''
  for (const byte of data) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** `thumbhash:<hex>` when the capture carries a ThumbHash, else null. */
export function thumbhashOf(capture) {
  const hex = bytesToHex(capture?.thumbhash)
  return hex === '' ? null : `thumbhash:${hex}`
}

/** Abortable sleep used between frame captures. */
export function sleep(ms, signal) {
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

/**
 * Poll a target until a comparison reports a change, `timeoutMs` runs out, or
 * the signal aborts.
 *
 * `captureSnapshot` returns any comparable value (a pixel snapshot object or a
 * hash string) and `compare(before, after)` returns
 * `{ changed: boolean, ratio?: number, dimensionMismatch?: boolean }`. Pass
 * `baseline` to compare against an earlier snapshot instead of capturing a
 * fresh baseline at call start.
 *
 * Returns `result: 'changed'|'timeout'|'no_effect'`: `changed` when a later
 * snapshot reported a change, `timeout` when the deadline was reached first,
 * `no_effect` when the passed signal aborted before the deadline without a
 * change. `changedRatio` is the last comparison ratio.
 *
 * `now` and `sleep` are injectable so the offline self-check can use a fake
 * clock and a fake capture sequence.
 */
export async function pollForChange({
  captureSnapshot,
  compare,
  intervalMs = DEFAULT_WAIT_INTERVAL_MS,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  baseline,
  signal,
  now = Date.now,
  sleep: sleepImpl = sleep,
}) {
  const started = now()
  let before = baseline === undefined ? await captureSnapshot() : baseline
  let after = before
  let lastComparison = { changed: false, ratio: 0 }
  let result = 'timeout'
  for (;;) {
    if (signal?.aborted === true) {
      result = 'no_effect'
      break
    }
    const elapsed = now() - started
    if (elapsed >= timeoutMs) {
      result = 'timeout'
      break
    }
    await sleepImpl(Math.min(intervalMs, timeoutMs - elapsed), signal)
    if (signal?.aborted === true) {
      result = 'no_effect'
      break
    }
    after = await captureSnapshot()
    lastComparison = compare(before, after)
    if (lastComparison.changed === true) {
      result = 'changed'
      break
    }
  }
  return {
    result,
    changed: result === 'changed',
    elapsedMs: now() - started,
    before,
    after,
    lastComparison,
    changedRatio: Number.isFinite(Number(lastComparison.ratio)) ? Number(lastComparison.ratio) : 0,
  }
}

/**
 * Compare two tightly packed RGBA8 frames.
 *
 * A pixel counts as changed when any of its R, G or B channels differs by more
 * than `pixelThreshold` (alpha is ignored, matching button/cursor flicker
 * noise). Returns `{changedRatio, differingPixels, comparedPixels, dimensionMismatch}`;
 * a dimension change is reported as fully changed.
 */
export function compareRgbaFrames(before, after, pixelThreshold = DEFAULT_PIXEL_THRESHOLD) {
  const width = Number(before?.width)
  const height = Number(before?.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('compareRgbaFrames requires positive integer frame dimensions.')
  }
  const frameA = before?.data
  const frameB = after?.data
  if (!(frameA instanceof Uint8Array) || !(frameB instanceof Uint8Array)) {
    throw new Error('compareRgbaFrames requires Uint8Array pixel data.')
  }
  const otherWidth = Number(after?.width)
  const otherHeight = Number(after?.height)
  if (otherWidth !== width || otherHeight !== height) {
    // A resize is always a change, even though the pixel buffers differ in shape.
    return { changedRatio: 1, differingPixels: width * height, comparedPixels: width * height, dimensionMismatch: true }
  }
  const expectedBytes = width * height * 4
  if (frameA.byteLength < expectedBytes || frameB.byteLength < expectedBytes) {
    throw new Error('compareRgbaFrames received frames shorter than width * height * 4 bytes.')
  }
  const threshold = Number.isFinite(Number(pixelThreshold)) ? Math.max(0, Number(pixelThreshold)) : DEFAULT_PIXEL_THRESHOLD
  const pixels = width * height
  let differingPixels = 0
  for (let index = 0; index < expectedBytes; index += 4) {
    if (
      Math.abs(frameA[index] - frameB[index]) > threshold ||
      Math.abs(frameA[index + 1] - frameB[index + 1]) > threshold ||
      Math.abs(frameA[index + 2] - frameB[index + 2]) > threshold
    ) {
      differingPixels += 1
    }
  }
  return { changedRatio: differingPixels / pixels, differingPixels, comparedPixels: pixels, dimensionMismatch: false }
}

/**
 * Whether a pixel comparison crosses `minChangedRatio`. An identical frame is
 * never a change, even when `minChangedRatio` is 0.
 */
export function frameChanged(comparison, minChangedRatio = DEFAULT_MIN_CHANGED_RATIO) {
  const ratio = Number(comparison?.changedRatio)
  const minimum = Number.isFinite(Number(minChangedRatio)) ? Number(minChangedRatio) : DEFAULT_MIN_CHANGED_RATIO
  if (!Number.isFinite(ratio) || ratio <= 0) return false
  return ratio >= minimum
}

/**
 * In-memory LRU + TTL store for `auv_capture_state` snapshots.
 *
 * `put(token, value)` refreshes insertion order; `get(token)` returns the value
 * and touches it (LRU) or null when unknown/expired. The oldest entry is
 * evicted past `maxEntries`.
 */
export function createCaptureStateStore({ maxEntries = CAPTURE_STATE_MAX_ENTRIES, ttlMs = CAPTURE_STATE_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map()
  const store = {
    put(token, value) {
      if (typeof token !== 'string' || token === '') throw new Error('capture state token must be a non-empty string.')
      entries.delete(token)
      entries.set(token, { value, storedAt: now() })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
      }
      return value
    },
    get(token) {
      const entry = entries.get(token)
      if (entry === undefined) return null
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(token)
        return null
      }
      entries.delete(token)
      entries.set(token, entry)
      return entry.value
    },
    delete(token) {
      entries.delete(token)
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
    keys() {
      return [...entries.keys()]
    },
  }
  return store
}

// --- repeat guard -----------------------------------------------------------

/**
 * Deterministic JSON for repeat-guard identity: sorted object keys, arrays in
 * order, `allow_repeat` ignored (turning the override on must not look like a
 * different call), `undefined` fields dropped.
 */
export function canonicalize(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && key !== 'allow_repeat' && key !== 'allowRepeat')
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  const json = JSON.stringify(value)
  return json === undefined ? 'null' : json
}

/** Canonical identity for one mutating call: tool name + arguments. */
export function repeatGuardKey(toolName, args) {
  return `${toolName}:${canonicalize(isPlainObject(args) ? args : {})}`
}

/**
 * Consecutive-identical-call guard.
 *
 * The Nth identical mutating call (default 3) inside the window (default 30 s)
 * is blocked; a different call, or a gap longer than the window, resets the
 * counter. `bypass()` clears the state (used when `allow_repeat: true` sends a
 * call anyway).
 */
export function createRepeatGuard({ windowMs = REPEAT_GUARD_WINDOW_MS, limit = REPEAT_GUARD_LIMIT } = {}) {
  let lastKey = null
  let repeatCount = 0
  let lastAt = 0
  return {
    check(toolName, args, now = Date.now()) {
      const key = repeatGuardKey(toolName, args)
      if (key === lastKey && now - lastAt <= windowMs) repeatCount += 1
      else {
        lastKey = key
        repeatCount = 1
      }
      lastAt = now
      const blocked = repeatCount >= limit
      return { blocked, repeatCount, key, message: blocked ? REPEAT_GUARD_MESSAGE : null }
    },
    bypass() {
      lastKey = null
      repeatCount = 0
      lastAt = 0
    },
    snapshot() {
      return { key: lastKey, repeatCount, lastAt }
    },
  }
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
