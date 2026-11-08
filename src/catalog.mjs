/**
 * AUV command catalog helpers for the @local/dsh-auv Host plugin.
 *
 * Pure ESM. The catalog is imported from the generated `catalog-data.mjs`
 * (mirrored from `catalog.json`) so a bundled build has no runtime file reads;
 * there is no auv spawn and no network I/O.
 *
 * Exports:
 *   CATALOG                       parsed catalog object
 *   loadCatalog()                 -> CATALOG
 *   getCommand(id)                -> command object | null
 *   formatTarget(target)          -> "app:<id>" | "window:<id>" | "display:<id>" | null
 *   buildInvokeArgs(cmd, inputs, options?) -> { args, target?, warnings }
 *   summaryText()                 -> compact list of every command id
 *   commandHelpText(id)           -> detailed help text for one command
 *
 * `buildInvokeArgs` input handling:
 *   - `inputs` keys must be catalog `input_key`s (or the reserved `target` key).
 *   - scalar string | finite number | boolean values become argv tokens.
 *   - arrays repeat a `repeated` argument (repeated positionals are flattened;
 *     repeated value options emit the flag once per element).
 *   - `kind: "flag"` arguments are presence-only: emitted only when truthy
 *     (`true` / `"true"` / `"1"`; `false` / `"false"` / `"0"` are omitted).
 *   - missing/unknown/ill-typed inputs throw descriptive Errors.
 *   - a `target` may be supplied as `options.target` or as `inputs.target`
 *     (reserved key) and is returned formatted, never embedded in `args`.
 *   - non-fatal issues are returned in `warnings` for the caller to surface.
 */

import CATALOG from './catalog-data.mjs'

const COMMANDS_BY_ID = new Map(CATALOG.commands.map((command) => [command.id, command]))
const TARGET_KEYS = [
  ['application_id', 'app'],
  ['window_id', 'window'],
  ['display_id', 'display'],
]
const TARGET_TYPES = new Set(['application', 'window', 'display'])

export { CATALOG }

/** Return the parsed catalog object (same instance as CATALOG). */
export function loadCatalog() {
  return CATALOG
}

/** Look up one command by id. Returns null when the id is unknown. */
export function getCommand(id) {
  if (typeof id !== 'string') return null
  return COMMANDS_BY_ID.get(id.trim()) ?? null
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

/**
 * Format a target into AUV's CLI `--target` value.
 *
 * Accepts either an object with exactly one of `application_id`, `window_id`,
 * `display_id` (values may already carry their prefix), or a target string
 * (`com.apple.TextEdit` -> `app:com.apple.TextEdit`, prefixed strings pass
 * through unchanged).
 *
 * Returns null for null/undefined. Throws on ambiguous/empty targets.
 */
export function formatTarget(target) {
  if (target == null) return null

  if (typeof target === 'string') {
    const value = target.trim()
    if (!value) throw new Error('target must be a non-empty string or an object with exactly one of application_id, window_id, display_id')
    return /^(app|window|display):/.test(value) ? value : `app:${value}`
  }

  if (typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('target must be a string or an object with exactly one of application_id, window_id, display_id')
  }

  const present = TARGET_KEYS.filter(([key]) => target[key] != null && String(target[key]).trim() !== '')
  if (present.length === 0) {
    throw new Error('target requires exactly one of application_id, window_id, display_id')
  }
  if (present.length > 1) {
    throw new Error(
      `target requires exactly one of application_id, window_id, display_id (got ${present.map(([key]) => key).join(', ')})`,
    )
  }

  const [key, prefix] = present[0]
  const value = String(target[key]).trim()
  if (/^[a-z]+:/.test(value)) return value
  return `${prefix}:${value}`
}

function targetTypeOf(formattedTarget) {
  const match = /^(app|window|display):/.exec(formattedTarget)
  if (!match) return null
  return match[1] === 'app' ? 'application' : match[1]
}

function targetSummary(target) {
  const types = Array.isArray(target?.accepted_types) ? target.accepted_types : []
  const formatted = types.map((type) => (type === 'application' ? 'app:<application-id>' : `${type}:<id>`)).join(' or ')
  switch (target?.policy) {
    case 'forbidden':
      return 'none allowed (this command forbids --target)'
    case 'required':
      return `required: ${formatted || 'target'}`
    default:
      return `optional: ${formatted || 'target'}`
  }
}

// ---------------------------------------------------------------------------
// argument serialization
// ---------------------------------------------------------------------------

function isMissingInput(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0)
}

