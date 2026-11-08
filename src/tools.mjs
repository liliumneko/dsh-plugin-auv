/**
 * The eleven native DSH tools exposed by @local/dsh-auv.
 *
 * Each entry is a plain DSH ToolDefinition: name, description, object-rooted
 * parameter JSON Schema (within the enforced DSH subset), a `{}` output schema,
 * a render function that produces bounded text blocks, an async execute, a
 * positive timeout, and `isConcurrencySafe: () => false` because OS input is
 * mutually exclusive.
 *
 * The AUV command catalog (src/catalog.json mirrored into src/catalog-data.mjs,
 * exposed by src/catalog.mjs) is statically imported so the tsdown bundle inlines
 * it into the single dist/index.mjs. A missing generated catalog therefore fails
 * package validation/build time, not at first tool call.
 */

import { isPlainObject } from 'es-toolkit'

import {
  artifactPathOf,
  clampTimeout,
  runAuv,
} from './auv.mjs'
import * as catalogModule from './catalog.mjs'
import {
  activeSdkTransport,
  runAuvDoctorWithSdkFallback,
  runAuvWithSdkFallback,
} from './transport/sdk.mjs'

const INLINE_JSON_LIMIT = 20_000
const SCREENSHOT_JSON_LIMIT = 8_000
const WINDOW_TARGET_TTL_MS = 30_000

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
  'auv_windows',
  'auv_activate',
  'auv_invoke',
  'auv_help',
]

// ---------------------------------------------------------------------------
// Catalog access (lazy, defensive)
// ---------------------------------------------------------------------------

/** The statically imported catalog module (bundled into dist/index.mjs). */
async function getCatalogModule() {
  return catalogModule
}

/** Resolve one catalog command or throw an actionable unknown-command error. */
async function getCatalogCommand(commandId) {
  const catalog = await getCatalogModule()
  const command = await catalog.getCommand(commandId)
  if (command === undefined || command === null) {
    throw new Error(`Unknown AUV command "${commandId}". Call auv_help without arguments to list every command id.`)
  }
  return { catalog, command }
}

/** List a command's catalog argument descriptors. */
function catalogArguments(command) {
  return Array.isArray(command?.arguments) ? command.arguments : []
}

/** Input key of the Nth positional argument (0-based). */
function positionalKey(command, index = 0) {
  const positionals = catalogArguments(command).filter((argument) => argument?.kind === 'positional')
  const argument = positionals[index]
  if (argument === undefined || typeof argument.input_key !== 'string') {
    throw catalogShapeError(command, `positional argument ${index}`)
  }
  return argument.input_key
}

/** Input key of a flag/value option, looked up by its exact CLI flag. */
function flagKey(command, flag) {
  const argument = catalogArguments(command).find((candidate) => candidate?.flag === flag)
  if (argument === undefined || typeof argument.input_key !== 'string') {
    throw catalogShapeError(command, `option ${flag}`)
  }
  return argument.input_key
}

function catalogShapeError(command, detail) {
  return new Error(
    `The AUV catalog entry for "${command?.id ?? 'unknown'}" is missing ${detail}. Regenerate src/catalog.json with \`node tools/generate-catalog.mjs\`.`,
  )
}

/**
 * Build argv for one catalog command through the catalog's own argv builder and
 * wrap its warnings. Unknown keys and missing required arguments are rejected by
 * that builder and surfaced with a pointer to auv_help.
 */
async function buildInvoke(commandId, inputs, options = {}) {
  const { catalog, command } = await getCatalogCommand(commandId)
  let built
  try {
    built = await catalog.buildInvokeArgs(command, inputs, options.target === undefined ? undefined : { target: options.target })
  } catch (error) {
    throw new Error(
      `Cannot build arguments for AUV command "${commandId}": ${messageOf(error)} Call auv_help with command_id "${commandId}" to see the accepted arguments.`,
    )
  }
  const target = typeof built?.target === 'string' && built.target !== '' ? built.target : undefined
  const warnings = Array.isArray(built?.warnings) ? built.warnings.map((warning) => String(warning)) : []
  const args = Array.isArray(built?.args) ? built.args.map((argument) => String(argument)) : []
  return { command, args, target, warnings }
}

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

function receiptMeta(receipt) {
  return {
    run_id: typeof receipt?.run_id === 'string' ? receipt.run_id : null,
    command_id: typeof receipt?.command_id === 'string' ? receipt.command_id : null,
    status: typeof receipt?.status === 'string' ? receipt.status : null,
  }
}

function warningsLine(warnings) {
  return Array.isArray(warnings) && warnings.length > 0 ? `Warnings: ${warnings.join(' ')}` : ''
}

/** Append a hint to an error message without losing the original diagnostics. */
function withHint(error, hint) {
  if (error instanceof Error) {
    if (!error.message.includes(hint)) error.message = `${error.message}\n${hint}`
    return error
  }
  return new Error(`${String(error)}\n${hint}`)
}

