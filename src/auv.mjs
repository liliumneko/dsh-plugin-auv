/**
 * AUV binary discovery, process runner, and receipt helpers for @local/dsh-auv.
 *
 * Plain ESM, Node builtins only. Every auv invocation is asynchronous, kills the
 * child process on abort, and enforces a bounded timeout and output buffer so a
 * hung desktop tool can never block the DSH Host event loop indefinitely.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { clamp } from 'es-toolkit'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/** Default per-call timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** Minimum accepted per-call timeout. */
export const MIN_TIMEOUT_MS = 1_000
/** Maximum accepted per-call timeout. */
export const MAX_TIMEOUT_MS = 300_000

const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024
const STDERR_TAIL_CHARS = 64 * 1024
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

let cachedBinary

/**
 * Actionable installation guidance for a missing AUV CLI.
 *
 * The bundle is only the DeepSeek Harness bridge: the `auv` executable is an
 * external prerequisite, so every entry point that can discover the binary must
 * fail with install instructions instead of a bare "not found".
 */
export const AUV_INSTALL_GUIDANCE = [
  'This DeepSeek Harness plugin is only the bridge: it needs the AUV CLI installed and reachable first.',
  'Install AUV (https://github.com/moeru-ai/auv):',
  '  macOS (Homebrew):   brew install moeru-ai/tap/auv',
  '  macOS / Linux:      curl -fsSL https://auv.moeru.ai/install.sh | sh',
  '  Windows (Scoop):    scoop bucket add auv https://github.com/moeru-ai/auv ; scoop install auv/auv',
  '  proto:              proto plugin add auv "https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml" --to global ; proto install auv latest --config-mode global --pin global',
  'Then verify with `auv --version`, grant macOS permissions (see the plugin README), restart DeepSeek Harness, and run auv_doctor.',
  'If AUV is installed outside PATH, set AUV_BIN to the absolute auv executable path.',
].join('\n')

/** Error raised for every failed AUV discovery, invocation, or receipt. */
export class AuvError extends Error {
  /**
   * @param {string} message human-readable failure summary
   * @param {object} [details] structured diagnostics
   * @param {string} [details.code] stable error code
   * @param {object} [details.receipt] failed receipt, when one was printed
   * @param {string} [details.stderr] captured stderr tail
   * @param {string} [details.stdout] captured stdout tail
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'AuvError'
    this.code = details.code ?? 'AUV_ERROR'
    this.receipt = details.receipt
    this.stderr = details.stderr
    this.stdout = details.stdout
  }
}

/** Read a boolean-ish environment flag. */
export function envFlag(name) {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes'
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

/** Store root passed to every `auv invoke`; keeps artifact paths stable. */
export function defaultStoreRoot() {
  const override = (process.env.AUV_DSH_STORE_ROOT ?? '').trim()
  if (override !== '') return override
  const dshHome = (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'auv', 'runs')
}

/** Child environment: inherited, with a GUI-safe PATH augmentation. */
export function childEnvironment() {
  const inherited = process.env.PATH ?? ''
  const prefix = inherited === '' ? EXTRA_PATH_DIRS.join(path.delimiter) : `${inherited}${path.delimiter}${EXTRA_PATH_DIRS.join(path.delimiter)}`
  return { ...process.env, PATH: prefix }
}

/** Keep the last `limit` characters of a diagnostic string. */
function tail(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text ?? ''
  return `…${text.slice(text.length - limit)}`
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

/** First artifact file path in a receipt, or null. */
export function artifactPathOf(receipt) {
  const artifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
  const first = artifacts[0]
  return typeof first?.file_path === 'string' && first.file_path !== '' ? first.file_path : null
}

/** Describe an argv without leaking giant values. */
function describeCommand(binary, args) {
  const rendered = args.map((argument) => (String(argument).length > 120 ? `${String(argument).slice(0, 117)}…` : String(argument)))
  return `${path.basename(binary)} ${rendered.join(' ')}`
}

/** Build the AUV failure error for a failed receipt. */
function receiptError(receipt, stderr, args, binary) {
  const details = receipt?.failure_details ?? {}
  const summary = typeof receipt?.failure === 'string' && receipt.failure !== '' ? receipt.failure : (typeof details.message === 'string' ? details.message : 'unknown failure')
  const code = typeof details.code === 'string' ? details.code : 'AUV_COMMAND_FAILED'
  let message = `AUV command "${receipt?.command_id ?? 'unknown'}" failed: ${summary} (${code})`
  if (typeof details.message === 'string' && details.message !== '' && details.message !== summary) {
    message += `\n${details.message}`
  }
  message += `\nCommand: ${describeCommand(binary, args)}`
  const hint = permissionHint(`${summary}\n${details.message ?? ''}`)
  if (hint !== undefined) message += `\n${hint}`
  const stderrTail = tail(stderr, 2_000)
  if (stderrTail !== '') message += `\nstderr: ${stderrTail}`
  return new AuvError(message, { code, receipt, stderr, stdout: '' })
}

/** Build the error for a non-JSON CLI failure (e.g. a clap argument error). */
function cliError(code, signalName, stdout, stderr, binary, args) {
  const stderrTail = tail(stderr, 4_000)
  const stdoutTail = tail(stdout, 2_000)
  let message
  if (code === 0 && stdout.trim() === '' && stderrTail === '') {
    message = 'AUV exited successfully but printed no JSON output (was --json passed?)'
  } else {
    message = `AUV exited with code ${code ?? 'unknown'}${signalName === null || signalName === undefined ? '' : ` (signal ${signalName})`}`
  }
  message += `\nCommand: ${describeCommand(binary, args)}`
  if (stderrTail !== '') message += `\nstderr: ${stderrTail}`
  if (stdoutTail !== '') message += `\nstdout: ${stdoutTail}`
  const hint = permissionHint(`${stderrTail}\n${stdoutTail}`)
  if (hint !== undefined) message += `\n${hint}`
  return new AuvError(message, { code: 'AUV_CLI_ERROR', stderr, stdout })
}

/**
 * Spawn auv, enforce timeout/abort, capture bounded output, and parse the JSON
 * printed on stdout. Never rejects with a non-AuvError.
 */
function spawnAuv(binary, args, options) {
  const { timeoutMs, signal } = options
  const command = describeCommand(binary, args)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(), windowsHide: true })
    } catch (error) {
      reject(new AuvError(`Failed to start AUV (${binary}): ${error instanceof Error ? error.message : String(error)}`, { code: 'AUV_SPAWN_ERROR' }))
      return
    }

