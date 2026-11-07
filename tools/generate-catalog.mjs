#!/usr/bin/env node
/**
 * Regenerate src/catalog.json from a live AUV install.
 *
 * Sources of truth (in order):
 *   1. `auv mcp serve` JSON-RPC: initialize + tools/list. The `invoke` tool's
 *      inputSchema["x-auv-commands"] carries the full command catalog
 *      (id, description, target policy, arguments, examples, support).
 *   2. `auv --no-daemon invoke <command-id> --help` for EVERY command. Clap's
 *      Arguments / Options sections win for argv shape: they tell us whether an
 *      option takes a value or is presence-only, the positional order and names,
 *      repeated positionals, enum candidate values, and requiredness.
 *
 * The generator cross-checks both, prints every correction it had to make
 * (e.g. MCP says `--exclude-minimized` takes a value, CLI says it is a
 * presence flag), and writes a compact deterministic catalog.
 *
 * Usage:
 *   node tools/generate-catalog.mjs            # write src/catalog.json
 *   node tools/generate-catalog.mjs --check    # verify existing file is current
 *   node tools/generate-catalog.mjs --out FILE # write elsewhere
 *
 * Environment:
 *   AUV_BIN       path/name of the auv binary (default: "auv" from PATH)
 *   AUV_LOG_DIR   state/log dir for auv; defaults to a fresh dir under tmpdir.
 *                 Needed because the DSH bash sandbox cannot write auv's default
 *                 ~/Library/Application Support state dir.
 *
 * Node >= 20, plain ESM, no dependencies.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUV_BIN = process.env.AUV_BIN || 'auv'
const DEFAULT_OUT = fileURLToPath(new URL('../src/catalog.json', import.meta.url))
const CLIENT_INFO = { name: 'dsh-auv-catalog-generator', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'
const MCP_TIMEOUT_MS = 30_000
const HELP_TIMEOUT_MS = 20_000

/** Options every `auv invoke <id>` subcommand inherits; never command inputs. */
const COMMON_OPTIONS = new Set([
  '--dry-run',
  '--no-overlay',
  '--store-root',
  '--json',
  '--detail',
  '--wide',
  '--target',
  '-h',
  '--help',
])

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { check: false, out: DEFAULT_OUT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') out.check = true
    else if (arg === '--out') {
      const value = argv[++i]
      if (!value) throw new Error('--out requires a path')
      out.out = value
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/generate-catalog.mjs [--check] [--out FILE]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

function auvEnv(logDir) {
  return { ...process.env, AUV_LOG_DIR: logDir }
}

function runCapture(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs,
    env: options.env,
  })
  if (result.error) throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`)
  if (result.signal) throw new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs} ms`)
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

// ---------------------------------------------------------------------------
// step 1: MCP handshake -> tools/list -> invoke.inputSchema["x-auv-commands"]
// ---------------------------------------------------------------------------

function fetchMcpCatalog(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(AUV_BIN, ['mcp', 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let settled = false
    let nextId = 1
    const pending = new Map()

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
      child.kill()
      if (error) reject(error)
      else resolve(value)
    }

    const timer = setTimeout(
      () => finish(new Error(`auv mcp serve did not answer within ${MCP_TIMEOUT_MS} ms (stderr: ${stderr.slice(-500)})`)),
      MCP_TIMEOUT_MS,
    )

    const send = (message) => {
      child.stdin.write(JSON.stringify(message) + '\n')
    }

    const request = (method, params) => {
      const id = nextId++
      send({ jsonrpc: '2.0', id, method, params })
      return new Promise((res, rej) => pending.set(id, { res, rej }))
    }

    const handleLine = (line) => {
      const text = line.trim()
      if (!text) return
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return // ignore non-JSON noise
      }
      if (message.id != null && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(`MCP ${message.method ?? 'response'} error: ${JSON.stringify(message.error)}`))
        else res(message.result)
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handleLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000)
    })
    child.on('error', (error) => finish(new Error(`could not spawn ${AUV_BIN}: ${error.message}`)))

    ;(async () => {
      try {
        const init = await request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        })
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
        const listing = await request('tools/list', {})
        const tools = listing?.tools
        if (!Array.isArray(tools)) throw new Error('MCP tools/list returned no tools array')
        const invoke = tools.find((tool) => tool.name === 'invoke')
        if (!invoke) throw new Error(`MCP tools/list has no "invoke" tool (saw: ${tools.map((t) => t.name).join(', ')})`)
        const commands = invoke.inputSchema?.['x-auv-commands']
        if (!Array.isArray(commands) || commands.length === 0) {
          throw new Error('invoke tool inputSchema has no x-auv-commands array')
        }
        finish(null, {
          version: init?.serverInfo?.version ?? 'unknown',
          protocolVersion: init?.protocolVersion ?? PROTOCOL_VERSION,
          toolCount: tools.length,
          commands,
        })
      } catch (error) {
        finish(error)
      }
    })()
  })
}