function argvValue(value, inputKey) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`input "${inputKey}" must be a finite number`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  throw new Error(`input "${inputKey}" must be a string, number, or boolean`)
}

function argvValueList(value, inputKey) {
  if (!Array.isArray(value)) return [argvValue(value, inputKey)]
  return value.map((item) => argvValue(item, inputKey))
}

function isFlagEnabled(value, inputKey, warnings) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off' || normalized === '') {
      return false
    }
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
    warnings.push(`input "${inputKey}" is a presence flag; interpreted "${value}" as true (pass true/false)`)
    return true
  }
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (value && typeof value === 'object') {
    throw new Error(`input "${inputKey}" is a presence flag; expected boolean, got ${Array.isArray(value) ? 'array' : 'object'}`)
  }
  return Boolean(value)
}

/** Accept MCP-style JSON-encoded arrays ("[\"cmd\",\"l\"]") for repeated inputs. */
function repeatedValues(value, inputKey, warnings) {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        warnings.push(`input "${inputKey}" was a JSON-encoded array string; parsed into ${parsed.length} value(s)`)
        return parsed
      }
    } catch {
      /* fall through and treat as a single token */
    }
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Convert command inputs into `auv invoke <id>` argv tokens.
 *
 * @param {object} command catalog command (from getCommand/CATALOG.commands)
 * @param {object} [inputs] values keyed by catalog `input_key`
 * @param {{target?: object|string}} [options]
 * @returns {{args: string[], target?: string, warnings: string[]}}
 */
export function buildInvokeArgs(command, inputs = {}, options = {}) {
  if (command && typeof command === 'object' && typeof command.id === 'string' && Array.isArray(command.arguments)) {
    // ok
  } else {
    throw new TypeError('buildInvokeArgs requires a catalog command object (see getCommand(id))')
  }
  if (inputs == null) inputs = {}
  if (typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError(`inputs for ${command.id} must be a plain object`)
  }

  const warnings = []
  const arguments_ = command.arguments
  const allowedKeys = new Set(arguments_.map((argument) => argument.input_key))
  allowedKeys.add('target')

  const unknownKeys = Object.keys(inputs).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    const allowed = [...allowedKeys].sort().join(', ')
    throw new Error(`unknown input key(s) for ${command.id}: ${unknownKeys.join(', ')} (allowed: ${allowed})`)
  }

  const args = []
  const missing = []

  for (const argument of arguments_) {
    const value = inputs[argument.input_key]
    if (isMissingInput(value)) {
      if (argument.required) missing.push(argument.input_key)
      continue
    }
    if (argument.kind === 'positional') {
      if (argument.repeated) {
        args.push(...argvValueList(repeatedValues(value, argument.input_key, warnings), argument.input_key).map(String))
      } else {
        if (Array.isArray(value)) {
          throw new Error(`input "${argument.input_key}" is a single positional for ${command.id}; got an array`)
        }
        args.push(argvValue(value, argument.input_key))
      }
    }
  }

  for (const argument of arguments_) {
    if (argument.kind === 'positional') continue
    const value = inputs[argument.input_key]
    if (isMissingInput(value)) {
      if (argument.required) missing.push(argument.input_key)
      continue
    }
    if (argument.kind === 'flag') {
      if (isFlagEnabled(value, argument.input_key, warnings)) args.push(argument.flag)
      continue
    }
    // kind === 'value'
    const values = argument.repeated ? repeatedValues(value, argument.input_key, warnings) : [value]
    for (const item of values) {
      if (Array.isArray(item)) throw new Error(`input "${argument.input_key}" must be scalar values`)
      args.push(argument.flag, argvValue(item, argument.input_key))
    }
  }

  if (missing.length > 0) {
    throw new Error(`missing required input(s) for ${command.id}: ${missing.join(', ')}`)
  }

  const rawTarget = options?.target !== undefined ? options.target : inputs.target
  let target
  if (rawTarget != null) {
    const formatted = formatTarget(rawTarget)
    const policy = command.target?.policy ?? 'forbidden'
    if (policy === 'forbidden') {
      warnings.push(`command ${command.id} does not accept a target; ignoring ${formatted}`)
    } else {
      const type = targetTypeOf(formatted)
      const accepted = Array.isArray(command.target?.accepted_types) ? command.target.accepted_types : []
      if (type && accepted.length > 0 && !accepted.includes(type) && TARGET_TYPES.has(type)) {
        warnings.push(
          `command ${command.id} accepts ${accepted.join('/')} targets, not ${type} (${formatted}); auv will reject it`,
        )
      }
      target = formatted
    }
  } else if (command.target?.policy === 'required') {
    warnings.push(`command ${command.id} requires a target (${targetSummary(command.target)}); pass target`)
  }

  const result = { args, warnings }
  if (target != null) result.target = target
  return result
}