// ---------------------------------------------------------------------------
// Window / display resolution
// ---------------------------------------------------------------------------

const windowTargetCache = new Map()

/**
 * Resolve a window reference id into the application target that window.*
 * commands actually accept (they reject `window:` targets on macOS).
 *
 * Uses `window.get --target window:<id>`, caches the result briefly, and returns
 * a warning when the window has no title so the app's main window is captured.
 */
async function resolveWindow(windowId, signal) {
  const cached = windowTargetCache.get(windowId)
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value

  const receipt = await runAuv({
    commandId: 'window.get',
    argv: [],
    target: `window:${windowId}`,
    signal,
    timeoutMs: 30_000,
  })
  const window = receipt?.result
  const applicationId = typeof window?.application_id === 'string' && window.application_id !== '' ? window.application_id : undefined
  if (applicationId === undefined) {
    throw new Error(
      `AUV could not resolve window "${windowId}" to an application. Call auv_windows to refresh window ids, then retry.`,
    )
  }
  const title = typeof window?.title === 'string' && window.title !== '' ? window.title : null
  const warnings = []
  if (title === null) {
    warnings.push(`Window "${windowId}" has no title; targeting the application's main visible window instead.`)
  }
  const value = { window, applicationId, title, target: `app:${applicationId}`, warnings }
  if (windowTargetCache.size >= 100) windowTargetCache.clear()
  windowTargetCache.set(windowId, { expiresAt: Date.now() + WINDOW_TARGET_TTL_MS, value })
  return value
}

/** Add the --title input for window.* commands when the title is known. */
function withWindowTitle(command, inputs, title) {
  if (title === null) return inputs
  return { ...inputs, [flagKey(command, '--title')]: title }
}

/** Resolve a display id into a full-display capture region via display.list. */
async function resolveDisplayRegion(displayId, signal) {
  const receipt = await runAuv({ commandId: 'display.list', argv: [], signal, timeoutMs: 30_000 })
  const displays = Array.isArray(receipt?.result?.displays) ? receipt.result.displays : []
  const display = displays.find((candidate) => String(candidate?.id) === String(displayId))
  if (display === undefined) {
    const available = displays.map((candidate) => `${String(candidate?.id)}${candidate?.name ? ` (${candidate.name})` : ''}`).join(', ')
    throw new Error(
      `Display "${displayId}" was not found. Available displays: ${available === '' ? 'none reported by display.list' : available}.`,
    )
  }
  const origin = display.frame?.origin ?? {}
  const size = display.frame?.size ?? {}
  const region = {
    x: Number(origin.x),
    y: Number(origin.y),
    width: Number(size.width),
    height: Number(size.height),
  }
  if (![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value)) || region.width <= 0 || region.height <= 0) {
    throw new Error(`Display "${displayId}" has an unusable frame in display.list. Pass an explicit region instead.`)
  }
  return region
}

// ---------------------------------------------------------------------------
// Parameter schema building blocks
// ---------------------------------------------------------------------------

const WINDOW_ID_DESCRIPTION = 'Window reference id reported by auv_windows (window.list).'
const APPLICATION_ID_DESCRIPTION = 'Application id reported by auv_windows: the bundle id on macOS, for example com.apple.TextEdit.'
const DISPLAY_ID_DESCRIPTION = 'Display id reported by display.list (auv_invoke command_id "display.list").'

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
  description: 'Screen rectangle in logical points; only valid when no window or application target is given.',
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

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    application_id: stringProperty('Target an application by id (bare id accepted by AUV; app: prefix added automatically).'),
    window_id: stringProperty('Target a window by its reference id. Not accepted by commands that forbid window targets.'),
    display_id: stringProperty('Target a display by its id. Only for commands that accept display targets.'),
  },
  additionalProperties: false,
  description: 'Exactly one of application_id, window_id, or display_id; omit for commands that operate without a target.',
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const DOCTOR_DESCRIPTION =
  'Check whether AUV can automate this Mac and what is blocking it. Returns the doctor report: Accessibility and Screen Recording state, capture backend, all_ok, and a recommendation. AUV must be installed separately first; when the auv executable is missing this tool returns the install commands. Call it first after installing the plugin and whenever another auv_* tool fails or reports a permission error. If all_ok is false, open System Settings → Privacy & Security and enable DeepSeek Harness (macOS 27+ merges the permission list into "Device Control and Data Access"; older macOS shows Accessibility and Screen Recording as separate items), restart the app, and run auv_doctor again.'

const SCREENSHOT_DESCRIPTION =
  'Capture a screenshot and return its saved image path. Use it to see the desktop, a window, or a screen region, then call read_image with artifact_path to view the image. Target one window with window_id, one application with application_id, one display with display_id, or a screen rectangle with region; pass only one. Captures are .webp artifacts and image bytes are never returned. Use auv_ocr to read text. Screen capture needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.'

