/**
 * AUV binary discovery, install guidance, and shared error helpers for
 * @local/dsh-auv.
 *
 * The plugin talks to AUV exclusively through `@auv-js/sdk` now: a discoverable
 * daemon (attach) or one started by the plugin (owned). There is no CLI child
 * process per call, so this module deliberately contains no process runner.
 * The `auv` executable is still an external prerequisite for starting an owned
 * daemon, hence `resolveAuvBinary()` and the install guidance below.
 *
 * Plain ESM, Node builtins only.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { clamp } from 'es-toolkit'
import os from 'node:os'
import path from 'node:path'

/** Default per-call timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** Minimum accepted per-call timeout. */
export const MIN_TIMEOUT_MS = 1_000
/** Maximum accepted per-call timeout. */
export const MAX_TIMEOUT_MS = 300_000

const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

let cachedBinary

/**
 * Actionable installation guidance for a missing AUV CLI.
 *
 * The bundle is only the DeepSeek Harness bridge: the `auv` executable is an
 * external prerequisite, so every entry point that starts an owned daemon must
 * fail with install instructions instead of a bare "not found". Attaching to an
 * already-running daemon does not need the executable.
 */
export const AUV_INSTALL_GUIDANCE = [
  'This DeepSeek Harness plugin is only the bridge: it needs the AUV CLI installed and reachable first.',
  'Install AUV (https://github.com/moeru-ai/auv):',
  '  macOS (Homebrew):   brew install moeru-ai/tap/auv',
  '  macOS / Linux:      curl -fsSL https://auv.moeru.ai/install.sh | sh',
  '  Windows (Scoop):    scoop bucket add auv https://github.com/moeru-ai/auv ; scoop install auv/auv',
  '  proto:              proto plugin add auv "https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml" --to global ; proto install auv latest --config-mode global --pin global',
  'Then verify with `auv --version`, start a local daemon (`auv serve`) or let the plugin start one, grant macOS permissions (see the plugin README), restart DeepSeek Harness, and run auv_doctor.',
  'If AUV is installed outside PATH, set AUV_BIN to the absolute auv executable path.',
].join('\n')

/** Error raised for every failed AUV discovery, RPC, or transport setup. */
export class AuvError extends Error {
  /**
   * @param {string} message human-readable failure summary
   * @param {object} [details] structured diagnostics
   * @param {string} [details.code] stable error code
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'AuvError'
    this.code = details.code ?? 'AUV_ERROR'
  }
}

/** Clamp a requested timeout into the supported 1s..300s window. */
export function clampTimeout(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS
  return clamp(Math.round(number), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/** Whether a path is an existing executable file. */
function isExecutableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the auv executable once and cache it.
 *
 * Order: AUV_BIN (must exist), then PATH, then common install directories.
 * @returns {string} absolute-ish executable path
 */
export function resolveAuvBinary() {
  if (cachedBinary !== undefined) return cachedBinary

  const configured = (process.env.AUV_BIN ?? '').trim()
  if (configured !== '') {
    if (isExecutableFile(configured)) {
      cachedBinary = configured
      return configured
    }
    throw new AuvError(
      `AUV_BIN is set to "${configured}", but that path is not an executable file. Fix AUV_BIN or install AUV.\n\n${AUV_INSTALL_GUIDANCE}`,
      { code: 'AUV_BIN_INVALID' },
    )
  }

  const directories = []
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry !== '') directories.push(entry)
  }
  for (const extra of [
    ...EXTRA_PATH_DIRS,
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
  ]) {
    directories.push(extra)
  }

  const seen = new Set()
  for (const directory of directories) {
    if (seen.has(directory)) continue
    seen.add(directory)
    const candidate = path.join(directory, 'auv')
    if (isExecutableFile(candidate)) {
      cachedBinary = candidate
      return candidate
    }
  }

  throw new AuvError(
    `AUV was not found on PATH (PATH=${process.env.PATH ?? '<empty>'}).\n\n${AUV_INSTALL_GUIDANCE}`,
    { code: 'AUV_NOT_FOUND' },
  )
}

/** Forget a resolved binary (used by tests and after installing AUV). */
export function resetAuvBinaryCache() {
  cachedBinary = undefined
}

/** Extract a permission-oriented hint from an AUV failure message, if any. */
export function permissionHint(text) {
  if (typeof text !== 'string' || text === '') return undefined
  if (/vision ocr/i.test(text)) {
    return 'Hint: AUV could not run Vision OCR. Confirm Screen Recording is granted to DeepSeek Harness in System Settings → Privacy & Security (macOS 27+: "Device Control and Data Access"), restart the app, then run auv_doctor. Some macOS/AUV combinations still fail with "vision OCR failed: unknownError"; fall back to auv_screenshot + read_image when that happens.'
  }
  if (!/permission|accessibility|screen recording|screen_recording|tcc|not authorized|not permitted|authorization denied/i.test(text)) {
    return undefined
  }
  return 'Hint: run auv_doctor, then grant Accessibility and Screen Recording to DeepSeek Harness in System Settings → Privacy & Security (macOS 27+ merges them under "Device Control and Data Access") and restart the app.'
}