    let stdout = ''
    let stdoutTruncated = false
    let stderr = ''
    let settled = false
    let timer

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    const settle = (handler, value) => {
      if (settled) return
      settled = true
      cleanup()
      handler(value)
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* the child may already have exited */
      }
    }
    const abort = () => {
      kill()
      settle(reject, new AuvError(`AUV call was aborted.\nCommand: ${command}`, { code: 'ABORTED' }))
    }
    const onAbort = () => abort()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length >= STDOUT_LIMIT_BYTES) {
        stdoutTruncated = true
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr = tail(`${stderr}${chunk}`, STDERR_TAIL_CHARS)
    })
    child.on('error', (error) => {
      settle(reject, new AuvError(`Failed to run AUV (${binary}): ${error instanceof Error ? error.message : String(error)}. Install AUV or set AUV_BIN.`, { code: 'AUV_SPAWN_ERROR', stderr }))
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      const text = stdout.trim()
      if (text !== '' && !stdoutTruncated) {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        if (parsed !== undefined) {
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.status === 'string') {
            if (parsed.status === 'failed') {
              settle(reject, receiptError(parsed, stderr, args, binary))
              return
            }
            settle(resolve, parsed)
            return
          }
          settle(resolve, parsed)
          return
        }
      }
      settle(reject, cliError(code, signalName, stdout, stderr, binary, args))
    })

    if (signal !== undefined) {
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      kill()
      const stderrTail = tail(stderr, 2_000)
      let message = `AUV timed out after ${timeoutMs} ms.\nCommand: ${command}`
      if (stderrTail !== '') message += `\nstderr: ${stderrTail}`
      settle(reject, new AuvError(message, { code: 'AUV_TIMEOUT', stderr }))
    }, timeoutMs)
  })
}

/**
 * Run one AUV command.
 *
 * Invoke mode (`commandId` set) builds:
 *   auv [--no-daemon] invoke <commandId> [--store-root PATH] [--target T]
 *       [--dry-run] [--no-overlay] --json [argv...]
 * Raw mode (`raw: true`) runs `argv` verbatim at the top level, which is how
 * `auv doctor --json` is invoked (doctor rejects `--no-daemon`).
 *
 * @param {object} options
 * @param {string} [options.commandId] invoke command id; omit for raw mode
 * @param {boolean} [options.raw] run argv as a complete top-level command
 * @param {string[]} [options.argv] command arguments
 * @param {string} [options.target] already-formatted target (`app:x`/`window:x`/`display:x`)
 * @param {boolean} [options.dryRun] add --dry-run
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {number} [options.timeoutMs] per-call timeout (clamped 1s..300s)
 * @param {string} [options.storeRoot] override the persistent run store root
 * @param {boolean} [options.noDaemon] force --no-daemon (defaults to AUV_DSH_NO_DAEMON)
 * @param {boolean} [options.noOverlay] default true unless AUV_DSH_OVERLAY is set
 * @returns {Promise<object>} parsed JSON (a receipt, or the doctor report)
 */
export async function runAuv(options = {}) {
  const {
    commandId,
    raw = false,
    argv = [],
    target,
    dryRun = false,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    storeRoot = defaultStoreRoot(),
    noDaemon = envFlag('AUV_DSH_NO_DAEMON'),
    noOverlay = !envFlag('AUV_DSH_OVERLAY'),
  } = options

  const binary = resolveAuvBinary()
  const effectiveTimeout = clampTimeout(timeoutMs)

  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new AuvError('AUV argv must be an array of strings.', { code: 'AUV_BAD_ARGV' })
  }

  let args
  if (raw) {
    args = [...argv]
  } else if (typeof commandId === 'string' && commandId !== '') {
    args = []
    if (noDaemon) args.push('--no-daemon')
    args.push('invoke', commandId)
    if (storeRoot !== '' && storeRoot !== undefined && storeRoot !== null) args.push('--store-root', storeRoot)
    if (typeof target === 'string' && target !== '') args.push('--target', target)
    if (dryRun) args.push('--dry-run')
    if (noOverlay) args.push('--no-overlay')
    args.push('--json', ...argv)
  } else {
    throw new AuvError('runAuv requires a commandId or raw: true.', { code: 'AUV_BAD_REQUEST' })
  }

  if (signal !== undefined && signal.aborted) {
    throw new AuvError('AUV call was aborted before it started.', { code: 'ABORTED' })
  }

  return await spawnAuv(binary, args, { timeoutMs: effectiveTimeout, signal })
}

/** Run `auv doctor --json` (never uses --no-daemon; doctor rejects it). */
export async function runAuvDoctor(options = {}) {
  return await runAuv({ raw: true, argv: ['doctor', '--json'], signal: options.signal, timeoutMs: options.timeoutMs })
}