const OCR_DESCRIPTION =
  'Locate text on screen with Vision OCR and return the matches with their screen bounds. Use it to find a control before auv_click with text, or to read text that has no accessibility tree. Set wait: true to poll until the text appears, with an optional timeout_ms. Restrict the search with window_id or application_id; omit both to search the primary display. Text recognition needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.'

const CLICK_DESCRIPTION =
  'Click a UI element or an exact point. Pass text to locate it with OCR and click the match, or x and y to click a point; pass exactly one form. Constrain an OCR click with window_id or application_id, or target a display with display_id in the x/y form. button selects the mouse button for x/y clicks; within fences an OCR click to a screen rectangle. This performs a real click and needs Accessibility permission for DeepSeek Harness; run auv_doctor if it is refused or lands nowhere.'

const TYPE_DESCRIPTION =
  'Type or paste text into the focused control. mode "type" (default) sends keystrokes; mode "paste" uses the clipboard and restores it, which is faster and safer for long or non-ASCII text. Optionally send to a window_id or application_id and choose the delivery policy. This is real keyboard input and needs Accessibility permission for DeepSeek Harness; run auv_doctor if keystrokes do not arrive.'

const KEYS_DESCRIPTION =
  'Press one key combination such as ["ctrl","l"] or ["cmd","shift","t"]. Modifiers come first and are released in reverse order. repeat presses the combination multiple times. Optionally target a window_id or application_id; without a target the foreground app receives the keys. This is real keyboard input that needs Accessibility permission for DeepSeek Harness; use auv_type for text. Run auv_doctor on failure.'

const SCROLL_DESCRIPTION =
  'Scroll at a point. dy is required and positive dy scrolls down; dx scrolls right when given. With window_id, scroll inside that window at its center or at window-local x and y. Without window_id, pass screen x and y; macOS does not support AUV screen-point scrolling, so prefer window_id on macOS. This is real input that needs Accessibility permission for DeepSeek Harness; run auv_doctor on failure.'

const WINDOWS_DESCRIPTION =
  'List the windows you could switch to, with each window id, owning application and application id, title, frame, and state. Use it to find window_id and application_id values for the other tools. Minimized windows and windows on other desktops are excluded by default; set include_minimized or include_other_desktops to include them. Window state comes from the window server and needs no Accessibility permission.'

const ACTIVATE_DESCRIPTION =
  'Bring an application to the front by its application id: the bundle id on macOS, for example com.apple.TextEdit. Use it before typing or clicking when the target app is not focused. Get ids from auv_windows. This changes foreground focus but enters no text. If activation is refused or ineffective, run auv_doctor to check permissions.'

const INVOKE_DESCRIPTION =
  'Run any AUV command directly. Use it for capabilities without a dedicated tool (display.list, window.get, window.focus, input.moveMouse, media.*, permission.probe, ...) or when you need exact control. command_id must be one of the ids listed by auv_help; the catalog has 43: display.capture, display.list, display.captureRegion, display.findText, display.waitForText, display.clickText, window.list, window.get, window.setFrame, window.setState, window.focus, window.capture, window.findText, window.waitForText, window.clickText, window.scroll, window.scrollUntil, input.typeText, input.pasteText, input.pressKeys, input.holdKeys, input.performKeyboardInputs, input.getPointerPosition, input.moveMouse, input.scrollPoint, input.clickPoint, input.dragMouse, accessibility.focusText, application.activate, permission.probe, overlay.outline, overlay.cursor, overlay.status, overlay.captureFrame, overlay.clickTarget, media.getNowPlaying, media.play, media.pause, media.togglePlayback, media.skipToNextTrack, media.skipToPreviousTrack, scan.frame, scan.coverage. inputs holds argument values keyed by catalog input keys; target selects app, window, or display; dry_run validates most commands without acting (application.activate is an exception and still activates). Prefer a dedicated auv_* tool when one exists, and run auv_doctor on permission errors.'

const HELP_DESCRIPTION =
  'Show the AUV command catalog. Without command_id it lists every command id with a one-line description; with command_id it returns that command description, required and optional arguments, target support, and examples. Call it before auv_invoke to check exact ids and input keys. This tool reads the bundled catalog only and never runs AUV.'

