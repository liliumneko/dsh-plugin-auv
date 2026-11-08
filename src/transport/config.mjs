/**
 * Transport configuration for @local/dsh-auv.
 *
 * The plugin can talk to AUV through two transports:
 *
 *   - `sdk`  — `@auv-js/sdk`: one app-owned `auv serve` daemon plus a typed
 *              gRPC client, lazy-started by this plugin (the recommended stack).
 *   - `cli`  — the historical `auv invoke` CLI child process per call.
 *
 * `AUV_DSH_TRANSPORT` selects the transport:
 *
 *   - `auto` (default): try the SDK first and permanently fall back to the CLI
 *     for the rest of the process when the daemon cannot start.
 *   - `sdk`: require the SDK; start errors are surfaced instead of falling back.
 *   - `cli`: never start the SDK daemon (the CLI child-process path only).
 *
 * Plain ESM, Node builtins only, no side effects: `resolveTransportConfig()`
 * reads the environment on every call so tests and Host reloads pick up changes.
 */

/** Supported `AUV_DSH_TRANSPORT` values, in documentation order. */
export const TRANSPORT_MODES = ['auto', 'sdk', 'cli']

/** The mode used when `AUV_DSH_TRANSPORT` is unset or invalid. */
export const DEFAULT_TRANSPORT_MODE = 'auto'

/**
 * Parse a raw `AUV_DSH_TRANSPORT` value.
 *
 * @param {unknown} value raw environment value
 * @returns {{mode: 'auto'|'sdk'|'cli', raw: string|null, explicit: boolean, invalid: string|null, warning: string|null}}
 */
export function parseTransportMode(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    return { mode: DEFAULT_TRANSPORT_MODE, raw: null, explicit: false, invalid: null, warning: null }
  }
  const normalized = raw.toLowerCase()
  if (TRANSPORT_MODES.includes(normalized)) {
    return { mode: normalized, raw, explicit: true, invalid: null, warning: null }
  }
  return {
    mode: DEFAULT_TRANSPORT_MODE,
    raw,
    explicit: false,
    invalid: raw,
    warning: `Ignoring unknown AUV_DSH_TRANSPORT="${raw}" (expected one of ${TRANSPORT_MODES.join(', ')}); using "${DEFAULT_TRANSPORT_MODE}".`,
  }
}

/**
 * Resolve the effective transport configuration from an environment object.
 *
 * @param {NodeJS.ProcessEnv} [env] environment to read; defaults to process.env
 * @returns {{mode: 'auto'|'sdk'|'cli', raw: string|null, explicit: boolean, invalid: string|null, warning: string|null,
 *            sdkPreferred: boolean, cliForced: boolean}}
 */
export function resolveTransportConfig(env = process.env) {
  const parsed = parseTransportMode(env?.AUV_DSH_TRANSPORT)
  return {
    ...parsed,
    sdkPreferred: parsed.mode !== 'cli',
    cliForced: parsed.mode === 'cli',
  }
}

/** Whether the SDK transport is allowed to start under this configuration. */
export function sdkTransportEnabled(env = process.env) {
  return resolveTransportConfig(env).mode !== 'cli'
}
