#!/usr/bin/env node
/**
 * Offline self-check for the @local/dsh-auv bundle.
 *
 * Imports the plugin entry, the tool definitions, the transport, and (when
 * present) the built bundle, then asserts that:
 *   - every ToolDefinition is well formed and its JSON Schemas stay inside the
 *     DSH-enforced schema subset;
 *   - the nine auv_* tools exist with the expected parameters, description
 *     limits, timeouts, and `isConcurrencySafe: () => false`;
 *   - the package manifest, locales, patch, icon, and entry point are sane and
 *     the retired CLI/catalog files are gone;
 *   - the SDK argument planners/mappers still produce the documented shapes;
 *   - the transport decides attach-first and stops only its own daemon;
 *   - the doctor report helpers map permission statuses to plain fields;
 *   - runtime source contains no `auv` CLI invocation, argv builder, catalog
 *     path, or removed transport env vars;
 *   - `connect({ discover: true })` fails fast when nothing is discoverable;
 *   - tool bodies validate parameters before the transport is touched;
 *   - the bundled dist/index.mjs registers the nine tools and inlines the SDK.
 *
 * No AUV daemon is started by this script: safe to run anywhere.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = ROOT
const SRC = path.join(PLUGIN, 'src')

const failures = []
let passed = 0

function pass(label) {
  passed += 1
  console.log(`PASS ${label}`)
}

function fail(label, detail) {
  failures.push({ label, detail })
  console.log(`FAIL ${label}: ${detail}`)
}

async function check(label, fn) {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
}

async function assertRejects(fn, pattern, message) {
  try {
    await fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (pattern !== undefined && !pattern.test(text)) throw new Error(`${message}: rejected with unexpected message "${text}"`)
    return
  }
  throw new Error(`${message}: expected a rejection, but the call resolved`)
}

async function importSrc(relativePath) {
  return await import(pathToFileURL(path.join(SRC, relativePath)).href)
}

// ---------------------------------------------------------------------------
// JSON Schema subset validator (mirrors dsh-tools' enforced subset)
// ---------------------------------------------------------------------------

const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLING_KEYS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return isJsonNumber(value)
    case 'integer':
      return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

function validateSchema(node, label, violations) {
  if (!isPlainRecord(node)) {
    violations.push(`${label} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYS.has(key)) continue
    if (ANNOTATION_KEYS.has(key)) {
      if ((key === 'description' || key === 'title') && typeof node[key] !== 'string') {
        violations.push(`${label}.${key} must be a string`)
      }
      continue
    }
    violations.push(`${label}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${label} cannot declare both type and oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYS) {
      if (Object.hasOwn(node, key)) violations.push(`${label}.${key} requires type or oneOf`)
    }
    return
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${label}.oneOf must be an array of at least two schemas`)
    } else {
      node.oneOf.forEach((branch, index) => validateSchema(branch, `${label}.oneOf[${index}]`, violations))
    }
    for (const key of ONE_OF_SIBLING_KEYS) {
      if (Object.hasOwn(node, key)) violations.push(`${label}.${key} is not supported beside oneOf`)
    }
    return
  }
  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(`${label}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  const applicability = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(applicability)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) violations.push(`${label}.${key} is not supported on type "${type}"`)
  }
  if (type === 'object') {
    const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
    if (Object.hasOwn(node, 'properties')) {
      if (!isPlainRecord(properties)) {
        violations.push(`${label}.properties must be an object of schemas`)
      } else {
        for (const [key, child] of Object.entries(properties)) validateSchema(child, `${label}.properties.${key}`, violations)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${label}.required must be an array of strings`)
      } else {
        const declared = isPlainRecord(properties) ? properties : {}
        for (const key of required) {
          if (!Object.hasOwn(declared, key)) violations.push(`${label}.required names "${key}" which is not in properties`)
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${label}.additionalProperties must be a boolean`)
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) validateSchema(node.items, `${label}.items`, violations)
  } else {
    if (Object.hasOwn(node, 'enum')) {
      const allowed = node.enum
      if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some((entry) => !scalarMatches(type, entry))) {
        violations.push(`${label}.enum must be a non-empty array of ${type} values`)
      }
      if (Object.hasOwn(node, 'const') && Array.isArray(allowed) && !allowed.includes(node.const)) {
        violations.push(`${label}.const must be one of ${label}.enum when both are declared`)
      }
    }
    if (Object.hasOwn(node, 'const') && !scalarMatches(type, node.const)) {
      violations.push(`${label}.const must be a ${type} value`)
    }
  }
}

function assertSupportedSchema(schema, label) {
  const violations = []
  validateSchema(schema, label, violations)
  assert(violations.length === 0, violations.join('; '))
}

// ---------------------------------------------------------------------------
// Expected tool surface (9 SDK-only tools)
// ---------------------------------------------------------------------------

const EXPECTED = {
  auv_doctor: { required: [], properties: [] },
  auv_screenshot: { required: [], properties: ['window_id', 'application_id', 'display_id', 'region'] },
  auv_ocr: { required: ['text'], properties: ['text', 'window_id', 'application_id', 'wait', 'timeout_ms'] },
  auv_click: { required: [], properties: ['text', 'x', 'y', 'window_id', 'application_id', 'display_id', 'button', 'within'] },
  auv_type: { required: ['text'], properties: ['text', 'mode', 'window_id', 'application_id', 'policy'] },
  auv_keys: { required: ['keys'], properties: ['keys', 'repeat', 'interval_ms', 'window_id', 'application_id'] },
  auv_scroll: { required: ['dy'], properties: ['dy', 'dx', 'window_id', 'x', 'y'] },
  auv_windows: { required: [], properties: ['include_minimized', 'include_other_desktops'] },
  auv_activate: { required: ['application_id'], properties: ['application_id'] },
}

const DESCRIPTION_LIMITS = { default: 1_200 }
const PERMISSION_TOOLS = ['auv_doctor', 'auv_screenshot', 'auv_ocr', 'auv_click', 'auv_type', 'auv_keys', 'auv_scroll']

const RETIRED_FILES = [
  'src/catalog.json',
  'src/catalog.mjs',
  'src/catalog-data.mjs',
  'src/transport/config.mjs',
  'tools/generate-catalog.mjs',
  'tools/sync-catalog-data.mjs',
  'notes/catalog-selfcheck.mjs',
]

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkMissingAuvGuidance() {
  const { AUV_INSTALL_GUIDANCE, resetAuvBinaryCache, resolveAuvBinary } = await importSrc('auv.mjs')

  assert(typeof AUV_INSTALL_GUIDANCE === 'string', 'AUV_INSTALL_GUIDANCE must be exported as a string')
  for (const needle of [
    'brew install moeru-ai/tap/auv',
    'https://auv.moeru.ai/install.sh',
    'github.com/moeru-ai/auv',
    'AUV_BIN',
    'auv_doctor',
    'auv serve',
  ]) {
    assert(AUV_INSTALL_GUIDANCE.includes(needle), `AUV_INSTALL_GUIDANCE must mention ${needle}`)
  }

  const previousBin = process.env.AUV_BIN
  const previousPath = process.env.PATH
  try {
    // 1) AUV_BIN points at a non-executable path.
    process.env.AUV_BIN = path.join(ROOT, 'missing-auv-for-test')
    resetAuvBinaryCache()
    let invalidError
    try {
      resolveAuvBinary()
    } catch (error) {
      invalidError = error
    }
    assert(invalidError !== undefined, 'resolveAuvBinary must throw when AUV_BIN is invalid')
    assert(invalidError.code === 'AUV_BIN_INVALID', `expected AUV_BIN_INVALID, got ${invalidError.code}`)
    assert(
      invalidError.message.includes('brew install moeru-ai/tap/auv') && invalidError.message.includes('Install AUV'),
      'AUV_BIN_INVALID message must include install instructions',
    )

    // 2) The guidance text is the message body used by the AUV_NOT_FOUND branch.
    //    (A direct PATH-only simulation cannot run here because resolveAuvBinary
    //    also probes well-known install directories, which contain auv on a dev host.)
    assert(AUV_INSTALL_GUIDANCE.includes('Install AUV'), 'AUV_INSTALL_GUIDANCE must tell the user to install AUV')
    assert(AUV_INSTALL_GUIDANCE.includes('verify with `auv --version`'), 'AUV_INSTALL_GUIDANCE must tell the user how to verify the install')
    assert(invalidError.message.includes(AUV_INSTALL_GUIDANCE), 'AUV_BIN_INVALID message must embed the full install guidance')
  } finally {
    if (previousBin === undefined) delete process.env.AUV_BIN
    else process.env.AUV_BIN = previousBin
    process.env.PATH = previousPath
    resetAuvBinaryCache()
  }
}

async function checkToolDefinitions() {
  const { createTools, TOOL_NAMES } = await importSrc('tools.mjs')
  assert(typeof createTools === 'function', 'src/tools.mjs must export createTools()')
  assert(Array.isArray(TOOL_NAMES), 'src/tools.mjs must export the TOOL_NAMES array')

  const tools = createTools()
  assert(Array.isArray(tools), 'createTools() must return an array')
  assert(tools.length === 9, `expected 9 tools, got ${tools.length}`)

  const names = tools.map((tool) => tool?.name)
  assertEqual([...names].sort(), [...TOOL_NAMES].sort(), 'tool names must match TOOL_NAMES')
  assertEqual([...names].sort(), Object.keys(EXPECTED).sort(), 'tool names must match the 9-tool SDK-only surface')
  assert(new Set(names).size === names.length, 'tool names must be unique')

  for (const tool of tools) {
    const name = tool.name
    const expected = EXPECTED[name]
    assert(typeof tool.description === 'string' && tool.description.trim() !== '', `${name} must have a description`)
    const limit = DESCRIPTION_LIMITS[name] ?? DESCRIPTION_LIMITS.default
    assert(tool.description.length <= limit, `${name} description is ${tool.description.length} chars; limit is ${limit}`)
    assert(/^[A-Z]/.test(tool.description), `${name} description must be sentence case (start with a capital letter)`)
    assert(!/\n/.test(tool.description), `${name} description must be one paragraph without newlines`)
    assert(/^[a-z][a-z0-9_]*$/.test(name), `${name} must be a snake_case tool name`)
    assert(name.startsWith('auv_'), `${name} must start with auv_`)
    assert(!/auv_invoke|auv_help|command catalog|AUV_DSH_TRANSPORT/i.test(tool.description), `${name} description must not mention retired CLI/catalog features`)
    if (PERMISSION_TOOLS.includes(name)) {
      assert(tool.description.includes('auv_doctor'), `${name} description must point at auv_doctor`)
      assert(/Accessibility|Screen Recording/.test(tool.description), `${name} description must name the macOS permission`)
    }

    assert(typeof tool.parameters === 'object' && tool.parameters !== null, `${name} must declare parameters`)
    assertEqual(tool.parameters.type, 'object', `${name} parameters must be object-rooted`)
    assertEqual(tool.parameters.additionalProperties, false, `${name} parameters must set additionalProperties: false`)
    assertSupportedSchema(tool.parameters, `${name}.parameters`)
    const properties = tool.parameters.properties ?? {}
    for (const key of expected.properties) assert(Object.hasOwn(properties, key), `${name} parameters are missing "${key}"`)
    for (const key of Object.keys(properties)) {
      assert(typeof properties[key]?.description === 'string' && properties[key].description !== '', `${name}.${key} needs a description`)
    }
    assertEqual(tool.parameters.required ?? [], expected.required, `${name} required parameters`)

    assert(typeof tool.output === 'object' && tool.output !== null, `${name} must declare an output`)
    assertSupportedSchema(tool.output.schema, `${name}.output.schema`)
    assert(typeof tool.output.render === 'function', `${name}.output.render must be a function`)

    assert(typeof tool.execute === 'function', `${name}.execute must be a function`)
    assert(Number.isInteger(tool.timeoutMs) && tool.timeoutMs >= 120_000 && tool.timeoutMs <= 180_000, `${name}.timeoutMs must be 120000..180000`)
    assert(typeof tool.isConcurrencySafe === 'function', `${name}.isConcurrencySafe must be a function`)
    assert(tool.isConcurrencySafe({}) === false, `${name}.isConcurrencySafe({}) must return false`)

    const rendered = tool.output.render({}, { ok: true })
    assert(Array.isArray(rendered) && rendered.length > 0, `${name}.output.render must return at least one block`)
    assert(rendered.every((block) => block?.type === 'text' && typeof block.text === 'string'), `${name}.output.render must return text blocks`)
  }
}

async function checkEntryPoint() {
  const entry = await import(pathToFileURL(path.join(PLUGIN, 'index.js')).href)
  assertEqual(entry.inject, ['tools'], "index.js must export inject = ['tools']")
  assert(typeof entry.apply === 'function', 'index.js must export apply(ctx)')
  const registered = []
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
    effect(callback) {
      disposers.push(callback())
    },
  }
  entry.apply(ctx)
  assert(registered.length === 9, `apply() should register 9 tools, registered ${registered.length}`)
  assert(new Set(registered.map((definition) => definition.name)).size === 9, 'apply() registered duplicate tool names')
  assert(disposers.length === 1, `apply() must register one dispose effect, registered ${disposers.length}`)
  assert(typeof disposers[0] === 'function', 'the dispose effect must return a disposer function')
  // The disposer must be safe to call before any SDK transport exists.
  await disposers[0]()
}

async function checkManifestAndResources() {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
  assertEqual(manifest.name, '@local/dsh-auv', 'package name')
  assertEqual(manifest.type, 'module', 'package type')
  assertEqual(manifest.private, true, 'package private')
  assertEqual(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch')
  assertEqual(manifest.exports?.['.'], './dist/index.mjs', 'package exports "." must point at the bundled entry')
  assert(Array.isArray(manifest.files) && manifest.files.includes('dist'), 'package.json files must ship dist/')
  assert(typeof manifest.exports?.['./locale/*.json'] === 'string', 'package must export ./locale/*.json')
  assert(typeof manifest.exports?.['./icon'] === 'string', 'package must export ./icon')
  for (const dependency of ['@auv-js/sdk', 'es-toolkit', 'tsdown']) {
    assert(typeof manifest.devDependencies?.[dependency] === 'string', `package.json devDependencies must keep ${dependency}`)
  }
  assertEqual(manifest.exports?.['.'], './dist/index.mjs', 'the single-file bundle is the only runtime entry')

  for (const file of [
    'index.js',
    'cordis.patch.yml',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'src/auv.mjs',
    'src/tools.mjs',
    'src/transport/sdk-format.mjs',
    'src/transport/sdk.mjs',
    'dist/index.mjs',
  ]) {
    assert(existsSync(path.join(PLUGIN, file)), `missing required file ${file}`)
  }

  for (const file of RETIRED_FILES) {
    assert(!existsSync(path.join(PLUGIN, file)), `retired CLI/catalog file must be deleted: ${file}`)
  }

  const patch = readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8')
  assert(/insert:/.test(patch), 'cordis.patch.yml must use an insert block')
  assert(/id:\s*dsh-auv/.test(patch), 'cordis.patch.yml must insert the dsh-auv row id')
  assert(/'@local\/dsh-auv'/.test(patch), 'cordis.patch.yml must name @local/dsh-auv')

  for (const locale of ['en.json', 'zh.json']) {
    const parsed = JSON.parse(readFileSync(path.join(PLUGIN, 'locale', locale), 'utf8'))
    assert(typeof parsed?.meta?.title === 'string' && parsed.meta.title !== '', `locale/${locale} meta.title`)
    assert(typeof parsed?.meta?.description === 'string' && parsed.meta.description !== '', `locale/${locale} meta.description`)
  }

  const iconPath = path.join(PLUGIN, 'icon.svg')
  assert(statSync(iconPath).size < 256 * 1024, 'icon.svg must stay under 256 KiB')
  const icon = readFileSync(iconPath, 'utf8')
  assert(/<svg[\s>]/.test(icon), 'icon.svg must contain an svg root element')
  assert(/viewBox=/.test(icon), 'icon.svg should declare a viewBox')
}

async function checkSdkArgumentMapping() {
  const format = await importSrc('transport/sdk-format.mjs')

  // Windows options invert the list flags.
  assertEqual(format.parseWindowsArgs({}), { includeMinimized: false, includeOtherDesktops: false }, 'auv_windows defaults')
  assertEqual(
    format.parseWindowsArgs({ include_minimized: true, include_other_desktops: true }),
    { includeMinimized: true, includeOtherDesktops: true },
    'auv_windows include flags',
  )

  // Screenshot target exclusivity.
  assertEqual(
    format.parseScreenshotArgs({ region: { x: 0, y: 0, width: 10, height: 20 } }).region,
    { x: 0, y: 0, width: 10, height: 20 },
    'auv_screenshot region parsing',
  )
  await assertRejects(() => format.parseScreenshotArgs({ window_id: '1', display_id: '1' }), /only one of/, 'auv_screenshot rejects competing targets')
  await assertRejects(() => format.parseScreenshotArgs({ region: { x: 0, y: 0, width: 0, height: 10 } }), /greater than zero/, 'auv_screenshot rejects an empty region')

  // OCR parity.
  assertEqual(format.parseOcrArgs({ text: 'OK', wait: true, timeout_ms: 5000 }).timeoutMs, 5000, 'auv_ocr waits with a timeout')
  await assertRejects(() => format.parseOcrArgs({ text: 'OK', timeout_ms: 5000 }), /only valid with wait/, 'auv_ocr rejects timeout_ms without wait')
  await assertRejects(() => format.parseOcrArgs({ text: 'OK', wait: true, timeout_ms: 50 }), /between 100 and 120000/, 'auv_ocr timeout bounds')
  await assertRejects(() => format.parseOcrArgs({ text: 'OK', window_id: '1', application_id: 'a' }), /only one of/, 'auv_ocr target exclusivity')

  // Click forms.
  assertEqual(format.parseClickArgs({ text: 'OK' }).kind, 'text', 'auv_click text form')
  assertEqual(format.parseClickArgs({ x: 1, y: 2 }).kind, 'point', 'auv_click point form')
  const fenced = format.parseClickArgs({ text: 'OK', within: { left: 0, top: 0, right: 10, bottom: 20 } })
  assertEqual(fenced.within, { left: 0, top: 0, right: 10, bottom: 20 }, 'auv_click within fence')
  await assertRejects(() => format.parseClickArgs({}), /requires either "text"/, 'auv_click rejects an empty click')
  await assertRejects(() => format.parseClickArgs({ text: 'OK', x: 1, y: 2 }), /not both forms/, 'auv_click rejects text plus coordinates')
  await assertRejects(() => format.parseClickArgs({ text: 'OK', button: 'right' }), /button applies only to x\/y/, 'auv_click rejects a non-left button on text clicks')
  await assertRejects(() => format.parseClickArgs({ text: 'OK', display_id: '1' }), /display_id cannot be used with OCR/, 'auv_click rejects display_id with text')
  assertEqual(format.parseClickArgs({ x: 1, y: 2, button: 'right' }).button, 'right', 'auv_click button mapping')

  // Type / keys / scroll / activate parity.
  assertEqual(format.parseTypeArgs({ text: 'hi', mode: 'paste', policy: 'background-only' }).mode, 'paste', 'auv_type paste mode')
  await assertRejects(() => format.parseTypeArgs({}), /Missing required parameter "text"/, 'auv_type requires text')
  const keys = format.parseKeysArgs({ keys: ['cmd', 'l'], repeat: 2, interval_ms: 100 })
  assertEqual(keys.keys, ['cmd', 'l'], 'auv_keys keys')
  await assertRejects(() => format.parseKeysArgs({ keys: [] }), /non-empty array/, 'auv_keys requires keys')
  await assertRejects(() => format.parseKeysArgs({ keys: ['a'], interval_ms: 50 }), /only valid with repeat/, 'auv_keys rejects interval_ms alone')
  await assertRejects(() => format.parseScrollArgs({}), /requires "dy"/, 'auv_scroll requires dy')
  await assertRejects(
    () => format.parseScrollArgs({ dy: 10 }),
    /requires "window_id", or both "x" and "y"/,
    'auv_scroll requires a window or a screen point',
  )
  assertEqual(format.parseScrollArgs({ dy: 10, window_id: '9', x: 2, y: 3 }).windowId, '9', 'auv_scroll window point')
  await assertRejects(() => format.parseActivateArgs({}), /Missing required parameter "application_id"/, 'auv_activate requires application_id')

  // Request builders.
  const press = format.buildPressKeysRequest({ keys: ['cmd', 'l'], repeat: 3, intervalMs: 120, applicationId: 'com.x', policy: 3 })
  assertEqual(press.options, { keys: ['cmd', 'l'], count: 3, interval: 120 }, 'pressKeys options')
  assertEqual(press.target, { recipient: { case: 'applicationId', value: 'com.x' } }, 'pressKeys app recipient')
  assertEqual(press.policy, 3, 'pressKeys policy')
  assertEqual(press.dryRun, false, 'pressKeys dryRun')
  const foreground = format.buildPressKeysRequest({ keys: ['return'], policy: 3 })
  assertEqual(foreground.target, { recipient: { case: 'foreground', value: true } }, 'pressKeys foreground recipient')
  assertEqual(format.buildClickOptions({ button: undefined }), undefined, 'left click has no options')
  assertEqual(format.buildClickOptions({ button: 'right', mouseButton: 2 }), { button: 2 }, 'right click options')
  assertEqual(format.displaySelector('1'), { selector: { case: 'display', value: { displayId: '1' } } }, 'display selector')
  assertEqual(format.formatTargetString({ windowId: '9' }), 'window:9', 'target string window')
  assertEqual(format.formatTargetString({ applicationId: 'com.x' }), 'app:com.x', 'target string application')

  // Value mappers produce plain snake_case tool values.
  const row = format.mapWindowRow(
    {
      applicationName: 'App',
      applicationId: 'com.x',
      frame: { x: 1, y: 2, width: 300, height: 200 },
      isMain: true,
      isVisible: true,
      processId: 42,
      ref: { windowId: '9' },
      state: { isMinimized: true, isFocused: false, stackIndex: 2, desktop: { id: 'desk', isCurrent: true } },
      title: 'Title',
    },
    '9',
  )
  assertEqual(row.reference, { id: '9' }, 'mapped window reference id')
  assertEqual(row.application_id, 'com.x', 'mapped window application id')
  assertEqual(row.app_name, 'App', 'mapped window app name')
  assertEqual(row.frame, { origin: { x: 1, y: 2 }, size: { width: 300, height: 200 } }, 'mapped window frame')
  assertEqual(row.state.is_minimized, true, 'mapped window minimized state')
  assertEqual(row.state.desktop, 'desk', 'mapped window desktop scalar')
  const match = format.mapTextMatch({ text: 'OK', confidence: 0.9, bounds: { x: 1, y: 2, width: 30, height: 40 } })
  assertEqual(match, { bounds: { origin: { x: 1, y: 2 }, size: { width: 30, height: 40 } }, confidence: 0.9, text: 'OK' }, 'mapped text match')
  const frame = format.mapCapturedFrame({ backend: 'xcap.macos', scaleFactor: 1, bounds: { x: 0, y: 0, width: 100, height: 50 }, ref: { captureId: 'cap-1' } })
  assertEqual(frame.bounds, { origin: { x: 0, y: 0 }, size: { width: 100, height: 50 } }, 'mapped capture bounds')
  assertEqual(frame.scale_factor, 1, 'mapped capture scale factor')
  const sizedFrame = format.mapCapturedFrame({ scaleFactor: 2, pixelSize: { width: 200, height: 100 } })
  assertEqual(sizedFrame.pixel_dimensions, { width: 200, height: 100 }, 'mapped capture pixel dimensions')
  const activated = format.mapActivateResult({
    requestedApplicationId: 'com.x',
    applicationIdKind: 1,
    method: 1,
    verification: { verification: { case: 'foregroundMismatch', value: { observedApplicationId: 'com.y' } } },
  })
  assertEqual(activated.application_id_kind, 'bundle_id', 'mapped activation id kind')
  assertEqual(activated.method, 'apple_script_activate', 'mapped activation method')
  assertEqual(activated.verification.status, 'foreground_mismatch', 'mapped activation verification')
  const nullRow = format.mapWindowRow(null, '9')
  assertEqual(nullRow.reference.id, '9', 'mapWindowRow tolerates a null window')
  assertEqual(nullRow.application_id, null, 'mapWindowRow maps a missing application id to null')
}

async function checkAttachFirstDecision() {
  const sdk = await importSrc('transport/sdk.mjs')

  const makeRunner = () => ({ windows: {}, macos: {} })
  const makeConnection = (calls) => ({ close: async () => { calls.closed += 1 } })

  // 1) Nothing discoverable -> attach fails -> plugin starts (and owns) a daemon.
  {
    const calls = { connect: [], started: 0, closed: 0, stopped: 0 }
    const connection = makeConnection(calls)
    const runner = makeRunner()
    const daemon = {
      id: 'owned-daemon',
      pid: 4242,
      connectionOptions: { endpoint: 'unix:///tmp/owned.sock' },
      connect: async () => connection,
      stop: async () => {
        calls.stopped += 1
        return { code: 0, signal: null }
      },
      exited: new Promise(() => {}),
    }
    const deps = {
      connect: async (options) => {
        calls.connect.push(options)
        throw new Error('no AUV daemon discovered; run `auv serve`, set AUV_ENDPOINT, or pass endpoint')
      },
      createAuv: () => ({ health: { check: async () => ({ id: 'owned-daemon', status: 'serving' }) }, runner: () => runner }),
      startAuv: async () => {
        calls.started += 1
        return daemon
      },
      discoverEndpoint: async () => undefined,
      resolveBinary: () => '/fake/auv',
    }
    const state = sdk.createSdkTransportState()
    const facade = await sdk.initializeSdkTransport(state, deps)
    assertEqual(facade.mode, 'owned', 'attach failure must fall back to an owned daemon')
    assertEqual(calls.connect.length, 1, 'attach must be attempted exactly once')
    assertEqual(calls.connect[0].discover, true, "attach must use connect({ discover: true })")
    assertEqual(calls.started, 1, 'a daemon must be started only after attach fails')
    assertEqual(state.mode, 'owned', 'owned transport mode')
    assertEqual(state.pid, 4242, 'owned daemon pid')
    assertEqual(state.endpoint, 'unix:///tmp/owned.sock', 'owned daemon endpoint')
    assertEqual(state.attachError !== null, true, 'the failed attach reason is recorded for diagnostics')
    await sdk.disposeTransportState(state)
    assertEqual(calls.closed, 1, 'dispose of an owned transport closes the connection')
    assertEqual(calls.stopped, 1, 'dispose of an owned transport stops the daemon')
  }

  // 2) A discoverable daemon -> attach, never start; dispose leaves it running.
  {
    const calls = { started: 0, closed: 0, stopped: 0 }
    const connection = makeConnection(calls)
    const runner = makeRunner()
    const deps = {
      connect: async () => connection,
      createAuv: () => ({ health: { check: async () => ({ id: 'user-daemon', status: 'serving' }) }, runner: () => runner }),
      startAuv: async () => {
        calls.started += 1
        throw new Error('startAuv must not be called when a daemon is discoverable')
      },
      discoverEndpoint: async () => ({ endpoint: 'unix:///tmp/user.sock', local: false, transport: 'unix' }),
      resolveBinary: () => {
        throw new Error('the binary must not be resolved when attaching succeeds')
      },
    }
    const state = sdk.createSdkTransportState()
    const facade = await sdk.initializeSdkTransport(state, deps)
    assertEqual(facade.mode, 'attached', 'a discoverable daemon must be attached, not re-owned')
    assertEqual(calls.started, 0, 'attach-first must not start a daemon when one is discoverable')
    assertEqual(state.mode, 'attached', 'attached transport mode')
    assertEqual(state.endpoint, 'unix:///tmp/user.sock', 'attached endpoint')
    assertEqual(state.pid, null, 'attached daemons have no pid (not our process)')
    await sdk.disposeTransportState(state)
    assertEqual(calls.closed, 1, 'dispose of an attached transport closes its connection')
    assertEqual(calls.stopped, 0, 'dispose of an attached transport must not stop the user daemon')
  }

  // 3) A discovered daemon that fails its health check -> closed, then owned.
  {
    const calls = { started: 0, closed: 0, stopped: 0 }
    const connection = makeConnection(calls)
    const runner = makeRunner()
    const daemon = {
      id: 'owned-daemon-2',
      pid: 5252,
      connectionOptions: { endpoint: 'unix:///tmp/owned2.sock' },
      connect: async () => ({ close: async () => { calls.closed += 1 } }),
      stop: async () => {
        calls.stopped += 1
        return { code: 0, signal: null }
      },
      exited: new Promise(() => {}),
    }
    let healthCalls = 0
    const deps = {
      connect: async () => connection,
      createAuv: () => ({
        health: {
          check: async () => {
            healthCalls += 1
            if (healthCalls === 1) throw new Error('attached daemon health check failed')
            return { id: 'owned-daemon-2', status: 'serving' }
          },
        },
        runner: () => runner,
      }),
      startAuv: async () => {
        calls.started += 1
        return daemon
      },
      discoverEndpoint: async () => ({ endpoint: 'unix:///tmp/stale.sock' }),
      resolveBinary: () => '/fake/auv',
    }
    const state = sdk.createSdkTransportState()
    const facade = await sdk.initializeSdkTransport(state, deps)
    assertEqual(facade.mode, 'owned', 'a failed attach health check must fall back to an owned daemon')
    assertEqual(calls.closed, 1, 'the failed attach connection must be closed before starting')
    await sdk.disposeTransportState(state)
    assertEqual(calls.closed, 2, 'both the failed attach connection and the owned connection are closed')
    assertEqual(calls.stopped, 1, 'the owned daemon is stopped on dispose')
  }

  // 4) Singleton helpers start cold and stay safe to reset.
  sdk.resetSdkTransportState()
  const status = sdk.sdkTransportStatus()
  assertEqual(status.started, false, 'sdkTransportStatus().started must be false before any call')
  assertEqual(status.mode, null, 'sdkTransportStatus().mode must be null before any call')
  assertEqual(status.attachAttempted, false, 'sdkTransportStatus().attachAttempted must be false before any call')
  assertEqual(await sdk.disposeSdkTransport(), undefined, 'disposeSdkTransport must be a safe no-op when cold')
  sdk.resetSdkTransportState()
}

async function checkDoctorHelpers() {
  const format = await importSrc('transport/sdk-format.mjs')

  assertEqual(format.permissionStatusName(0), 'unknown', 'permission status 0')
  assertEqual(format.permissionStatusName(1), 'granted', 'permission status 1')
  assertEqual(format.permissionStatusName(2), 'missing', 'permission status 2')
  assertEqual(format.permissionStatusName(3), 'unknown', 'permission status 3')
  assertEqual(format.permissionStatusName(undefined), 'unknown', 'permission status missing value')

  const granted = format.summarizePermissions({ screenRecording: 1, screenCaptureKit: 1, accessibility: 1, automationToSystemEvents: 2 })
  assertEqual(granted, { accessibility: 'granted', screen_recording: 'granted', screen_capture_kit: 'granted', automation: 'missing' }, 'summarizePermissions')
  assertEqual(format.permissionsAllOk(granted), true, 'granted permissions are all_ok')
  assertEqual(format.summarizePermissions(null), null, 'summarizePermissions tolerates a missing probe')

  const missing = format.summarizePermissions({ screenRecording: 2, screenCaptureKit: 2, accessibility: 2, automationToSystemEvents: 2 })
  assertEqual(format.permissionsAllOk(missing), false, 'missing permissions are not all_ok')
  assertEqual(
    format.permissionsAllOk({ accessibility: 'granted', screen_recording: 'granted', screen_capture_kit: 'missing', automation: 'unknown' }),
    false,
    'a missing ScreenCaptureKit is not all_ok',
  )
  assert(typeof format.PERMISSION_RECOMMENDATION === 'string' && /System Settings/.test(format.PERMISSION_RECOMMENDATION), 'permission recommendation text')
}

async function checkNoCliRuntime() {
  const files = ['index.js', 'src/auv.mjs', 'src/tools.mjs', 'src/transport/sdk-format.mjs', 'src/transport/sdk.mjs']
  const forbidden = [
    { pattern: /node:child_process/, label: 'child_process import' },
    { pattern: /\bspawn\s*\(/, label: 'spawn()' },
    { pattern: /\bexecFile\b|\bexecSync\b/, label: 'exec helper' },
    { pattern: /--no-daemon|--credential-stdin|--no-overlay|--dry-run|--json\b/, label: 'CLI argv flags' },
    { pattern: /AUV_DSH_TRANSPORT|AUV_DSH_NO_DAEMON|AUV_DSH_OVERLAY|AUV_DSH_STORE_ROOT/, label: 'removed transport env var' },
    { pattern: /catalog\.(json|mjs|data)|generate-catalog|sync-catalog|buildInvokeArgs|summaryText|commandHelpText/, label: 'catalog path' },
    { pattern: /\brunAuv\b|\brunAuvDoctor\b|\breceiptFailure\b/, label: 'CLI runner helper' },
    { pattern: /'invoke'|"invoke"|`invoke`/, label: 'CLI invoke command' },
  ]
  for (const file of files) {
    const source = readFileSync(path.join(PLUGIN, file), 'utf8')
    for (const { pattern, label } of forbidden) {
      assert(!pattern.test(source), `${file} must not contain ${label} (${pattern})`)
    }
  }

  // Positive markers: the transport attaches before starting, and index.js
  // disposes the transport on unload.
  const transport = readFileSync(path.join(SRC, 'transport', 'sdk.mjs'), 'utf8')
  assert(/connect\(\s*\{\s*discover:\s*true/.test(transport), 'sdk.mjs must call connect({ discover: true })')
  assert(transport.indexOf('await tryAttach(') !== -1, 'sdk.mjs must attempt attach')
  assert(
    transport.indexOf('await tryAttach(') < transport.indexOf('await startOwnedDaemon('),
    'sdk.mjs must attempt attach before starting an owned daemon',
  )
  assert(/disposeTransportState/.test(transport), 'sdk.mjs must expose ownership-aware dispose')
  assert(/mode === 'owned' \? shared\.daemon : null/.test(transport), 'dispose must stop only an owned daemon')
  const index = readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
  assert(/disposeSdkTransport/.test(index), 'index.js must dispose the SDK transport on unload')
}

async function checkDiscoveryFallback() {
  const previousDescriptor = process.env.AUV_DISCOVERY_FILE
  const previousEndpoint = process.env.AUV_ENDPOINT
  process.env.AUV_DISCOVERY_FILE = path.join(os.tmpdir(), `dsh-auv-missing-descriptor-${process.pid}.json`)
  delete process.env.AUV_ENDPOINT
  try {
    const { connect } = await import('@auv-js/sdk/node')
    const started = Date.now()
    await assertRejects(
      () => connect({ discover: true, signal: AbortSignal.timeout(2_000) }),
      /no AUV daemon discovered/,
      'connect({ discover: true }) must report when nothing is discoverable',
    )
    const elapsed = Date.now() - started
    assert(elapsed < 2_000, `a missing descriptor must fail fast, took ${elapsed} ms`)
  } finally {
    if (previousDescriptor === undefined) delete process.env.AUV_DISCOVERY_FILE
    else process.env.AUV_DISCOVERY_FILE = previousDescriptor
    if (previousEndpoint === undefined) delete process.env.AUV_ENDPOINT
    else process.env.AUV_ENDPOINT = previousEndpoint
  }
}

async function checkOfflineExecuteGuards() {
  const previousBin = process.env.AUV_BIN
  const previousDescriptor = process.env.AUV_DISCOVERY_FILE
  const previousEndpoint = process.env.AUV_ENDPOINT
  process.env.AUV_BIN = path.join(ROOT, 'missing-auv-for-test')
  process.env.AUV_DISCOVERY_FILE = path.join(os.tmpdir(), `dsh-auv-missing-descriptor-guards-${process.pid}.json`)
  delete process.env.AUV_ENDPOINT
  try {
    const { createTools } = await importSrc('tools.mjs')
    const sdk = await importSrc('transport/sdk.mjs')
    const auv = await importSrc('auv.mjs')
    auv.resetAuvBinaryCache()
    sdk.resetSdkTransportState()
    const byName = new Map(createTools().map((tool) => [tool.name, tool]))
    const exec = { signal: new AbortController().signal }

    // Validation happens before any transport work; no daemon may be started.
    await assertRejects(() => byName.get('auv_click').execute({}, exec), /requires either "text"/, 'auv_click must reject an empty click')
    await assertRejects(() => byName.get('auv_click').execute({ text: 'OK', x: 1, y: 2 }, exec), /not both forms/, 'auv_click must reject text plus coordinates')
    await assertRejects(() => byName.get('auv_type').execute({}, exec), /Missing required parameter "text"/, 'auv_type must require text')
    await assertRejects(() => byName.get('auv_keys').execute({ keys: [] }, exec), /non-empty array/, 'auv_keys must require a non-empty keys array')
    await assertRejects(() => byName.get('auv_keys').execute({ keys: ['a'], interval_ms: 50 }, exec), /only valid with repeat/, 'auv_keys must reject interval_ms without repeat')
    await assertRejects(() => byName.get('auv_keys').execute({ keys: ['a'], repeat: 2, interval_ms: 0 }, exec), /positive integer/, 'auv_keys must reject a non-positive interval_ms')
    await assertRejects(() => byName.get('auv_scroll').execute({}, exec), /requires "dy"/, 'auv_scroll must require dy')
    await assertRejects(() => byName.get('auv_ocr').execute({ text: 'Hello', timeout_ms: 5000 }, exec), /only valid with wait/, 'auv_ocr must reject timeout_ms without wait')
    await assertRejects(() => byName.get('auv_screenshot').execute({ window_id: '1', display_id: '1' }, exec), /only one of/, 'auv_screenshot must reject competing targets')
    if (process.platform === 'darwin') {
      await assertRejects(
        () => byName.get('auv_scroll').execute({ dy: 10, x: 1, y: 2 }, exec),
        /macOS cannot scroll at a screen point/,
        'auv_scroll must fail fast for screen-point scrolling on macOS',
      )
    }
    const status = sdk.sdkTransportStatus()
    assertEqual(status.started, false, 'validation failures must not start the transport')
    assertEqual(status.attachAttempted, false, 'validation failures must not even attempt to attach')

    // auv_doctor never throws: with no discoverable daemon and a broken AUV_BIN
    // it returns a diagnostic report carrying the install guidance.
    const doctor = byName.get('auv_doctor')
    const report = await doctor.execute({}, exec)
    assertEqual(report.all_ok, false, 'doctor must report all_ok:false when the transport cannot start')
    assertEqual(report.permissions_checked, false, 'doctor must not claim permissions were checked')
    assert(typeof report.error === 'string' && report.error.includes('brew install moeru-ai/tap/auv'), 'doctor error must include the AUV install commands')
    assert(typeof report.recommendation === 'string' && report.recommendation !== '', 'doctor must include a recommendation')
    const rendered = doctor.output.render({}, report)
    assert(Array.isArray(rendered) && /not fully ready/.test(rendered[0].text), 'doctor render must explain the failure')
    assertEqual(sdk.sdkTransportStatus().started, false, 'the failed doctor call must not leave a daemon running')
    sdk.resetSdkTransportState()
  } finally {
    if (previousBin === undefined) delete process.env.AUV_BIN
    else process.env.AUV_BIN = previousBin
    if (previousDescriptor === undefined) delete process.env.AUV_DISCOVERY_FILE
    else process.env.AUV_DISCOVERY_FILE = previousDescriptor
    if (previousEndpoint === undefined) delete process.env.AUV_ENDPOINT
    else process.env.AUV_ENDPOINT = previousEndpoint
    const auv = await importSrc('auv.mjs')
    auv.resetAuvBinaryCache()
  }
}

async function checkBundle() {
  const distPath = path.join(PLUGIN, 'dist', 'index.mjs')
  assert(existsSync(distPath), 'dist/index.mjs is missing; run `pnpm build` (tsdown) and commit dist/')

  const source = readFileSync(distPath, 'utf8')
  const relativeImports = [...source.matchAll(/^import\s+(?:[^'"]+from\s+)?["']([^"']+)["']/gm)].map((match) => match[1])
  const nonNodeImports = relativeImports.filter((specifier) => !specifier.startsWith('node:'))
  assert(nonNodeImports.length === 0, `dist/index.mjs must only import node: builtins, found: ${nonNodeImports.join(', ')}`)
  assert(!source.includes('import("./') && !source.includes("import('./"), 'dist/index.mjs must not dynamically import local modules')

  // The @auv-js/sdk node graph must be inlined into the single-file bundle.
  const distSize = statSync(distPath).size
  assert(distSize > 600_000, `dist/index.mjs should inline @auv-js/sdk (>600 kB); got ${distSize} bytes (run pnpm build)`)
  assert(
    source.includes('AUV daemon exited before becoming healthy') || source.includes('@grpc/grpc-js'),
    'dist/index.mjs must inline the @auv-js/sdk daemon/gRPC client (marker strings missing; run pnpm build)',
  )
  assert(source.includes('no AUV daemon discovered'), 'dist/index.mjs must inline the SDK discovery client')
  for (const marker of ['auv_help', 'auv_invoke', 'AUV_DSH_TRANSPORT', 'AUV_DSH_NO_DAEMON', 'generate-catalog']) {
    assert(!source.includes(marker), `dist/index.mjs must not contain retired CLI/catalog marker ${marker}`)
  }

  const bundle = await import(`${pathToFileURL(distPath).href}?check=${Date.now()}`)
  assertEqual(bundle.inject, ['tools'], "bundle must export inject = ['tools']")
  assert(typeof bundle.apply === 'function', 'bundle must export apply(ctx)')
  const registered = []
  const disposers = []
  bundle.apply({
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
    effect(callback) {
      disposers.push(callback())
    },
  })
  assertEqual(registered.length, 9, 'bundled apply() should register 9 tools')
  assert(new Set(registered.map((definition) => definition.name)).size === 9, 'bundled apply() registered duplicate tool names')
  assertEqual(
    registered.map((definition) => definition.name).sort(),
    Object.keys(EXPECTED).sort(),
    'bundled tool names must match the 9-tool surface',
  )
  assertEqual(disposers.length, 1, 'bundled apply() must register the SDK transport dispose effect')
  assert(typeof disposers[0] === 'function', 'bundled dispose effect must return a disposer')
  await disposers[0]()
}

async function main() {
  console.log('AUV plugin offline self-check')
  console.log(`plugin: ${PLUGIN}`)

  await check('missing AUV guidance', checkMissingAuvGuidance)
  await check('tool definitions (9, SDK-only)', checkToolDefinitions)
  await check('plugin entry point', checkEntryPoint)
  await check('manifest, resources, retired files', checkManifestAndResources)
  await check('SDK argument mapping', checkSdkArgumentMapping)
  await check('attach-first decision and ownership', checkAttachFirstDecision)
  await check('SDK doctor report helpers', checkDoctorHelpers)
  await check('no CLI or catalog in runtime source', checkNoCliRuntime)
  await check('discovery falls back quickly when no daemon exists', checkDiscoveryFallback)
  await check('offline execute guards', checkOfflineExecuteGuards)
  await check('bundled dist/index.mjs', checkBundle)

  console.log('')
  if (failures.length === 0) {
    console.log(`RESULT: ${passed} checks passed, 0 failed.`)
    return 0
  }
  console.log(`RESULT: ${passed} checks passed, ${failures.length} failed:`)
  for (const failure of failures) console.log(`  - ${failure.label}: ${failure.detail}`)
  return 1
}

const exitCode = await main()
process.exitCode = exitCode