/** All eleven tool definitions, created fresh on each call. */
export function createTools() {
  return [
    {
      name: 'auv_doctor',
      description: DOCTOR_DESCRIPTION,
      parameters: objectSchema({}),
      output: {
        schema: {},
        render(_args, value) {
          const report = objectArgs(value)
          const allOk = report.all_ok === true
          const lines = [allOk ? 'AUV doctor: all checks passed, AUV is ready.' : 'AUV doctor: AUV is not fully ready.']
          for (const key of ['platform', 'accessibility', 'screen_recording_preflight', 'screen_capture_kit', 'screen_capture_kit_error']) {
            if (report[key] !== undefined && report[key] !== null) lines.push(`${key}: ${String(report[key])}`)
          }
          if (typeof report.recommendation === 'string' && report.recommendation !== '') {
            lines.push(`recommendation: ${report.recommendation}`)
          }
          if (!allOk) {
            lines.push(
              'To fix: open System Settings → Privacy & Security, enable DeepSeek Harness (macOS 27+: "Device Control and Data Access"; older macOS: Accessibility + Screen Recording), restart the app, then run auv_doctor again.',
            )
          }
          return renderResult(lines, value, { jsonLimit: 8_000 })
        },
      },
      async execute(_rawArgs, exec) {
        return await runAuvDoctorWithSdkFallback({ signal: exec?.signal, timeoutMs: TOOL_TIMEOUT_MS })
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_screenshot',
      description: SCREENSHOT_DESCRIPTION,
      parameters: objectSchema(
        {
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
          display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
          region: REGION_SCHEMA,
        },
      ),
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
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.screenshot(rawArgs, exec, TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const windowId = optionalString(args, 'window_id')
        const applicationId = optionalString(args, 'application_id')
        const displayId = optionalString(args, 'display_id')
        const region = optionalRegion(args)

        const selected = [windowId, applicationId, displayId, region === undefined ? undefined : 'region'].filter((entry) => entry !== undefined)
        if (selected.length > 1) {
          throw new Error('Pass only one of window_id, application_id, display_id, or region to auv_screenshot.')
        }

        let receipt
        const warnings = []
        if (windowId !== undefined) {
          const resolved = await resolveWindow(windowId, signal)
          warnings.push(...resolved.warnings)
          const command = (await getCatalogCommand('window.capture')).command
          const inputs = withWindowTitle(command, {}, resolved.title)
          const built = await buildInvoke('window.capture', inputs, { target: resolved.target })
          warnings.push(...built.warnings)
          receipt = await runAuv({ commandId: 'window.capture', argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
        } else if (applicationId !== undefined) {
          warnings.push("Capturing the application's main visible window; pass window_id to choose a specific window.")
          const built = await buildInvoke('window.capture', {}, { target: `app:${applicationId}` })
          warnings.push(...built.warnings)
          receipt = await runAuv({ commandId: 'window.capture', argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
        } else if (displayId !== undefined) {
          if (region !== undefined) throw new Error('Pass either display_id or region to auv_screenshot, not both.')
          const displayRegion = await resolveDisplayRegion(displayId, signal)
          const command = (await getCatalogCommand('display.captureRegion')).command
          const inputs = regionInputs(command, displayRegion)
          const built = await buildInvoke('display.captureRegion', inputs)
          warnings.push(...built.warnings)
          receipt = await runAuv({ commandId: 'display.captureRegion', argv: built.args, signal, timeoutMs: TOOL_TIMEOUT_MS })
        } else if (region !== undefined) {
          const command = (await getCatalogCommand('display.captureRegion')).command
          const inputs = regionInputs(command, region)
          const built = await buildInvoke('display.captureRegion', inputs)
          warnings.push(...built.warnings)
          receipt = await runAuv({ commandId: 'display.captureRegion', argv: built.args, signal, timeoutMs: TOOL_TIMEOUT_MS })
        } else {
          const built = await buildInvoke('display.capture', {})
          warnings.push(...built.warnings)
          receipt = await runAuv({ commandId: 'display.capture', argv: built.args, signal, timeoutMs: TOOL_TIMEOUT_MS })
        }

        return screenshotValue(receipt, warnings)
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
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.ocr(rawArgs, exec, SLOW_TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
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

        const windowed = windowId !== undefined || applicationId !== undefined
        const commandId = windowed ? (wait ? 'window.waitForText' : 'window.findText') : wait ? 'display.waitForText' : 'display.findText'
        const command = (await getCatalogCommand(commandId)).command
        const warnings = []
        let target
        let inputs = { [positionalKey(command, 0)]: text }
        if (windowId !== undefined) {
          const resolved = await resolveWindow(windowId, signal)
          warnings.push(...resolved.warnings)
          target = resolved.target
          inputs = withWindowTitle(command, inputs, resolved.title)
        } else if (applicationId !== undefined) {
          target = `app:${applicationId}`
        }
        if (wait && timeoutMs !== undefined) {
          inputs = { ...inputs, [flagKey(command, '--timeout-ms')]: timeoutMs }
        }
        const built = await buildInvoke(commandId, inputs, { target })
        warnings.push(...built.warnings)

        const runnerTimeoutMs = wait ? clampTimeout((timeoutMs ?? 10_000) + 30_000) : TOOL_TIMEOUT_MS
        const receipt = await runAuv({
          commandId,
          argv: built.args,
          target: built.target,
          signal,
          timeoutMs: Math.min(SLOW_TOOL_TIMEOUT_MS, runnerTimeoutMs),
        })
        return {
          ...receiptMeta(receipt),
          result: receipt?.result ?? null,
          warnings,
          timed_out: receipt?.result?.timed_out === true,
        }
      },
      timeoutMs: SLOW_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_click',
      description: CLICK_DESCRIPTION,
      parameters: objectSchema(
        {
          text: stringProperty('Visible text to locate with OCR and click. Cannot be combined with x/y.'),
          x: numberProperty('Click X coordinate. Requires y; cannot be combined with text.'),
          y: numberProperty('Click Y coordinate. Requires x; cannot be combined with text.'),
          window_id: stringProperty(WINDOW_ID_DESCRIPTION),
          application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
          display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
          button: enumProperty('Mouse button for x/y clicks; defaults to left.', ['left', 'right', 'middle']),
          within: WITHIN_SCHEMA,
        },
      ),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const target = typeof outcome.target === 'string' && outcome.target !== '' ? ` via ${outcome.target}` : ''
          const lines = [`Clicked${target} (${outcome.command_id ?? 'click'}).`]
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.click(rawArgs, exec, SLOW_TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const text = optionalString(args, 'text')
        const x = optionalNumber(args, 'x')
        const y = optionalNumber(args, 'y')
        const windowId = optionalString(args, 'window_id')
        const applicationId = optionalString(args, 'application_id')
        const displayId = optionalString(args, 'display_id')
        const button = optionalEnum(args, 'button', ['left', 'right', 'middle'])
        const within = optionalObject(args, 'within')
        if (windowId !== undefined && applicationId !== undefined) {
          throw new Error('Pass only one of window_id or application_id to auv_click.')
        }

        const warnings = []
        if (text !== undefined) {
          if (x !== undefined || y !== undefined) throw new Error('Pass either "text" or both "x" and "y" to auv_click, not both forms.')
          if (button !== undefined && button !== 'left') throw new Error('button applies only to x/y clicks; OCR text clicks use the left button.')
          if (displayId !== undefined) throw new Error('display_id cannot be used with OCR text clicks. Omit it, or pass x and y for a display click.')
          if (within !== undefined && (windowId !== undefined || applicationId !== undefined)) {
            throw new Error('within is only supported for screen-wide OCR clicks; omit window_id and application_id when using within.')
          }
          const windowed = windowId !== undefined || applicationId !== undefined
          const commandId = windowed ? 'window.clickText' : 'display.clickText'
          const command = (await getCatalogCommand(commandId)).command
          let inputs = { [positionalKey(command, 0)]: text }
          let target
          if (windowId !== undefined) {
            const resolved = await resolveWindow(windowId, signal)
            warnings.push(...resolved.warnings)
            target = resolved.target
            inputs = withWindowTitle(command, inputs, resolved.title)
          } else if (applicationId !== undefined) {
            target = `app:${applicationId}`
          }
          if (within !== undefined) {
            const fence = formatFence(within)
            inputs = { ...inputs, [flagKey(command, '--within')]: fence }
          }
          const built = await buildInvoke(commandId, inputs, { target })
          warnings.push(...built.warnings)
          const receipt = await runAuv({ commandId, argv: built.args, target: built.target, signal, timeoutMs: SLOW_TOOL_TIMEOUT_MS })
          return { ...receiptMeta(receipt), target: built.target ?? null, result: receipt?.result ?? null, warnings }
        }

        if (x === undefined || y === undefined) {
          throw new Error('auv_click requires either "text" or both "x" and "y".')
        }
        if (within !== undefined) throw new Error('within applies only to OCR text clicks; omit it for x/y clicks.')
        if (displayId !== undefined && windowId !== undefined) throw new Error('Pass only one of window_id or display_id to auv_click.')
        const target = windowId !== undefined ? `window:${windowId}` : applicationId !== undefined ? `app:${applicationId}` : displayId !== undefined ? `display:${displayId}` : undefined
        const command = (await getCatalogCommand('input.clickPoint')).command
        let inputs = {
          [positionalKey(command, 0)]: x,
          [positionalKey(command, 1)]: y,
        }
        if (button !== undefined) inputs = { ...inputs, [flagKey(command, '--button')]: button }
        const built = await buildInvoke('input.clickPoint', inputs, { target })
        warnings.push(...built.warnings)
        const receipt = await runAuv({ commandId: 'input.clickPoint', argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
        return { ...receiptMeta(receipt), target: built.target ?? null, result: receipt?.result ?? null, warnings }
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
        },
        ['text'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const lines = [`Text delivered (${outcome.command_id ?? 'input'}).`]
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.type(rawArgs, exec, TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const text = requiredString(args, 'text')
        const mode = optionalEnum(args, 'mode', ['type', 'paste']) ?? 'type'
        const policy = optionalEnum(args, 'policy', ['background-only', 'background-preferred', 'foreground-preferred'])
        const windowId = optionalString(args, 'window_id')
        const applicationId = optionalString(args, 'application_id')
        if (windowId !== undefined && applicationId !== undefined) {
          throw new Error('Pass only one of window_id or application_id to auv_type.')
        }
        const commandId = mode === 'paste' ? 'input.pasteText' : 'input.typeText'
        const command = (await getCatalogCommand(commandId)).command
        let inputs = { [positionalKey(command, 0)]: text }
        if (policy !== undefined) inputs = { ...inputs, [flagKey(command, '--input-policy')]: policy }
        const target = windowId !== undefined ? `window:${windowId}` : applicationId !== undefined ? `app:${applicationId}` : undefined
        const built = await buildInvoke(commandId, inputs, { target })
        const receipt = await runAuv({ commandId, argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
        return { ...receiptMeta(receipt), target: built.target ?? null, result: receipt?.result ?? null, warnings: built.warnings }
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
        },
        ['keys'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const lines = [`Keys pressed (${outcome.command_id ?? 'input.pressKeys'}).`]
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.keys(rawArgs, exec, TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const rawKeys = args.keys
        const keys = Array.isArray(rawKeys) ? rawKeys.filter((key) => typeof key === 'string' && key !== '') : []
        if (keys.length === 0) throw new Error('auv_keys requires "keys" as a non-empty array of key names, for example ["ctrl","l"].')
        const repeat = optionalInteger(args, 'repeat')
        if (repeat !== undefined && (repeat < 1 || repeat > 255)) throw new Error('repeat must be between 1 and 255.')
        const interval = optionalInteger(args, 'interval_ms')
        if (interval !== undefined && interval < 1) throw new Error('interval_ms must be a positive integer.')
        if (repeat === undefined || repeat <= 1) {
          if (interval !== undefined) throw new Error('interval_ms is only valid with repeat greater than 1.')
        }
        const windowId = optionalString(args, 'window_id')
        const applicationId = optionalString(args, 'application_id')
        if (windowId !== undefined && applicationId !== undefined) {
          throw new Error('Pass only one of window_id or application_id to auv_keys.')
        }
        const command = (await getCatalogCommand('input.pressKeys')).command
        let inputs = { [positionalKey(command, 0)]: keys }
        if (repeat !== undefined && repeat > 1) {
          inputs = {
            ...inputs,
            [flagKey(command, '--count')]: repeat,
            [flagKey(command, '--interval-ms')]: interval ?? 50,
          }
        }
        const target = windowId !== undefined ? `window:${windowId}` : applicationId !== undefined ? `app:${applicationId}` : undefined
        const built = await buildInvoke('input.pressKeys', inputs, { target })
        const receipt = await runAuv({ commandId: 'input.pressKeys', argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
        return { ...receiptMeta(receipt), target: built.target ?? null, result: receipt?.result ?? null, warnings: built.warnings }
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
        },
        ['dy'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const lines = [`Scrolled (${outcome.command_id ?? 'scroll'}).`]
          lines.push(warningsLine(outcome.warnings))
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.scroll(rawArgs, exec, TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const dy = optionalNumber(args, 'dy')
        if (dy === undefined) throw new Error('auv_scroll requires "dy", the vertical delta in logical pixels (positive scrolls down).')
        const dx = optionalNumber(args, 'dx')
        const windowId = optionalString(args, 'window_id')
        const x = optionalNumber(args, 'x')
        const y = optionalNumber(args, 'y')
        const warnings = []

        if (windowId !== undefined) {
          let pointX = x
          let pointY = y
          if (pointX === undefined || pointY === undefined) {
            const resolved = await resolveWindow(windowId, signal)
            warnings.push(...resolved.warnings)
            const size = resolved.window?.frame?.size ?? {}
            const width = Number(size.width)
            const height = Number(size.height)
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
              throw new Error(`AUV could not read the frame of window "${windowId}"; pass window-local x and y explicitly.`)
            }
            if (pointX === undefined) pointX = Math.round(width / 2)
            if (pointY === undefined) pointY = Math.round(height / 2)
          }
          const command = (await getCatalogCommand('window.scroll')).command
          let inputs = {
            [positionalKey(command, 0)]: pointX,
            [positionalKey(command, 1)]: pointY,
            [flagKey(command, '--dy')]: dy,
          }
          if (dx !== undefined) inputs = { ...inputs, [flagKey(command, '--dx')]: dx }
          const built = await buildInvoke('window.scroll', inputs, { target: `window:${windowId}` })
          warnings.push(...built.warnings)
          const receipt = await runAuv({ commandId: 'window.scroll', argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
          return { ...receiptMeta(receipt), result: receipt?.result ?? null, warnings }
        }

        if (x === undefined || y === undefined) {
          throw new Error('auv_scroll requires "window_id", or both "x" and "y" screen coordinates. On macOS AUV cannot scroll at a raw screen point, so prefer window_id.')
        }
        if (process.platform === 'darwin') {
          throw new Error(
            'macOS cannot scroll at a screen point: AUV\'s input.scrollPoint is available only on Linux and Windows. Pass window_id (and optionally window-local x and y) so the scroll goes through window.scroll.',
          )
        }
        const command = (await getCatalogCommand('input.scrollPoint')).command
        const inputs = {
          [positionalKey(command, 0)]: x,
          [positionalKey(command, 1)]: y,
          [positionalKey(command, 2)]: dx ?? 0,
          [positionalKey(command, 3)]: dy,
        }
        const built = await buildInvoke('input.scrollPoint', inputs)
        warnings.push(...built.warnings)
        let receipt
        try {
          receipt = await runAuv({ commandId: 'input.scrollPoint', argv: built.args, signal, timeoutMs: TOOL_TIMEOUT_MS })
        } catch (error) {
          throw withHint(
            error,
            'On macOS AUV cannot scroll at a screen point. Pass window_id (and optionally window-local x/y) to scroll inside a window instead.',
          )
        }
        return { ...receiptMeta(receipt), result: receipt?.result ?? null, warnings }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
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
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.windows(rawArgs, exec, TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const includeMinimized = args.include_minimized === true
        const includeOtherDesktops = args.include_other_desktops === true
        const command = (await getCatalogCommand('window.list')).command
        const inputs = {}
        if (!includeMinimized) inputs[flagKey(command, '--exclude-minimized')] = true
        if (!includeOtherDesktops) inputs[flagKey(command, '--exclude-other-desktops')] = true
        const built = await buildInvoke('window.list', inputs)
        const receipt = await runAuv({ commandId: 'window.list', argv: built.args, signal, timeoutMs: TOOL_TIMEOUT_MS })
        const windows = Array.isArray(receipt?.result) ? receipt.result : []
        return { ...receiptMeta(receipt), windows, warnings: built.warnings }
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
        const sdk = await activeSdkTransport()
        if (sdk !== null) return await sdk.activate(rawArgs, exec, TOOL_TIMEOUT_MS)
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const applicationId = requiredString(args, 'application_id')
        const built = await buildInvoke('application.activate', {}, { target: `app:${applicationId}` })
        const receipt = await runAuv({ commandId: 'application.activate', argv: built.args, target: built.target, signal, timeoutMs: TOOL_TIMEOUT_MS })
        return { ...receiptMeta(receipt), target: built.target ?? null, result: receipt?.result ?? null, warnings: built.warnings }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_invoke',
      description: INVOKE_DESCRIPTION,
      parameters: objectSchema(
        {
          command_id: stringProperty('AUV command id from auv_help, for example "display.list" or "window.get".'),
          inputs: {
            type: 'object',
            description:
              'Argument values keyed by the catalog input keys shown by auv_help, for example {"text":"Settings"} or {"x":10,"y":20}. Values may be strings, numbers, booleans, or arrays of strings.',
          },
          target: TARGET_SCHEMA,
          dry_run: booleanProperty('Validate the command and its arguments before running it. Not side-effect free for every command: application.activate still activates in dry-run.'),
        },
        ['command_id'],
      ),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const lines = [`Ran ${outcome.command_id ?? 'AUV command'} (${outcome.status ?? 'unknown status'}).`]
          lines.push(warningsLine(outcome.warnings))
          const artifacts = Array.isArray(outcome.artifacts) ? outcome.artifacts : []
          for (const artifact of artifacts) {
            if (typeof artifact?.file_path === 'string' && artifact.file_path !== '') {
              lines.push(`artifact_path: ${artifact.file_path}${artifact.content_type ? ` (${artifact.content_type})` : ''}`)
            }
          }
          if (artifacts.some((artifact) => typeof artifact?.content_type === 'string' && artifact.content_type.startsWith('image/'))) {
            lines.push('Call read_image with an image artifact_path to view it.')
          }
          return renderResult(lines, value)
        },
      },
      async execute(rawArgs, exec) {
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        const commandId = requiredString(args, 'command_id')
        const inputs = optionalObject(args, 'inputs') ?? {}
        const targetInput = optionalObject(args, 'target')
        const dryRun = args.dry_run === true

        const { catalog, command } = await getCatalogCommand(commandId)
        let target
        if (targetInput !== undefined) {
          const applicationId = optionalString(targetInput, 'application_id')
          const windowId = optionalString(targetInput, 'window_id')
          const displayId = optionalString(targetInput, 'display_id')
          const selected = [applicationId, windowId, displayId].filter((entry) => entry !== undefined)
          if (selected.length > 1) throw new Error('target accepts only one of application_id, window_id, or display_id.')
          if (selected.length === 0) throw new Error('target was provided but names no application_id, window_id, or display_id.')
          target = typeof catalog.formatTarget === 'function' ? await catalog.formatTarget(targetInput) : formatTargetFallback(targetInput)
          if (typeof target !== 'string' || target === '') target = undefined
        }

        const policy = command?.target?.policy
        if (policy === 'forbidden' && target !== undefined) {
          throw new Error(`AUV command "${commandId}" does not accept a target. Omit the target parameter.`)
        }
        if (policy === 'required' && target === undefined) {
          throw new Error(`AUV command "${commandId}" requires a target: pass target.application_id, target.window_id, or target.display_id.`)
        }
        if (policy !== 'forbidden' && target !== undefined) {
          const accepted = Array.isArray(command?.target?.accepted_types) ? command.target.accepted_types : []
          const type = targetTypeName(target)
          if (accepted.length > 0 && !accepted.includes(type)) {
            throw new Error(`AUV command "${commandId}" does not accept a ${type} target; accepted target types: ${accepted.join(', ')}.`)
          }
        }

        const built = await buildInvoke(commandId, inputs, { target })
        const receipt = await runAuvWithSdkFallback({
          commandId,
          argv: built.args,
          target: built.target,
          dryRun,
          signal,
          timeoutMs: SLOW_TOOL_TIMEOUT_MS,
        })
        return {
          ...receiptMeta(receipt),
          result: receipt?.result ?? null,
          artifacts: Array.isArray(receipt?.artifacts) ? receipt.artifacts : [],
          warnings: [...built.warnings],
        }
      },
      timeoutMs: SLOW_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },

    {
      name: 'auv_help',
      description: HELP_DESCRIPTION,
      parameters: objectSchema({ command_id: stringProperty('Optional command id; omit to list every command.') }),
      output: {
        schema: {},
        render(_args, value) {
          const outcome = objectArgs(value)
          const lines = []
          if (outcome.mode === 'summary') {
            const count = typeof outcome.count === 'number' ? ` (${outcome.count} commands)` : ''
            lines.push(`AUV command catalog${count}. Use one of these ids as auv_invoke.command_id.`)
          } else if (outcome.mode === 'command') {
            lines.push(`AUV command details: ${outcome.command_id ?? 'unknown'}.`)
          }
          if (typeof outcome.text === 'string' && outcome.text !== '') lines.push(outcome.text)
          return textBlock(lines.join('\n'))
        },
      },
      async execute(rawArgs, exec) {
        const args = objectArgs(rawArgs)
        const signal = exec?.signal
        if (signal?.aborted === true) throw new Error('AUV help call was aborted.')
        const commandId = optionalString(args, 'command_id')
        const catalog = await getCatalogModule()
        if (commandId !== undefined) {
          if (typeof catalog.getCommand === 'function') {
            const command = await catalog.getCommand(commandId)
            if (command === undefined || command === null) {
              throw new Error(`Unknown AUV command "${commandId}". Call auv_help without command_id to list every command id.`)
            }
          }
          const detail = typeof catalog.commandHelpText === 'function' ? await catalog.commandHelpText(commandId) : ''
          return { mode: 'command', command_id: commandId, text: typeof detail === 'string' ? detail : boundedJson(detail) }
        }
        const summary = typeof catalog.summaryText === 'function' ? await catalog.summaryText() : ''
        const commandCount = Array.isArray(catalog.CATALOG?.commands) ? catalog.CATALOG.commands.length : null
        return { mode: 'summary', count: commandCount, text: typeof summary === 'string' ? summary : boundedJson(summary) }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
    },
  ]
}

// ---------------------------------------------------------------------------
// Remaining local helpers used by execute bodies
// ---------------------------------------------------------------------------

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

function regionInputs(command, region) {
  return {
    [flagKey(command, '--x')]: region.x,
    [flagKey(command, '--y')]: region.y,
    [flagKey(command, '--width')]: region.width,
    [flagKey(command, '--height')]: region.height,
  }
}

function formatFence(within) {
  const values = ['left', 'top', 'right', 'bottom'].map((key) => {
    const value = Number(within[key])
    if (!Number.isFinite(value)) throw new Error(`within.${key} must be a finite number.`)
    return value
  })
  return values.join(',')
}

function screenshotValue(receipt, warnings) {
  const result = receipt?.result ?? null
  const capture = result?.capture ?? null
  const pixels = capture?.pixel_dimensions ?? {}
  const artifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
  const dimension = (value) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value))
  return {
    ...receiptMeta(receipt),
    artifact_path: artifactPathOf(receipt),
    content_type: typeof artifacts[0]?.content_type === 'string' ? artifacts[0].content_type : null,
    width: dimension(pixels.width),
    height: dimension(pixels.height),
    result,
    artifacts,
    warnings,
  }
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

function formatTargetFallback(target) {
  const applicationId = typeof target?.application_id === 'string' ? target.application_id.trim() : ''
  const windowId = typeof target?.window_id === 'string' ? target.window_id.trim() : ''
  const displayId = typeof target?.display_id === 'string' ? target.display_id.trim() : ''
  if (applicationId !== '') return `app:${applicationId}`
  if (windowId !== '') return `window:${windowId}`
  if (displayId !== '') return `display:${displayId}`
  return undefined
}

/**
 * Map a formatted `--target` string to the catalog's target type vocabulary:
 * `app:*` is called "application" in catalog accepted_types, the others match.
 */
export function targetTypeName(formattedTarget) {
  const prefix = typeof formattedTarget === 'string' && formattedTarget.includes(':') ? formattedTarget.slice(0, formattedTarget.indexOf(':')) : ''
  return prefix === 'app' ? 'application' : prefix
}