// ---------------------------------------------------------------------------
// step 2: parse one `auv invoke <id> --help`
// ---------------------------------------------------------------------------

/**
 * Parse clap help into:
 *   positionals: [{ name, required, repeated, help }]
 *   options:     Map<flag, { flag, takesValue, valueName, required, help, possibleValues }>
 * plus the raw usage line for requiredness cross-checks.
 */
function parseHelp(text) {
  const lines = text.split('\n')
  const positionals = []
  const options = new Map()
  let usage = ''
  let section = null // 'args' | 'options' | null
  let current = null

  const pushDescriptionLine = (line) => {
    if (current && /^ {10}\S/.test(line)) current.descLines.push(line.trim())
  }

  for (const line of lines) {
    if (line.startsWith('Usage:')) {
      usage = line
      section = null
      current = null
      continue
    }
    if (line === 'Arguments:') {
      section = 'args'
      current = null
      continue
    }
    if (line === 'Options:') {
      section = 'options'
      current = null
      continue
    }
    if (/^(Examples:|Platform support:|Selected Runner support:)/.test(line)) {
      section = null
      current = null
      continue
    }
    if (section === 'args') {
      const match = line.match(/^ {2}(<[^>]+>|\[[^\]]+\](?:\.\.\.)?)\s*$/)
      if (match) {
        const token = match[1]
        const required = token.startsWith('<')
        const repeated = token.endsWith('...')
        current = {
          name: token.replace(/[<>[\]]/g, '').replace(/\.\.\.$/, ''),
          required,
          repeated,
          descLines: [],
        }
        positionals.push(current)
        continue
      }
      pushDescriptionLine(line)
      continue
    }
    if (section === 'options') {
      // Long-option line, e.g. "      --button <BUTTON>" or "      --normalized"
      const longMatch = line.match(/^ {6}(--[a-z0-9-]+)(?: <([^>]+)>)?\s*$/)
      if (longMatch) {
        current = {
          flag: longMatch[1],
          takesValue: Boolean(longMatch[2]),
          valueName: longMatch[2] ?? null,
          descLines: [],
        }
        options.set(current.flag, current)
        continue
      }
      // "  -h, --help" style lines
      const helpMatch = line.match(/^ {2}(-[a-zA-Z]), (--[a-z0-9-]+)\s*$/)
      if (helpMatch) {
        current = { flag: helpMatch[2], takesValue: false, valueName: null, descLines: [] }
        options.set(current.flag, current)
        continue
      }
      pushDescriptionLine(line)
      continue
    }
  }

  const finishEntry = (entry) => {
    const firstParagraph = []
    for (const descLine of entry.descLines) {
      if (descLine === '') break
      if (/^\[(default|possible values):/.test(descLine)) continue
      firstParagraph.push(descLine)
    }
    entry.help = firstParagraph.join(' ').trim()
    const enumLine = entry.descLines.find((descLine) => /^\[possible values: .*\]$/.test(descLine))
    if (enumLine) {
      entry.possibleValues = enumLine
        .replace(/^\[possible values: /, '')
        .replace(/\]$/, '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    }
    delete entry.descLines
    return entry
  }

  for (const positional of positionals) {
    const required = positional.required
    finishEntry(positional)
    positional.required = required
  }
  for (const option of options.values()) finishEntry(option)

  return { positionals, options, usage }
}

// ---------------------------------------------------------------------------
// step 3: merge MCP metadata with parsed CLI truth
// ---------------------------------------------------------------------------

function compactSupport(support) {
  const state = (platform) => support?.[platform]?.state ?? 'unknown'
  return {
    macos: state('macos'),
    linux: state('linux'),
    windows: state('windows'),
  }
}

function compactRunnerSupport(runnerSupport) {
  const route = runnerSupport?.route ?? 'direct'
  return { route }
}

/**
 * MCP target policies are finer-grained ("optional_application",
 * "required_window", ...). The catalog contract only needs the three states
 * from DESIGN.md; accepted_types carries the rest.
 */
function normalizeTargetPolicy(policy) {
  const value = String(policy ?? 'forbidden')
  if (value === 'forbidden') return 'forbidden'
  if (value.startsWith('required')) return 'required'
  if (value.startsWith('optional')) return 'optional'
  return value
}

function compactExamples(examples, commandId) {
  if (!Array.isArray(examples)) return []
  const compact = []
  for (const example of examples.slice(0, 3)) {
    const call = { command_id: example?.call?.command_id ?? commandId, inputs: example?.call?.inputs ?? {} }
    if (example?.call?.target) call.target = example.call.target
    const entry = {}
    if (typeof example?.cli === 'string' && example.cli.trim()) entry.cli = example.cli.trim()
    entry.call = call
    compact.push(entry)
  }
  return compact
}

function mergeCommand(mcp, helpText, warnings) {
  const help = parseHelp(helpText)
  const argumentsOut = []
  const seenFlags = new Set()
  let positionalIndex = 0

  for (const mcpArg of mcp.arguments ?? []) {
    if (mcpArg.flag == null) {
      const cliPositional = help.positionals[positionalIndex]
      if (!cliPositional) {
        warnings.push(`${mcp.id}: MCP positional "${mcpArg.input_key}" has no CLI help entry; skipped`)
        continue
      }
      positionalIndex += 1
      const argument = {
        input_key: mcpArg.input_key,
        flag: null,
        kind: 'positional',
        required: Boolean(mcpArg.required),
        repeated: Boolean(mcpArg.repeated),
        value_name: cliPositional.name,
        help: mcpArg.help || cliPositional.help || '',
      }
      if (Boolean(mcpArg.repeated) !== cliPositional.repeated) {
        warnings.push(
          `${mcp.id}: positional "${mcpArg.input_key}" repeated differs (MCP ${Boolean(mcpArg.repeated)}, CLI ${cliPositional.repeated}); trusting CLI`,
        )
        argument.repeated = cliPositional.repeated
      }
      if (Boolean(mcpArg.required) !== cliPositional.required) {
        warnings.push(
          `${mcp.id}: positional "${mcpArg.input_key}" required differs (MCP ${Boolean(mcpArg.required)}, CLI ${cliPositional.required}); keeping MCP`,
        )
      }
      argumentsOut.push(argument)
      continue
    }

    if (COMMON_OPTIONS.has(mcpArg.flag)) continue
    const cliOption = help.options.get(mcpArg.flag)
    if (!cliOption) {
      warnings.push(`${mcp.id}: MCP option ${mcpArg.flag} absent from CLI help; dropped (CLI wins)`)
      continue
    }
    seenFlags.add(mcpArg.flag)
    const kind = cliOption.takesValue ? 'value' : 'flag'
    if (mcpArg.value_name && !cliOption.takesValue) {
      warnings.push(
        `${mcp.id}: ${mcpArg.flag} is VALUE in MCP (${mcpArg.value_name}) but presence-only flag in CLI; using flag`,
      )
    }
    if (!mcpArg.value_name && cliOption.takesValue) {
      warnings.push(`${mcp.id}: ${mcpArg.flag} is presence-only in MCP but takes a value in CLI; using value`)
    }
    if (mcpArg.value_name && cliOption.takesValue && mcpArg.value_name !== cliOption.valueName) {
      warnings.push(
        `${mcp.id}: ${mcpArg.flag} value name differs (MCP ${mcpArg.value_name}, CLI ${cliOption.valueName}); trusting CLI`,
      )
    }
    const argument = {
      input_key: mcpArg.input_key,
      flag: mcpArg.flag,
      kind,
      required: Boolean(mcpArg.required),
      repeated: Boolean(mcpArg.repeated),
      value_name: cliOption.takesValue ? cliOption.valueName : null,
      help: mcpArg.help || cliOption.help || '',
    }
    if (cliOption.possibleValues?.length) argument.possible_values = cliOption.possibleValues
    argumentsOut.push(argument)
  }

  // Options present in CLI help but missing from MCP metadata: include them
  // (CLI wins) so a future AUV release cannot silently lose capabilities.
  for (const [flag, cliOption] of help.options) {
    if (COMMON_OPTIONS.has(flag) || seenFlags.has(flag)) continue
    warnings.push(`${mcp.id}: CLI option ${flag} missing from MCP metadata; added`)
    const argument = {
      input_key: flag.replace(/^--/, ''),
      flag,
      kind: cliOption.takesValue ? 'value' : 'flag',
      required: false,
      repeated: false,
      value_name: cliOption.takesValue ? cliOption.valueName : null,
      help: cliOption.help || '',
    }
    if (cliOption.possibleValues?.length) argument.possible_values = cliOption.possibleValues
    argumentsOut.push(argument)
  }

  if (positionalIndex !== help.positionals.length) {
    warnings.push(
      `${mcp.id}: CLI has ${help.positionals.length} positionals but MCP declared ${positionalIndex}; catalog may be incomplete`,
    )
  }

  const target = {
    policy: normalizeTargetPolicy(mcp.target_policy),
    accepted_types: Array.isArray(mcp.target?.accepted_types) ? [...mcp.target.accepted_types] : [],
    required: Boolean(mcp.target?.required),
  }

  const command = {
    id: mcp.id,
    namespace: mcp.namespace,
    description: mcp.description,
    target,
    support: compactSupport(mcp.support),
    runner_support: compactRunnerSupport(mcp.runner_support),
    arguments: argumentsOut,
    examples: compactExamples(mcp.examples, mcp.id),
  }
  // Keep the one-line reason where macOS support is not "supported" (e.g.
  // input.scrollPoint is window-owned-scroll only on macOS).
  const macosNote = mcp.support?.macos?.note
  if (macosNote) command.support_note = { macos: macosNote }
  return command
}

// ---------------------------------------------------------------------------
// step 4: build, validate, serialize
// ---------------------------------------------------------------------------

function validateCatalog(catalog) {
  const errors = []
  const seenIds = new Set()
  for (const command of catalog.commands) {
    if (!command.id) errors.push('command without id')
    if (seenIds.has(command.id)) errors.push(`duplicate command id: ${command.id}`)
    seenIds.add(command.id)
    if (!Array.isArray(command.arguments)) errors.push(`${command.id}: arguments is not an array`)
    for (const argument of command.arguments ?? []) {
      const where = `${command.id}/${argument.input_key}`
      if (!argument.input_key) errors.push(`${command.id}: argument without input_key`)
      if (!['positional', 'value', 'flag'].includes(argument.kind)) errors.push(`${where}: bad kind ${argument.kind}`)
      if (argument.kind === 'positional' && argument.flag != null) errors.push(`${where}: positional must have null flag`)
      if (argument.kind !== 'positional' && !String(argument.flag ?? '').startsWith('--')) {
        errors.push(`${where}: ${argument.kind} needs a --flag`)
      }
      if (typeof argument.required !== 'boolean') errors.push(`${where}: required must be boolean`)
      if (typeof argument.repeated !== 'boolean') errors.push(`${where}: repeated must be boolean`)
    }
  }
  if (errors.length > 0) throw new Error(`catalog validation failed:\n- ${errors.join('\n- ')}`)
}

async function buildCatalog(logDir) {
  const env = auvEnv(logDir)
  const mcp = await fetchMcpCatalog(env)
  const warnings = []
  const commands = []
  let helpFailures = 0

  for (const mcpCommand of [...mcp.commands].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    let helpText
    try {
      const result = runCapture(AUV_BIN, ['--no-daemon', 'invoke', mcpCommand.id, '--help'], {
        env,
        timeoutMs: HELP_TIMEOUT_MS,
      })
      if (result.status !== 0 && !result.stdout) {
        throw new Error(`exit ${result.status}: ${result.stderr.trim().slice(-500)}`)
      }
      helpText = result.stdout
    } catch (error) {
      helpFailures += 1
      warnings.push(`${mcpCommand.id}: CLI help unavailable (${error.message}); using MCP metadata only`)
      helpText = ''
    }
    commands.push(mergeCommand(mcpCommand, helpText, warnings))
  }

  if (helpFailures === mcp.commands.length) {
    throw new Error('every `auv invoke <id> --help` call failed; is the AUV CLI working?')
  }

  const catalog = {
    auv_version: mcp.version,
    generated_at: new Date().toISOString(),
    generated_by: 'tools/generate-catalog.mjs',
    commands,
  }
  validateCatalog(catalog)
  return { catalog, warnings, mcp }
}

function stableCommands(catalog) {
  // generated_at is expected to change; everything else must be stable.
  const { generated_at: _generatedAt, ...rest } = catalog
  return JSON.stringify(rest, null, 2)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ownedLogDir = process.env.AUV_LOG_DIR ? null : mkdtempSync(`${tmpdir()}/auv-catalog-`)
  const logDir = process.env.AUV_LOG_DIR || ownedLogDir
  try {
    console.log(`[generate-catalog] auv binary: ${AUV_BIN}`)
    console.log(`[generate-catalog] AUV_LOG_DIR: ${logDir}`)
    const { catalog, warnings, mcp } = await buildCatalog(logDir)

    console.log(
      `[generate-catalog] MCP tools/list: ${mcp.toolCount} tools, invoke catalog: ${mcp.commands.length} commands (auv ${catalog.auv_version})`,
    )
    console.log(`[generate-catalog] CLI help cross-check: ${catalog.commands.length}/${mcp.commands.length} commands`)
    if (warnings.length > 0) {
      console.log(`[generate-catalog] MCP/CLI differences (${warnings.length}):`)
      for (const warning of warnings) console.log(`  - ${warning}`)
    } else {
      console.log('[generate-catalog] MCP metadata and CLI help agree on every argument')
    }

    if (args.check) {
      let existing
      try {
        existing = JSON.parse(readFileSync(args.out, 'utf8'))
      } catch (error) {
        console.error(`[generate-catalog] CHECK FAILED: cannot read ${args.out}: ${error.message}`)
        process.exitCode = 1
        return
      }
      if (stableCommands(existing) === stableCommands(catalog)) {
        console.log(`[generate-catalog] CHECK OK: ${args.out} matches a fresh generation`)
        return
      }
      console.error(`[generate-catalog] CHECK FAILED: ${args.out} is stale; run node tools/generate-catalog.mjs`)
      process.exitCode = 1
      return
    }

    mkdirSync(dirname(args.out), { recursive: true })
    const json = JSON.stringify(catalog, null, 2) + '\n'
    writeFileSync(args.out, json)
    console.log(`[generate-catalog] wrote ${args.out} (${json.length} bytes, ${catalog.commands.length} commands)`)
  } finally {
    if (ownedLogDir) {
      try {
        rmSync(ownedLogDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((error) => {
  console.error(`[generate-catalog] FAILED: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