// ---------------------------------------------------------------------------
// help text
// ---------------------------------------------------------------------------

function firstSentence(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  const match = /^.*?[.!?](?=\s|$)/.exec(value)
  return match ? match[0] : value
}

function supportSummary(support, supportNote) {
  const state = (platform) => {
    const value = support?.[platform] ?? 'unknown'
    if (value === 'supported') return 'yes'
    if (value === 'unsupported') return 'no'
    return value
  }
  const note = supportNote?.macos ? ` (macOS: ${supportNote.macos})` : ''
  return `macOS ${state('macos')}${note}; Linux ${state('linux')}; Windows ${state('windows')}`
}

function argumentSignature(argument) {
  const flags = []
  if (argument.kind === 'positional') {
    const token = argument.repeated
      ? `<${argument.value_name ?? 'VALUE'}>...`
      : argument.required
        ? `<${argument.value_name ?? 'VALUE'}>`
        : `[${argument.value_name ?? 'VALUE'}]`
    flags.push(`positional ${token}`)
  } else if (argument.kind === 'value') {
    flags.push(`option ${argument.flag} <${argument.value_name ?? 'VALUE'}>`)
  } else {
    flags.push(`presence flag ${argument.flag}`)
  }
  if (argument.required) flags.push('required')
  else flags.push('optional')
  if (argument.repeated) flags.push('repeatable')
  if (Array.isArray(argument.possible_values) && argument.possible_values.length > 0) {
    flags.push(`values: ${argument.possible_values.join(', ')}`)
  }
  const help = argument.help ? ` — ${argument.help}` : ''
  return `  ${argument.input_key} (${flags.join(', ')})${help}`
}

/** Compact list of every command id plus a one-sentence description. */
export function summaryText() {
  const lines = [`AUV ${CATALOG.auv_version} invoke commands (${CATALOG.commands.length}):`]
  for (const command of CATALOG.commands) {
    lines.push(`- ${command.id} — ${firstSentence(command.description)}`)
  }
  lines.push('')
  lines.push(
    'Call auv_help with command_id for arguments, target rules, platform support, and examples. auv_invoke.command_id must be one of the ids above.',
  )
  return lines.join('\n')
}

/** Detailed help for one command id. Throws for unknown ids. */
export function commandHelpText(id) {
  const command = getCommand(id)
  if (!command) {
    const sample = CATALOG.commands.slice(0, 3).map((entry) => entry.id).join(', ')
    throw new Error(
      `unknown AUV command id "${id}"; call auv_help without command_id to list all ${CATALOG.commands.length} ids (for example: ${sample})`,
    )
  }

  const lines = [`# ${command.id}`, '', String(command.description ?? '').trim()]
  lines.push('', `Target: ${targetSummary(command.target)}`)
  lines.push(`Support: ${supportSummary(command.support, command.support_note)}`)
  if (command.runner_support?.route) lines.push(`Runner route: ${command.runner_support.route}`)
  lines.push('', 'Arguments:')
  if (!command.arguments?.length) {
    lines.push('  (none)')
  } else {
    for (const argument of command.arguments) lines.push(argumentSignature(argument))
  }
  const exampleCall = command.examples?.find((example) => example?.call)?.call
  if (exampleCall) {
    lines.push('', `Example inputs for auv_invoke: ${JSON.stringify(exampleCall)}`)
  }
  if (command.examples?.length) {
    lines.push('', 'Examples:')
    for (const example of command.examples) {
      if (typeof example.cli === 'string' && example.cli) lines.push(`  ${example.cli}`)
    }
  }
  lines.push('', 'Invoke via auv_invoke with command_id and an inputs object keyed by the input keys above.')
  return lines.join('\n')
}
