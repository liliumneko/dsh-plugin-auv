/**
 * The twelve native DSH tools exposed by @local/dsh-auv.
 *
 * Each entry is a plain DSH ToolDefinition: name, description, object-rooted
 * parameter JSON Schema (within the enforced DSH subset), a `{}` output schema,
 * a render function that produces bounded text blocks, an async execute, a
 * positive timeout, and `isConcurrencySafe: () => false` because OS input is
 * mutually exclusive.
 *
 * Every tool talks to AUV through `@auv-js/sdk` only (see
 * `src/transport/sdk.mjs`): parameters are validated by the pure planners in
 * `src/transport/sdk-format.mjs` before the transport is touched, then the
 * typed SDK call runs against an attached or plugin-owned daemon. There is no
 * `auv` CLI child process and no command catalog.
 */

import { isPlainObject } from 'es-toolkit'

import { permissionHint } from './auv.mjs'
import {
  REPEAT_GUARD_MESSAGE,
  REPEAT_GUARD_WINDOW_MS,
  createRepeatGuard,
  parseActivateArgs,
  parseCaptureStateArgs,
  parseClickArgs,
  parseDragArgs,
  parseKeysArgs,
  parseOcrArgs,
  parseScreenshotArgs,
  parseScrollArgs,
  parseTypeArgs,
  parseWaitForChangeArgs,
  parseWindowsArgs,
} from './transport/sdk-format.mjs'
import { activeSdkTransport, requireCaptureState } from './transport/sdk.mjs'

const INLINE_JSON_LIMIT = 20_000
const SCREENSHOT_JSON_LIMIT = 8_000

const TOOL_TIMEOUT_MS = 120_000
const SLOW_TOOL_TIMEOUT_MS = 180_000

/** Model-facing tool names in registration order. */
export const TOOL_NAMES = [
  'auv_doctor',
  'auv_screenshot',
  'auv_ocr',
  'auv_click',
  'auv_type',
  'auv_keys',
  'auv_scroll',
  'auv_drag',
  'auv_capture_state',
  'auv_wait_for_change',
  'auv_windows',
  'auv_activate',
]

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function textBlock(text) {
  return [{ type: 'text', text: String(text) }]
}

function objectArgs(value) {
  return isPlainObject(value) ? value : {}
}

function boundedJson(value, limit = INLINE_JSON_LIMIT) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = undefined
  }
  if (typeof text !== 'string') text = String(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… truncated ${text.length - limit} of ${text.length} characters; narrow the request for a smaller result.`
}

function renderResult(lines, value, options = {}) {
  const parts = lines.map((line) => String(line)).filter((line) => line !== '')
  parts.push(boundedJson(value, options.jsonLimit ?? INLINE_JSON_LIMIT))
  return textBlock(parts.join('\n'))
}

function warningsLine(warnings) {
  return Array.isArray(warnings) && warnings.length > 0 ? `Warnings: ${warnings.join(' ')}` : ''
}

// ---------------------------------------------------------------------------
// Parameter schema building blocks
// ---------------------------------------------------------------------------

const WINDOW_ID_DESCRIPTION = 'Window reference id reported by auv_windows (window.list).'
const APPLICATION_ID_DESCRIPTION = 'Application id reported by auv_windows: the bundle id on macOS, for example com.apple.TextEdit.'
const DISPLAY_ID_DESCRIPTION = 'Display id from a previous auv_screenshot result (result.display.id); omit it to capture the primary display.'

function stringProperty(description) {
  return { type: 'string', description }
}

function numberProperty(description) {
  return { type: 'number', description }
}

function booleanProperty(description) {
  return { type: 'boolean', description }
}

function integerProperty(description) {
  return { type: 'integer', description }
}

function enumProperty(description, values) {
  return { type: 'string', enum: values, description }
}

const REGION_SCHEMA = {
  type: 'object',
  properties: {
    x: numberProperty('Left coordinate in logical screen points.'),
    y: numberProperty('Top coordinate in logical screen points.'),
    width: numberProperty('Region width in logical points; must be greater than zero.'),
    height: numberProperty('Region height in logical points; must be greater than zero.'),
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
  description: 'Screen rectangle in logical points; only valid for a screen or display target (omit window_id and application_id).',
}

const WITHIN_SCHEMA = {
  type: 'object',
  properties: {
    left: numberProperty('Left edge of the screen-coordinate fence.'),
    top: numberProperty('Top edge of the screen-coordinate fence.'),
    right: numberProperty('Right edge of the screen-coordinate fence.'),
    bottom: numberProperty('Bottom edge of the screen-coordinate fence.'),
  },
  required: ['left', 'top', 'right', 'bottom'],
  additionalProperties: false,
  description: 'Screen-coordinate fence checked against the OCR click point before delivery.',
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const POINT_SCHEMA = {
  type: 'object',
  properties: {
    x: numberProperty('X coordinate in the selected space (logical screen points unless space is window or display).'),
    y: numberProperty('Y coordinate in the selected space (logical screen points unless space is window or display).'),
  },
  required: ['x', 'y'],
  additionalProperties: false,
  description: 'A point with x and y coordinates.',
}

const ALLOW_REPEAT_DESCRIPTION =
  'Repeat guard opt-out: set true to send this exact mutating call again after it repeated 3 times within 30 seconds.'

// ---------------------------------------------------------------------------
// Plugin-side repeat guard (a hard stop; DSH also has its own repeat reminder)
// ---------------------------------------------------------------------------

const repeatGuard = createRepeatGuard()

/** The blocked value returned to the model instead of executing a repeated call. */
function repeatBlockedValue(toolName, decision) {
  return {
    status: 'no_effect_repeat',
    blocked: true,
    tool: toolName,
    repeat_count: decision.repeatCount,
    repeat_window_ms: REPEAT_GUARD_WINDOW_MS,
    message: REPEAT_GUARD_MESSAGE,
    warnings: [REPEAT_GUARD_MESSAGE],
  }
}

/**
 * Apply the repeat guard to a parsed mutating call. `allow_repeat: true` bypasses
 * the guard and clears its state so the model can deliberately retry.
 * @returns {object|null} a blocked tool value, or null when the call may run
 */
function guardMutation(toolName, plan, allowRepeat) {
  if (allowRepeat === true) {
    repeatGuard.bypass()
    return null
  }
  const decision = repeatGuard.check(toolName, plan)
  return decision.blocked ? repeatBlockedValue(toolName, decision) : null
}

/** Render a repeat-guard block, or null when the value is a normal result. */
function renderRepeatBlocked(value) {
  const outcome = objectArgs(value)
  if (outcome.status !== 'no_effect_repeat') return null
  return textBlock([String(outcome.message ?? REPEAT_GUARD_MESSAGE), boundedJson(value)].join('\n'))
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const DOCTOR_DESCRIPTION =
  'Check whether AUV can automate this Mac and what is blocking it. It attaches to a running AUV daemon (or starts a plugin-owned one) and returns the platform, whether the daemon was attached or started by the plugin plus its endpoint, Accessibility, Screen Recording, and ScreenCaptureKit permission state, all_ok, and a recommendation. AUV must be installed separately first; when the AUV executable is missing this tool returns the install commands. Call it first after installing the plugin and whenever another auv_* tool fails or reports a permission error. If all_ok is false, open System Settings → Privacy & Security and enable DeepSeek Harness (macOS 27+ merges the permission list into "Device Control and Data Access"; older macOS shows Accessibility and Screen Recording as separate items), restart the app, and run auv_doctor again.'

const SCREENSHOT_DESCRIPTION =
  'Capture a screenshot and return its saved image path. Use it to see the desktop, a window, or a screen region, then call read_image with artifact_path to view the image. Target one window with window_id, one application with application_id, one display with display_id, or a screen rectangle with region; pass only one. Captures are .webp artifacts and image bytes are never returned. The value includes bounds (logical screen rect), origin, scale_factor, and pixel_size: image_pixel = (screen_point - bounds.origin) * pixel_ratio, where pixel_ratio = pixel_size.width / bounds.size.width. All tool points are logical screen points. Use auv_ocr to read text. Screen capture needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.'

const OCR_DESCRIPTION =
  'Locate text on screen with Vision OCR and return the matches with their screen bounds. Use it to find a control before auv_click with text, or to read text that has no accessibility tree. Set wait: true to poll until the text appears, with an optional timeout_ms. Restrict the search with window_id or application_id; omit both to search the primary display. Each match keeps bounds (logical screen points) and adds screen_point (center), image_pixel = (screen_point - bounds.origin) * pixel_ratio, window_point = screen_point - window.frame.origin when windowed, scale_factor, and pixel_ratio. Text recognition needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.'

const CLICK_DESCRIPTION =
  'Click a UI element or an exact point. Pass text to locate it with OCR and click the match, or x and y to click a point; pass exactly one form. For x/y clicks, space chooses how the point is interpreted: window (window-local; default when a window or application target is given), screen (logical screen; default otherwise) or display (display-local; requires display_id). Unity/Canvas games often ignore window-targeted clicks, so pass space:"screen" there (or omit window_id entirely and give screen x/y); the point is then delivered as a foreground global click. button selects the mouse button; within fences an OCR click to a screen rectangle. The result returns screen_point plus window_point/display_point when known. This performs a real click and needs Accessibility permission for DeepSeek Harness; run auv_doctor if it is refused or lands nowhere. Repeating the same call is blocked after 3 tries within 30s; allow_repeat:true overrides.'

const TYPE_DESCRIPTION =
  'Type or paste text into the focused control. mode "type" (default) sends keystrokes; mode "paste" uses the clipboard and restores it, which is faster and safer for long or non-ASCII text. Optionally send to a window_id or application_id and choose the delivery policy. The result is delivery evidence, not proof the app reacted; pair it with auv_wait_for_change to verify. This is real keyboard input and needs Accessibility permission for DeepSeek Harness; run auv_doctor if keystrokes do not arrive. Repeating the same call is blocked after 3 tries within 30s; allow_repeat:true overrides.'

const KEYS_DESCRIPTION =
  'Press one key combination such as ["ctrl","l"] or ["cmd","shift","t"]. Modifiers come first and are released in reverse order. repeat presses the combination multiple times. Optionally target a window_id or application_id: with a target, focus defaults to true and the target is focused first (window.setFocus / applications.activate), and policy picks delivery (background-only, background-preferred, foreground-preferred; default foreground-preferred; background policies require a target). Without a target the foreground app receives the keys. With foreground-preferred (the default) and a target, the plugin focuses the target and sends a real foreground key event, because Unity/Canvas apps often ignore window-targeted events. AUV reports delivery only, not that the app reacted; pair with auv_wait_for_change to verify. This is real keyboard input that needs Accessibility permission for DeepSeek Harness; use auv_type for text. Run auv_doctor on failure. Repeating the same call is blocked after 3 tries within 30s; allow_repeat:true overrides.'

const SCROLL_DESCRIPTION =
  'Scroll at a point. dy is required and positive dy scrolls down; dx scrolls right when given. With window_id, scroll inside that window at its center or at window-local x and y. Without window_id, pass screen x and y; macOS does not support AUV screen-point scrolling, so prefer window_id on macOS. Deltas are logical pixels; results return window_point and the delivered screen_point. This is real input that needs Accessibility permission for DeepSeek Harness; run auv_doctor on failure. Repeating the same call is blocked after 3 tries within 30s; allow_repeat:true overrides.'

const DRAG_DESCRIPTION =
  'Drag with a mouse button from one point to another. from and to are points in the selected space; space defaults to window for a window or application target, display for display_id, and screen otherwise, and window/display points are converted to logical screen points with the target frame. With window_id or application_id the target is focused first unless activate:false, because macOS drags move the real pointer and an inactive window can consume the first press. button defaults to left; duration_ms defaults to 300. The result returns from/to, screen_start/screen_end, and window_point when windowed. This performs real mouse input and needs Accessibility permission for DeepSeek Harness; run auv_doctor if it fails. Repeating the same call is blocked after 3 tries within 30s; allow_repeat:true overrides.'

const WAIT_FOR_CHANGE_DESCRIPTION =
  'Wait until a window, display, or screen region changes. Workflow: call auv_capture_state before the action, then auv_wait_for_change with the returned state_token after it; the call compares downscaled RGBA pixels against that baseline and ignores small flicker. min_changed_ratio (0-1, default 0.01) is the fraction of changed pixels required; pixel_threshold (0-255, default 24) is the per-channel difference treated as noise. Returns result changed|no_effect|timeout, changed, changed_ratio, elapsed_ms, before/after hashes and baseline_source. baseline_hash (a before_hash/after_hash from an earlier call) is legacy ThumbHash-only comparison and warns that it is coarse. Read-only: it captures frames but writes no files. Use it after auv_click, auv_type, auv_drag or auv_scroll to prove the app reacted; auv_keys delivery has no reaction guarantee (Unity/Canvas may drop the event). Screen capture needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.'

const CAPTURE_STATE_DESCRIPTION =
  'Capture the current frame and store a compact downscaled state for later comparison. Call it immediately before an action, then call auv_wait_for_change with the returned state_token: comparison uses RGBA pixel ratios, so cursor/button flicker no longer reports a false change. Uses the same targets as auv_wait_for_change (window_id, application_id, display_id or a screen region). States stay in memory only (max 20, 5-minute TTL) and no file is written. Returns state_token, hash, width, height, mode and captured_at. Screen capture needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.'

const WINDOWS_DESCRIPTION =
  'List the windows you could switch to, with each window id, owning application and application id, title, frame, and state. Use it to find window_id and application_id values for the other tools. Minimized windows and windows on other desktops are excluded by default; set include_minimized or include_other_desktops to include them. Window state comes from the window server and needs no Accessibility permission.'

const ACTIVATE_DESCRIPTION =
  'Bring an application to the front by its application id: the bundle id on macOS, for example com.apple.TextEdit. Use it before typing or clicking when the target app is not focused. Get ids from auv_windows. This changes foreground focus but enters no text. If activation is refused or ineffective, run auv_doctor to check permissions.'

const MACOS_SCREEN_POINT_SCROLL_ERROR =
  'macOS cannot scroll at a screen point: AUV\'s input.scrollPoint is available only on Linux and Windows. Pass window_id (and optionally window-local x and y) so the scroll goes through window.scroll.'

/**
 * Build a doctor report for a transport that could not be initialized.
 * Mirrors the SDK doctor shape so the renderer works for both cases.
 */
function doctorFailureReport(error) {
  const message = messageOf(error)
  const hint = permissionHint(message)
  const installIssue = /AUV was not found|AUV_BIN|Install AUV|not found on PATH/i.test(message)
  return {
    platform: process.platform,
    daemon: null,
    permissions_checked: false,
    accessibility: null,
    screen_recording: null,
    screen_capture_kit: null,
    automation: null,
    all_ok: false,
    recommendation: installIssue
      ? 'Install AUV (the error below lists the commands) or start a running AUV daemon, then run auv_doctor again.'
      : (hint ??
        'Start or install AUV, grant Accessibility and Screen Recording to DeepSeek Harness in System Settings → Privacy & Security, then run auv_doctor again.'),
    error: message,
    warnings: [],
  }
}

/** Render the plain doctor report (shared by the SDK and failure shapes). */
function renderDoctorReport(value) {
  const report = objectArgs(value)
  const allOk = report.all_ok === true
  const lines = [allOk ? 'AUV doctor: all checks passed, AUV is ready.' : 'AUV doctor: AUV is not fully ready.']
  if (typeof report.platform === 'string' && report.platform !== '') lines.push(`platform: ${report.platform}`)

  const daemon = report.daemon
  if (daemon !== null && typeof daemon === 'object') {
    const owner = daemon.mode === 'attached' ? 'attached to the running AUV daemon' : daemon.mode === 'owned' ? 'started by this plugin (owned)' : 'daemon'
    const endpoint = typeof daemon.endpoint === 'string' && daemon.endpoint !== '' ? ` at ${daemon.endpoint}` : ''
    const pid = typeof daemon.pid === 'number' ? ` (pid ${daemon.pid})` : ''
    const health = typeof daemon.health === 'string' && daemon.health !== '' ? `, health ${daemon.health}` : ''
    lines.push(`daemon: ${owner}${endpoint}${pid}${health}`)
  }

  if (report.permissions_checked === true) {
    for (const [key, label] of [
      ['accessibility', 'accessibility'],
      ['screen_recording', 'screen_recording'],
      ['screen_capture_kit', 'screen_capture_kit'],
      ['automation', 'automation (optional)'],
    ]) {
      if (report[key] !== null && report[key] !== undefined) lines.push(`${label}: ${String(report[key])}`)
    }
  }

  lines.push(warningsLine(report.warnings))
  if (typeof report.error === 'string' && report.error !== '') lines.push(`error: ${report.error}`)
  if (typeof report.recommendation === 'string' && report.recommendation !== '') {
    lines.push(`recommendation: ${report.recommendation}`)
  }
  if (!allOk && report.permissions_checked !== true) {
    lines.push(
      'To fix: install AUV if missing, start a local AUV daemon or let the plugin start one, grant macOS permissions to DeepSeek Harness, then run auv_doctor again.',
    )
  }
  return renderResult(lines, value, { jsonLimit: 12_000 })
}

function formatWindowLine(window) {
  if (window === null || typeof window !== 'object') return '- (unreadable window entry)'
  const id = window.reference?.id !== undefined ? String(window.reference.id) : '?'
  const app = typeof window.application_id === 'string' && window.application_id !== '' ? window.application_id : '(unknown app)'
  const title = typeof window.title === 'string' && window.title !== '' ? window.title : '(untitled)'
  const frame = window.frame ?? {}
  const origin = frame.origin ?? {}
  const size = frame.size ?? {}
  const geometry = [origin.x, origin.y, size.width, size.height].every((value) => Number.isFinite(Number(value)))
    ? ` [${Number(origin.x)},${Number(origin.y)} ${Number(size.width)}×${Number(size.height)}]`
    : ''
  const state = window.state ?? {}
  const flags = []
  if (state.is_minimized === true) flags.push('minimized')
  if (state.is_focused === true) flags.push('focused')
  if (state.desktop !== null && state.desktop !== undefined) flags.push(`desktop ${String(state.desktop)}`)
  return `- id ${id} | ${app} | ${title}${geometry}${flags.length > 0 ? ` | ${flags.join(', ')}` : ''}`
}

/** All nine tool definitions, created fresh on each call. */
export function createTools() {
  return [
    {
      name: 'auv_doctor',
      description: DOCTOR_DESCRIPTION,
      parameters: objectSchema({}),
      output: {
        schema: {},
        render(_args, value) {
          return renderDoctorReport(value)
        },
      },
      async execute(_rawArgs, exec) {
        try {
          const sdk = await activeSdkTransport()
          return await sdk.doctor(exec, TOOL_TIMEOUT_MS)
        } catch (error) {
          return doctorFailureReport(error)
        }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_screenshot',
      description: SCREENSHOT_DESCRIPTION,
      parameters: objectSchema({
        window_id: stringProperty(WINDOW_ID_DESCRIPTION),
        application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
        display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
        region: REGION_SCHEMA,
      }),
      output: {
        schema: {},
        render(_args, value) {
          const shot = objectArgs(value)
          const artifactPath = typeof shot.artifact_path === 'string' ? shot.artifact_path : null
          const size = shot.width !== null && shot.width !== undefined && shot.height !== null && shot.height !== undefined ? `${shot.width}×${shot.height} px` : 'size unknown'
          const lines = [`Captured ${shot.command_id ?? 'screenshot'} (${size}${shot.content_type ? `, ${shot.content_type}` : ''}).`]
          if (artifactPath !== null) {
            lines.push(`artifact_path: ${artifactPath}`)
            lines.push('Call read_image with this artifact_path to view the screenshot.')
          } else {
            lines.push('AUV returned no image artifact for this capture.')
          }
          lines.push(warningsLine(shot.warnings))
          return renderResult(lines, value, { jsonLimit: SCREENSHOT_JSON_LIMIT })
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseScreenshotArgs(rawArgs)
        const sdk = await activeSdkTransport()
        return await sdk.screenshot(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_ocr',
      description: OCR_DESCRIPTION,
      parameters: objectSchema(
        {
          text: stringProperty('Literal text to find in the captured image.'),
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
          wait: booleanProperty('Poll until the text appears instead of failing immediately.'),
          timeout_ms: integerProperty('Polling timeout in milliseconds, 100-120000. Only valid with wait: true.'),
        },
        ['text'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const lines = [`OCR completed (${outcome.command_id ?? 'ocr'}).`]
          if (outcome.timed_out === true) lines.push('The text did not appear before timeout_ms expired.')
          lines.push(warningsLine(outcome.warnings))
          if (typeof outcome.hint === 'string' && outcome.hint !== '') lines.push(outcome.hint)
          lines.push('Matches are in "result"; use auv_click with text to click one.')
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseOcrArgs(rawArgs)
        const sdk = await activeSdkTransport()
        return await sdk.ocr(plan, exec, SLOW_TOOL_TIMEOUT_MS)
      },
      timeoutMs: SLOW_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_click',
      description: CLICK_DESCRIPTION,
      parameters: objectSchema({
        text: stringProperty('Visible text to locate with OCR and click. Cannot be combined with x/y.'),
        x: numberProperty('Click X coordinate. Requires y; cannot be combined with text.'),
        y: numberProperty('Click Y coordinate. Requires x; cannot be combined with text.'),
        window_id: stringProperty(WINDOW_ID_DESCRIPTION),
        application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
        display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
        space: enumProperty(
          'Coordinate space for x/y clicks: window (window-local; default with a window/application target), screen (logical screen; default otherwise), display (display-local; requires display_id).',
          ['screen', 'window', 'display'],
        ),
        button: enumProperty('Mouse button for x/y clicks; defaults to left.', ['left', 'right', 'middle']),
        within: WITHIN_SCHEMA,
        allow_repeat: booleanProperty(ALLOW_REPEAT_DESCRIPTION),
      }),
      output: {
        schema: {},
        render(_args, value) {
          const blocked = renderRepeatBlocked(value)
          if (blocked !== null) return blocked
          const outcome = objectArgs(value)
          const target = typeof outcome.target === 'string' && outcome.target !== '' ? ` via ${outcome.target}` : ''
          const lines = [`Clicked${target} (${outcome.command_id ?? 'click'}).`]
          if (outcome.screen_point !== null && typeof outcome.screen_point === 'object') {
            lines.push(`screen_point: ${outcome.screen_point.x},${outcome.screen_point.y}`)
          }
          if (outcome.window_point !== null && typeof outcome.window_point === 'object') {
            lines.push(`window_point: ${outcome.window_point.x},${outcome.window_point.y}`)
          }
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseClickArgs(rawArgs)
        const blocked = guardMutation('auv_click', plan, plan.allowRepeat)
        if (blocked !== null) return blocked
        const sdk = await activeSdkTransport()
        return await sdk.click(plan, exec, SLOW_TOOL_TIMEOUT_MS)
      },
      timeoutMs: SLOW_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_type',
      description: TYPE_DESCRIPTION,
      parameters: objectSchema(
        {
          text: stringProperty('Text to type or paste into the focused control.'),
          mode: enumProperty('"type" sends keystrokes; "paste" uses the clipboard and restores it.', ['type', 'paste']),
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
          policy: enumProperty('Delivery policy: foreground activates the app first; background modes do not.', [
            'background-only',
            'background-preferred',
            'foreground-preferred',
          ]),
          allow_repeat: booleanProperty(ALLOW_REPEAT_DESCRIPTION),
        },
        ['text'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const blocked = renderRepeatBlocked(value)
          if (blocked !== null) return blocked
          const outcome = objectArgs(value)
          const lines = [`Text delivered (${outcome.command_id ?? 'input'}).`]
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseTypeArgs(rawArgs)
        const blocked = guardMutation('auv_type', plan, plan.allowRepeat)
        if (blocked !== null) return blocked
        const sdk = await activeSdkTransport()
        return await sdk.type(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_keys',
      description: KEYS_DESCRIPTION,
      parameters: objectSchema(
        {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'One key combination as ordered key names, for example ["ctrl","l"] or ["cmd","shift","t"]. Modifiers first.',
          },
          repeat: integerProperty('Number of complete presses, 1-255. Values above 1 require interval_ms.'),
          interval_ms: integerProperty('Delay in milliseconds between repeated presses; only used with repeat greater than 1 (default 50).'),
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
          policy: enumProperty(
            'Delivery policy; defaults to foreground-preferred. Background policies require a window_id or application_id target.',
            ['background-only', 'background-preferred', 'foreground-preferred'],
          ),
          focus: booleanProperty(
            'Focus the window/application before pressing keys; defaults to true when a target is given and false otherwise.',
          ),
          allow_repeat: booleanProperty(ALLOW_REPEAT_DESCRIPTION),
        },
        ['keys'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const blocked = renderRepeatBlocked(value)
          if (blocked !== null) return blocked
          const outcome = objectArgs(value)
          const target = typeof outcome.target === 'string' && outcome.target !== '' ? ` in ${outcome.target}` : ' in the foreground app'
          const lines = [`Keys pressed${target} (${outcome.command_id ?? 'input.pressKeys'}).`]
          if (typeof outcome.policy === 'string') lines.push(`policy: ${outcome.policy}`)
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseKeysArgs(rawArgs)
        const blocked = guardMutation('auv_keys', plan, plan.allowRepeat)
        if (blocked !== null) return blocked
        const sdk = await activeSdkTransport()
        return await sdk.keys(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_scroll',
      description: SCROLL_DESCRIPTION,
      parameters: objectSchema(
        {
          dy: numberProperty('Vertical delta in logical pixels; positive scrolls down.'),
          dx: numberProperty('Horizontal delta in logical pixels; positive scrolls right.'),
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          x: numberProperty('X coordinate: window-local with window_id, otherwise screen coordinate.'),
          y: numberProperty('Y coordinate: window-local with window_id, otherwise screen coordinate.'),
          allow_repeat: booleanProperty(ALLOW_REPEAT_DESCRIPTION),
        },
        ['dy'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const blocked = renderRepeatBlocked(value)
          if (blocked !== null) return blocked
          const outcome = objectArgs(value)
          const lines = [`Scrolled (${outcome.command_id ?? 'scroll'}).`]
          if (outcome.screen_point !== null && typeof outcome.screen_point === 'object') {
            lines.push(`screen_point: ${outcome.screen_point.x},${outcome.screen_point.y}`)
          }
          if (outcome.window_point !== null && typeof outcome.window_point === 'object') {
            lines.push(`window_point: ${outcome.window_point.x},${outcome.window_point.y}`)
          }
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseScrollArgs(rawArgs)
        const blocked = guardMutation('auv_scroll', plan, plan.allowRepeat)
        if (blocked !== null) return blocked
        if (plan.windowId === undefined && process.platform === 'darwin') throw new Error(MACOS_SCREEN_POINT_SCROLL_ERROR)
        const sdk = await activeSdkTransport()
        return await sdk.scroll(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_drag',
      description: DRAG_DESCRIPTION,
      parameters: objectSchema(
        {
          from: POINT_SCHEMA,
          to: POINT_SCHEMA,
          space: enumProperty(
            'Coordinate space of from/to; defaults to window for a window/application target, display for display_id, screen otherwise.',
            ['screen', 'window', 'display'],
          ),
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
          display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
          button: enumProperty('Mouse button to hold during the drag; defaults to left.', ['left', 'right', 'middle']),
          duration_ms: integerProperty('Drag duration in milliseconds, 0-30000; defaults to 300.'),
          activate: booleanProperty(
            'Bring the window/application to the front before dragging; defaults to true when a window/application target is given.',
          ),
          allow_repeat: booleanProperty(ALLOW_REPEAT_DESCRIPTION),
        },
        ['from', 'to'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const blocked = renderRepeatBlocked(value)
          if (blocked !== null) return blocked
          const outcome = objectArgs(value)
          const start = outcome.screen_start !== null && typeof outcome.screen_start === 'object' ? `${outcome.screen_start.x},${outcome.screen_start.y}` : '?'
          const end = outcome.screen_end !== null && typeof outcome.screen_end === 'object' ? `${outcome.screen_end.x},${outcome.screen_end.y}` : '?'
          const lines = [`Dragged with the ${outcome.button ?? 'left'} button from screen ${start} to ${end} (${outcome.command_id ?? 'input.dragMouse'}).`]
          if (outcome.window_point !== null && typeof outcome.window_point === 'object') {
            lines.push(`window_point: ${outcome.window_point.x},${outcome.window_point.y}`)
          }
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseDragArgs(rawArgs)
        const blocked = guardMutation('auv_drag', plan, plan.allowRepeat)
        if (blocked !== null) return blocked
        const sdk = await activeSdkTransport()
        return await sdk.drag(plan, exec, SLOW_TOOL_TIMEOUT_MS)
      },
      timeoutMs: SLOW_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_capture_state',
      description: CAPTURE_STATE_DESCRIPTION,
      parameters: objectSchema({
        window_id: stringProperty(WINDOW_ID_DESCRIPTION),
        application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
        display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
        region: REGION_SCHEMA,
      }),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const size = outcome.width !== undefined && outcome.height !== undefined ? `${outcome.width}×${outcome.height}` : 'size unknown'
          const lines = [`Captured state (${outcome.mode ?? 'screen'}, ${size}).`]
          if (typeof outcome.state_token === 'string' && outcome.state_token !== '') {
            lines.push(`state_token: ${outcome.state_token}`)
            lines.push('Pass this state_token to auv_wait_for_change after the action.')
          }
          if (typeof outcome.hash === 'string' && outcome.hash !== '') lines.push(`hash: ${outcome.hash}`)
          if (typeof outcome.captured_at === 'string' && outcome.captured_at !== '') lines.push(`captured_at: ${outcome.captured_at}`)
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseCaptureStateArgs(rawArgs)
        const sdk = await activeSdkTransport()
        return await sdk.captureState(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_wait_for_change',
      description: WAIT_FOR_CHANGE_DESCRIPTION,
      parameters: objectSchema({
        window_id: stringProperty(WINDOW_ID_DESCRIPTION),
        application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
        display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
        region: REGION_SCHEMA,
        state_token: stringProperty(
          'Token from auv_capture_state taken immediately before the action; the pixel baseline for the comparison.',
        ),
        baseline_hash: stringProperty(
          'Legacy: an earlier before_hash/after_hash value (format "thumbhash:<hex>" or "sha256:<hex>"); compared as a ThumbHash only, which is coarse.',
        ),
        timeout_ms: integerProperty('Polling timeout in milliseconds, 100-120000; defaults to 5000.'),
        interval_ms: integerProperty('Delay between captures in milliseconds, 50-5000; defaults to 200.'),
        min_changed_ratio: numberProperty('Fraction of changed pixels required to report changed, 0-1; defaults to 0.01.'),
        pixel_threshold: integerProperty('Per-channel RGB difference ignored as noise, 0-255; defaults to 24.'),
      }),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const changed = outcome.changed === true
          const result = typeof outcome.result === 'string' ? outcome.result : changed ? 'changed' : 'timeout'
          const lines = [
            changed
              ? `Change detected (${outcome.mode ?? 'screen'}; ${outcome.elapsed_ms ?? '?'} ms).`
              : `No change detected: ${result} (${outcome.mode ?? 'screen'}; ${outcome.elapsed_ms ?? '?'} ms).`,
          ]
          if (typeof outcome.changed_ratio === 'number') {
            const minimum = typeof outcome.min_changed_ratio === 'number' ? ` (min ${outcome.min_changed_ratio})` : ''
            lines.push(`changed_ratio: ${outcome.changed_ratio}${minimum}`)
          }
          if (typeof outcome.baseline_source === 'string') lines.push(`baseline: ${outcome.baseline_source}`)
          if (typeof outcome.before_hash === 'string' && typeof outcome.after_hash === 'string') {
            lines.push(`before: ${outcome.before_hash}`)
            lines.push(`after: ${outcome.after_hash}`)
          }
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseWaitForChangeArgs(rawArgs)
        // Fail before the transport is touched when the token is unknown/expired.
        if (plan.stateToken !== undefined) requireCaptureState(plan.stateToken)
        const sdk = await activeSdkTransport()
        return await sdk.waitForChange(plan, exec, SLOW_TOOL_TIMEOUT_MS)
      },
      timeoutMs: SLOW_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_windows',
      description: WINDOWS_DESCRIPTION,
      parameters: objectSchema({
        include_minimized: booleanProperty('Include minimized windows. Default false.'),
        include_other_desktops: booleanProperty('Include windows on other virtual desktops. Default false.'),
      }),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const windows = Array.isArray(outcome.windows) ? outcome.windows : []
          const lines = [`${windows.length} window${windows.length === 1 ? '' : 's'} listed.`]
          for (const window of windows.slice(0, 40)) {
            lines.push(formatWindowLine(window))
          }
          if (windows.length > 40) lines.push(`… ${windows.length - 40} more windows in "windows".`)
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseWindowsArgs(rawArgs)
        const sdk = await activeSdkTransport()
        return await sdk.windows(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_activate',
      description: ACTIVATE_DESCRIPTION,
      parameters: objectSchema({ application_id: stringProperty(APPLICATION_ID_DESCRIPTION) }, ['application_id']),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const target = typeof outcome.target === 'string' && outcome.target !== '' ? outcome.target : 'application'
          const lines = [`Activated ${target}.`]
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const plan = parseActivateArgs(rawArgs)
        const sdk = await activeSdkTransport()
        return await sdk.activate(plan, exec, TOOL_TIMEOUT_MS)
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },
  ]
}
