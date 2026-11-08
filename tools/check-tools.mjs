#!/usr/bin/env node
/**
 * Offline self-check for the @local/dsh-auv bundle.
 *
 * Imports the plugin entry, the tool definitions, the transport, and (when
 * present) the built bundle, then asserts that:
 *   - every ToolDefinition is well formed and its JSON Schemas stay inside the
 *     DSH-enforced schema subset;
 *   - the twelve auv_* tools exist with the expected parameters, description
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
 *   - the bundled dist/index.mjs registers the twelve tools and inlines the SDK.
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
// Expected tool surface (11 SDK-only tools, 0.2.0)
// ---------------------------------------------------------------------------

const EXPECTED = {
  auv_doctor: { required: [], properties: [] },
  auv_screenshot: { required: [], properties: ['window_id', 'application_id', 'display_id', 'region'] },
  auv_ocr: { required: ['text'], properties: ['text', 'window_id', 'application_id', 'wait', 'timeout_ms'] },
  auv_click: {
    required: [],
    properties: ['text', 'x', 'y', 'window_id', 'application_id', 'display_id', 'space', 'button', 'within', 'allow_repeat'],
  },
  auv_type: { required: ['text'], properties: ['text', 'mode', 'window_id', 'application_id', 'policy', 'allow_repeat'] },
  auv_keys: {
    required: ['keys'],
    properties: ['keys', 'repeat', 'interval_ms', 'window_id', 'application_id', 'policy', 'focus', 'allow_repeat'],
  },
  auv_scroll: { required: ['dy'], properties: ['dy', 'dx', 'window_id', 'x', 'y', 'allow_repeat'] },
  auv_drag: {
    required: ['from', 'to'],
    properties: ['from', 'to', 'space', 'window_id', 'application_id', 'display_id', 'button', 'duration_ms', 'activate', 'allow_repeat'],
  },
  auv_capture_state: { required: [], properties: ['window_id', 'application_id', 'display_id', 'region'] },
  auv_wait_for_change: {
    required: [],
    properties: [
      'window_id',
      'application_id',
      'display_id',
      'region',
      'state_token',
      'baseline_hash',
      'timeout_ms',
      'interval_ms',
      'min_changed_ratio',
      'pixel_threshold',
    ],
  },
  auv_windows: { required: [], properties: ['include_minimized', 'include_other_desktops'] },
  auv_activate: { required: ['application_id'], properties: ['application_id'] },
}

const DESCRIPTION_LIMITS = { default: 1_200 }
const PERMISSION_TOOLS = [
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
]

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
  assert(tools.length === 12, `expected 12 tools, got ${tools.length}`)

  const names = tools.map((tool) => tool?.name)
  assertEqual([...names].sort(), [...TOOL_NAMES].sort(), 'tool names must match TOOL_NAMES')
  assertEqual([...names].sort(), Object.keys(EXPECTED).sort(), 'tool names must match the 12-tool SDK-only surface')
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
  assert(registered.length === 12, `apply() should register 12 tools, registered ${registered.length}`)
  assert(new Set(registered.map((definition) => definition.name)).size === 12, 'apply() registered duplicate tool names')
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

  // A change that happened before the call: a provided baseline must be used
  // as the first comparison instead of capturing a new baseline.
  const providedChanged = await format.pollForChange({
    captureSnapshot: async () => 'thumbhash:same',
    compare: (before, after) => ({ changed: before !== after, ratio: before !== after ? 1 : 0 }),
    baseline: 'thumbhash:before',
    timeoutMs: 300,
    intervalMs: 50,
  })
  assertEqual(providedChanged.result, 'changed', 'provided baseline detects a change that already happened')
  assertEqual(providedChanged.changedRatio, 1, 'provided baseline change ratio')
  const providedSame = await format.pollForChange({
    captureSnapshot: async () => 'thumbhash:same',
    compare: (before, after) => ({ changed: before !== after, ratio: before !== after ? 1 : 0 }),
    baseline: 'thumbhash:same',
    timeoutMs: 150,
    intervalMs: 50,
  })
  assertEqual(providedSame.result, 'timeout', 'provided identical baseline times out')
  await assertRejects(
    () => format.parseWaitForChangeArgs({ baseline_hash: 'not-a-hash' }),
    /baseline_hash/,
    'baseline_hash format is validated',
  )

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
  // x/y coordinate space (round 2: Unity/Canvas-safe screen clicks).
  assertEqual(format.parseClickArgs({ x: 1, y: 2 }).space, 'screen', 'auv_click defaults to screen space')
  assertEqual(format.parseClickArgs({ x: 1, y: 2, window_id: 'w' }).space, 'window', 'auv_click defaults to window space with a window target')
  assertEqual(format.parseClickArgs({ x: 1, y: 2, application_id: 'a' }).space, 'window', 'auv_click defaults to window space with an application target')
  assertEqual(format.parseClickArgs({ x: 1, y: 2, display_id: 'd' }).space, 'screen', 'auv_click defaults to screen space with display_id')
  assertEqual(format.parseClickArgs({ x: 1, y: 2, window_id: 'w', space: 'screen' }).space, 'screen', 'auv_click accepts screen space with a window target')
  assertEqual(format.parseClickArgs({ x: 1, y: 2, display_id: 'd', space: 'display' }).space, 'display', 'auv_click accepts display space')
  await assertRejects(() => format.parseClickArgs({ x: 1, y: 2, space: 'window' }), /space: "window" requires/, 'auv_click window space needs a target')
  await assertRejects(() => format.parseClickArgs({ x: 1, y: 2, space: 'display' }), /space: "display" requires/, 'auv_click display space needs display_id')
  await assertRejects(() => format.parseClickArgs({ text: 'OK', space: 'screen' }), /space applies only to x\/y/, 'auv_click rejects space with text clicks')

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

async function checkDragAndCoordinateMapping() {
  const format = await importSrc('transport/sdk-format.mjs')
  const from = { x: 10, y: 20 }
  const to = { x: 110, y: 70 }

  // Plan defaults and target-based space inference.
  assertEqual(format.parseDragArgs({ from, to }), {
    from,
    to,
    space: 'screen',
    windowId: undefined,
    applicationId: undefined,
    displayId: undefined,
    button: 'left',
    durationMs: 300,
    activate: false,
    allowRepeat: false,
  }, 'auv_drag screen defaults')
  const windowPlan = format.parseDragArgs({ from, to, window_id: 'w1' })
  assertEqual(windowPlan.space, 'window', 'a window target infers window space')
  assertEqual(windowPlan.activate, true, 'a window target activates by default')
  const displayPlan = format.parseDragArgs({ from, to, display_id: 'd1' })
  assertEqual(displayPlan.space, 'display', 'display_id infers display space')
  assertEqual(displayPlan.activate, false, 'display drags do not activate')
  assertEqual(format.parseDragArgs({ from, to, window_id: 'w1', space: 'screen' }).space, 'screen', 'explicit screen space with a window target')
  assertEqual(format.parseDragArgs({ from, to, window_id: 'w1', activate: false }).activate, false, 'activate can be turned off')
  assertEqual(format.parseDragArgs({ from, to, button: 'right', duration_ms: 0 }).durationMs, 0, 'duration 0 is allowed')
  await assertRejects(() => format.parseDragArgs({}), /Missing required parameter "from"/, 'auv_drag requires from')
  await assertRejects(() => format.parseDragArgs({ from, to, duration_ms: 30_001 }), /between 0 and 30000/, 'auv_drag duration bounds')
  await assertRejects(() => format.parseDragArgs({ from, to, window_id: 'w', application_id: 'a' }), /only one of/, 'auv_drag target exclusivity')
  await assertRejects(() => format.parseDragArgs({ from, to, window_id: 'w', display_id: 'd' }), /not both/, 'auv_drag rejects window+display')
  await assertRejects(() => format.parseDragArgs({ from, to, space: 'window' }), /requires window_id or application_id/, 'auv_drag window space needs a target')
  await assertRejects(() => format.parseDragArgs({ from, to, space: 'display' }), /requires display_id/, 'auv_drag display space needs display_id')
  await assertRejects(() => format.parseDragArgs({ from, to, display_id: 'd', space: 'screen' }), /only valid with space/, 'auv_drag rejects display_id outside display space')
  await assertRejects(() => format.parseDragArgs({ from: { x: 1 }, to }), /from\.x and from\.y must be finite/, 'auv_drag validates point coordinates')

  // Straight-line drag curve (the AUV CLI's construction).
  const movement = format.buildDragMovement({ startScreen: { x: 100, y: 200 }, endScreen: { x: 400, y: 350 }, durationMs: 300 })
  assertEqual(movement.start, { source: { case: 'point', value: { x: 100, y: 200 } } }, 'drag start point')
  assertEqual(movement.curve.start, { x: 0, y: 0 }, 'drag curve start (required by the Runner)')
  assertEqual(movement.mapping, { width: 1, height: 1 }, 'drag curve mapping scale 1')
  assertEqual(movement.curve.segments.length, 1, 'drag has one Bézier segment')
  assertEqual(movement.curve.segments[0].control1, { x: 100, y: 50 }, 'drag control1')
  assertEqual(movement.curve.segments[0].control2, { x: 200, y: 100 }, 'drag control2')
  assertEqual(movement.curve.segments[0].end, { x: 300, y: 150 }, 'drag segment end')
  assertEqual(movement.options, { duration: 300, sampleRateHz: 60, curveTolerance: 0.5 }, 'drag motion options')
  assertEqual(Object.hasOwn(movement, 'target'), false, 'drag is delivered to the foreground (no target)')

  // Window/display -> screen conversion.
  const windowFrame = { x: 100, y: 200, width: 400, height: 300 }
  const displayFrame = { x: 50, y: 60, width: 1920, height: 1080 }
  assertEqual(format.screenPointFromWindowPoint({ x: 10, y: 20 }, windowFrame), { x: 110, y: 220 }, 'window point -> screen point')
  assertEqual(format.windowPointFromScreenPoint({ x: 110, y: 220 }, windowFrame), { x: 10, y: 20 }, 'screen point -> window point')
  assertEqual(format.screenPointFromDisplayPoint({ x: 8, y: 9 }, displayFrame), { x: 58, y: 69 }, 'display point -> screen point')
  assertEqual(format.displayPointFromScreenPoint({ x: 58, y: 69 }, displayFrame), { x: 8, y: 9 }, 'screen point -> display point')
  assertEqual(format.flatRect({ origin: { x: 1, y: 2 }, size: { width: 10, height: 20 } }), { x: 1, y: 2, width: 10, height: 20 }, 'mapped rect -> flat rect')
  assertEqual(format.flatRect({ x: 1, y: 2, width: 10, height: 20 }), { x: 1, y: 2, width: 10, height: 20 }, 'flat rect passthrough')
  assertEqual(format.rectCenter({ x: 0, y: 0, width: 10, height: 20 }), { x: 5, y: 10 }, 'rect center')
  assertEqual(format.normalizePoint({ x: 3, y: 4 }), { x: 3, y: 4 }, 'normalizePoint')
  assertEqual(format.normalizePoint({ x: 'nope', y: 4 }), null, 'normalizePoint rejects non-finite values')

  // image_pixel = (screen_point - bounds.origin) * pixel_ratio.
  const capture = { bounds: { x: 100, y: 200, width: 1000, height: 500 }, pixelSize: { width: 2000, height: 1000 }, scaleFactor: 2 }
  assertEqual(format.capturePixelRatio(capture), 2, 'capture pixel ratio from pixelSize/bounds')
  assertEqual(format.imagePixelFromScreenPoint({ x: 600, y: 450 }, capture), { x: 1000, y: 500 }, 'screen point -> image pixel')
  const mappedCapture = { bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 50 } }, pixel_dimensions: { width: 100, height: 50 }, scale_factor: 1 }
  assertEqual(format.imagePixelFromScreenPoint({ x: 10, y: 5 }, mappedCapture), { x: 10, y: 5 }, 'image pixel from the mapped capture shape')
  const enriched = format.enrichTextMatches(
    [{ text: 'OK', confidence: 1, bounds: { origin: { x: 110, y: 220 }, size: { width: 20, height: 10 } } }],
    capture,
    windowFrame,
  )
  assertEqual(enriched[0].screen_point, { x: 120, y: 225 }, 'enriched match screen point')
  assertEqual(enriched[0].image_pixel, { x: 40, y: 50 }, 'enriched match image pixel')
  assertEqual(enriched[0].window_point, { x: 20, y: 25 }, 'enriched match window point')
  assertEqual(enriched[0].scale_factor, 2, 'enriched match scale factor')
  assertEqual(enriched[0].pixel_ratio, 2, 'enriched match pixel ratio')
  assertEqual(enriched[0].bounds, { origin: { x: 110, y: 220 }, size: { width: 20, height: 10 } }, 'enriched match keeps bounds')
  assertEqual(format.enrichTextMatches([], null, null), [], 'enrichTextMatches empty input')
}

async function checkDragRequestThroughSdkMock() {
  const { InputService, connect, createAuv, createMockTransport } = await import('@auv-js/sdk/node')
  const format = await importSrc('transport/sdk-format.mjs')

  // The real SDK method wrapper + generated Protobuf schema, answered by an
  // in-memory mock transport: no daemon and no real input is involved.
  let received = null
  const transport = createMockTransport(({ service }) => {
    service(InputService, {
      dragMouse: (request) => {
        received = request
        return { point: { x: 460, y: 310 }, action: { verified: true } }
      },
    })
  })
  const connection = await connect({ transport })
  try {
    const auv = createAuv(connection)
    const runner = auv.runner({ runnerClass: 'auv.core.local' })
    const movement = format.buildDragMovement({ startScreen: { x: 100, y: 200 }, endScreen: { x: 400, y: 350 }, durationMs: 300 })
    const response = await runner.input.dragMouse({ movement, button: format.MOUSE_BUTTON_VALUES.left })
    assert(received !== null, 'the mock input service did not receive a DragMouse request')
    assertEqual(received.$typeName, 'auv.api.driver.v1.DragMouseRequest', 'the SDK serialized a DragMouseRequest')
    assertEqual(received.button, 1, 'the SDK serialized the left mouse button')
    assertEqual(received.movement.start.source.case, 'point', 'the drag start is a screen point')
    assertEqual(
      { x: received.movement.start.source.value.x, y: received.movement.start.source.value.y },
      { x: 100, y: 200 },
      'the SDK serialized the drag start point',
    )
    assertEqual(received.movement.curve.segments.length, 1, 'the SDK serialized one Bézier segment')
    const segment = received.movement.curve.segments[0]
    assertEqual(
      { control1: { x: segment.control1.x, y: segment.control1.y }, control2: { x: segment.control2.x, y: segment.control2.y }, end: { x: segment.end.x, y: segment.end.y } },
      { control1: { x: 100, y: 50 }, control2: { x: 200, y: 100 }, end: { x: 300, y: 150 } },
      'the SDK serialized the straight-line Bézier curve',
    )
    assertEqual(received.movement.options.sampleRateHz, 60, 'the SDK serialized sampleRateHz')
    assertEqual(received.movement.options.curveTolerance, 0.5, 'the SDK serialized curveTolerance')
    assertEqual(Number(received.movement.options.duration.seconds), 0, 'the SDK converted duration ms -> Duration seconds')
    assertEqual(Number(received.movement.options.duration.nanos), 300_000_000, 'the SDK converted duration ms -> Duration nanos')
    assertEqual(received.movement.target, undefined, 'the drag has no target (foreground delivery)')
    assertEqual(Number(response.point.x), 460, 'the mock drag response is normalized back')
  } finally {
    await connection.close()
  }
}

async function checkWaitForChangeLogic() {
  const format = await importSrc('transport/sdk-format.mjs')

  // Plan defaults/validation.
  const waitPlan = format.parseWaitForChangeArgs({})
  assertEqual(
    {
      timeoutMs: waitPlan.timeoutMs,
      intervalMs: waitPlan.intervalMs,
      windowId: waitPlan.windowId,
      region: waitPlan.region,
      stateToken: waitPlan.stateToken,
      baselineHash: waitPlan.baselineHash,
      minChangedRatio: waitPlan.minChangedRatio,
      pixelThreshold: waitPlan.pixelThreshold,
    },
    {
      timeoutMs: 5_000,
      intervalMs: 200,
      windowId: undefined,
      region: undefined,
      stateToken: undefined,
      baselineHash: undefined,
      minChangedRatio: 0.01,
      pixelThreshold: 24,
    },
    'auv_wait_for_change defaults',
  )
  assertEqual(format.parseWaitForChangeArgs({ window_id: 'w1', timeout_ms: 100, interval_ms: 50 }).timeoutMs, 100, 'wait timeout parsing')
  assertEqual(format.parseWaitForChangeArgs({ display_id: 'd1', region: { x: 0, y: 0, width: 10, height: 10 } }).displayId, 'd1', 'wait allows region on a display')
  const tuned = format.parseWaitForChangeArgs({ state_token: 'tok', min_changed_ratio: 0.5, pixel_threshold: 40 })
  assertEqual(tuned.stateToken, 'tok', 'wait state_token parsing')
  assertEqual(tuned.minChangedRatio, 0.5, 'wait min_changed_ratio parsing')
  assertEqual(tuned.pixelThreshold, 40, 'wait pixel_threshold parsing')
  await assertRejects(() => format.parseWaitForChangeArgs({ timeout_ms: 50 }), /between 100 and 120000/, 'wait timeout lower bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ timeout_ms: 120_001 }), /between 100 and 120000/, 'wait timeout upper bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ interval_ms: 10 }), /between 50 and 5000/, 'wait interval lower bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ interval_ms: 5_001 }), /between 50 and 5000/, 'wait interval upper bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ min_changed_ratio: -0.1 }), /between 0 and 1/, 'wait min_changed_ratio lower bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ min_changed_ratio: 1.1 }), /between 0 and 1/, 'wait min_changed_ratio upper bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ pixel_threshold: -1 }), /between 0 and 255/, 'wait pixel_threshold lower bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ pixel_threshold: 256 }), /between 0 and 255/, 'wait pixel_threshold upper bound')
  await assertRejects(() => format.parseWaitForChangeArgs({ pixel_threshold: 1.5 }), /must be an integer/, 'wait pixel_threshold must be an integer')
  await assertRejects(() => format.parseWaitForChangeArgs({ window_id: 'w', application_id: 'a' }), /only one of/, 'wait target exclusivity')
  await assertRejects(
    () => format.parseWaitForChangeArgs({ window_id: 'w', region: { x: 0, y: 0, width: 10, height: 10 } }),
    /region is only supported/,
    'wait rejects a region with a window target',
  )

  // ThumbHash helpers.
  assertEqual(format.thumbhashOf({ thumbhash: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }), 'thumbhash:deadbeef', 'ThumbHash hex')
  assertEqual(format.thumbhashOf({ thumbhash: new Uint8Array() }), null, 'an empty ThumbHash is absent')
  assertEqual(format.thumbhashOf({}), null, 'a missing ThumbHash is absent')

  // Fake clock + fake snapshot sequence: change after two identical snapshots.
  let clock = 1_000
  const sleep = async (ms) => {
    clock += ms
  }
  const changedSeq = ['aa', 'aa', 'bb']
  let changedIndex = 0
  const changed = await format.pollForChange({
    captureSnapshot: async () => changedSeq[Math.min(changedIndex++, changedSeq.length - 1)],
    compare: (before, after) => ({ changed: before !== after, ratio: before !== after ? 1 : 0 }),
    intervalMs: 100,
    timeoutMs: 1_000,
    now: () => clock,
    sleep,
  })
  assertEqual(changed.result, 'changed', 'poll detects a changed snapshot')
  assertEqual(changed.changed, true, 'poll changed flag')
  assertEqual(changed.elapsedMs, 200, 'poll change elapsed')
  assertEqual(changed.before, 'aa', 'poll before snapshot')
  assertEqual(changed.after, 'bb', 'poll after snapshot')
  assertEqual(changed.changedRatio, 1, 'poll change ratio')

  // Constant snapshots run into the timeout.
  clock = 0
  const timedOut = await format.pollForChange({
    captureSnapshot: async () => 'aa',
    compare: (before, after) => ({ changed: before !== after, ratio: before !== after ? 1 : 0 }),
    intervalMs: 100,
    timeoutMs: 250,
    now: () => clock,
    sleep,
  })
  assertEqual(timedOut.result, 'timeout', 'poll times out without a change')
  assertEqual(timedOut.changed, false, 'poll timeout changed flag')
  assertEqual(timedOut.elapsedMs, 250, 'poll timeout elapsed')

  // Aborting before the deadline stops early without a change.
  clock = 0
  const controller = new AbortController()
  const aborted = await format.pollForChange({
    captureSnapshot: async () => 'aa',
    compare: (before, after) => ({ changed: before !== after, ratio: before !== after ? 1 : 0 }),
    intervalMs: 100,
    timeoutMs: 1_000,
    signal: controller.signal,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      if (clock >= 200) controller.abort()
    },
  })
  assertEqual(aborted.result, 'no_effect', 'an aborted poll reports no_effect')
  assertEqual(aborted.changed, false, 'an aborted poll is not a change')
}

async function checkPixelDiffAndStateStore() {
  const format = await importSrc('transport/sdk-format.mjs')

  const makeFrame = (width, height, mutate) => {
    const data = new Uint8Array(width * height * 4)
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 10
      data[index + 1] = 20
      data[index + 2] = 30
      data[index + 3] = 255
    }
    if (typeof mutate === 'function') mutate(data)
    return { width, height, data }
  }

  // Pixel-diff ratio and per-channel threshold.
  const base = makeFrame(10, 10)
  assertEqual(format.compareRgbaFrames(base, makeFrame(10, 10), 24), {
    changedRatio: 0,
    differingPixels: 0,
    comparedPixels: 100,
    dimensionMismatch: false,
  }, 'identical RGBA frames have ratio 0')
  const oneNoise = makeFrame(10, 10, (data) => {
    data[0] = 34 // exactly threshold above 10: not greater than 24
  })
  assertEqual(format.compareRgbaFrames(base, oneNoise, 24).differingPixels, 0, 'a change equal to pixel_threshold is ignored')
  const oneAbove = makeFrame(10, 10, (data) => {
    data[0] = 35 // 25 above 10: greater than 24
  })
  assertEqual(format.compareRgbaFrames(base, oneAbove, 24).differingPixels, 1, 'a change above pixel_threshold counts')
  assertEqual(format.compareRgbaFrames(base, oneAbove, 24).changedRatio, 0.01, 'pixel ratio counts changed pixels over total')
  const manyAbove = makeFrame(10, 10, (data) => {
    for (let index = 0; index < 40; index += 4) data[index] = 255
  })
  assertEqual(format.compareRgbaFrames(base, manyAbove, 24).changedRatio, 0.1, '10 of 100 pixels changed -> 0.1')
  const alphaOnly = makeFrame(10, 10, (data) => {
    for (let index = 0; index < data.length; index += 4) data[index + 3] = 0
  })
  assertEqual(format.compareRgbaFrames(base, alphaOnly, 0).changedRatio, 0, 'alpha changes are ignored')
  const resized = makeFrame(5, 5)
  assertEqual(format.compareRgbaFrames(base, resized, 24), {
    changedRatio: 1,
    differingPixels: 100,
    comparedPixels: 100,
    dimensionMismatch: true,
  }, 'a dimension change counts as fully changed')
  await assertRejects(() => format.compareRgbaFrames({ width: 0, height: 10, data: new Uint8Array() }, base, 24), /positive integer/, 'compareRgbaFrames validates dimensions')
  await assertRejects(() => format.compareRgbaFrames({ width: 10, height: 10, data: new Uint8Array(4) }, base, 24), /shorter than/, 'compareRgbaFrames validates pixel data length')

  // Threshold gating.
  assertEqual(format.frameChanged({ changedRatio: 0 }, 0.01), false, 'ratio 0 is never a change')
  assertEqual(format.frameChanged({ changedRatio: 0.005 }, 0.01), false, 'ratio below min_changed_ratio is not a change')
  assertEqual(format.frameChanged({ changedRatio: 0.01 }, 0.01), true, 'ratio equal to min_changed_ratio is a change')
  assertEqual(format.frameChanged({ changedRatio: 0.0001 }, 0), true, 'min_changed_ratio 0 means any non-zero change')
  assertEqual(format.frameChanged({ changedRatio: 1 }, 0.5), true, 'ratio above min_changed_ratio is a change')

  // LRU + TTL capture-state store.
  let clock = 1_000
  const store = format.createCaptureStateStore({ maxEntries: 3, ttlMs: 1_000, now: () => clock })
  store.put('a', { width: 1 })
  store.put('b', { width: 2 })
  store.put('c', { width: 3 })
  assertEqual(store.size, 3, 'store tracks entries')
  assertEqual(store.get('a'), { width: 1 }, 'store returns values')
  clock = 1_500
  store.get('a') // touch: a is now most recently used
  store.put('d', { width: 4 })
  assertEqual(store.size, 3, 'store evicts above maxEntries')
  assertEqual(store.get('b'), null, 'LRU evicts the least recently used entry')
  assert(store.get('a') !== null, 'a touched entry survives')
  clock = 2_600
  assertEqual(store.get('a'), null, 'store expires entries past the TTL')
  assertEqual(store.size, 2, 'expired entry is removed')
  store.clear()
  assertEqual(store.size, 0, 'store clears')
  await assertRejects(() => store.put('', {}), /non-empty string/, 'store validates tokens')

  // Target identity helpers used by the state store/diagnostics.
  assertEqual(format.captureTargetKey({ window_id: 'w1' }), 'window:w1', 'target key window')
  assertEqual(format.captureTargetKey({ application_id: 'com.x' }), 'app:com.x', 'target key app')
  assertEqual(format.captureTargetKey({ display_id: 'd1' }), 'display:d1', 'target key display')
  assertEqual(format.captureTargetKey({ region: { x: 1, y: 2, width: 3, height: 4 } }), 'region:1,2,3,4', 'target key region')
  assertEqual(format.captureTargetKey({}), 'screen', 'target key screen')
  assertEqual(
    format.captureTargetPlan({ window_id: 'w1', region: { x: 1, y: 2, width: 3, height: 4 } }),
    { windowId: 'w1', applicationId: undefined, displayId: undefined, region: { x: 1, y: 2, width: 3, height: 4 } },
    'captureTargetPlan copies the target',
  )
}

async function checkKeysPlanning() {
  const format = await importSrc('transport/sdk-format.mjs')

  const plain = format.parseKeysArgs({ keys: ['cmd', 'l'] })
  assertEqual(plain.focus, false, 'keys focus defaults to false without a target')
  assertEqual(plain.policy, undefined, 'keys policy is unset by default')
  assertEqual(format.planKeysDelivery(plain), {
    targeted: false,
    effectivePolicy: 'foreground-preferred',
    focus: false,
    focusTarget: null,
    deliveryVia: 'foreground',
  }, 'foreground keys planning')

  const targeted = format.parseKeysArgs({ keys: ['cmd', 'l'], window_id: 'w1', policy: 'background-preferred', focus: false })
  assertEqual(targeted.focus, false, 'focus can be turned off for a target')
  assertEqual(
    format.planKeysDelivery(targeted),
    { targeted: true, effectivePolicy: 'background-preferred', focus: false, focusTarget: null, deliveryVia: 'window' },
    'targeted background keys planning',
  )
  const defaultFocus = format.parseKeysArgs({ keys: ['cmd', 'l'], application_id: 'com.x' })
  assertEqual(defaultFocus.focus, true, 'focus defaults to true with an application target')
  assertEqual(
    format.planKeysDelivery(defaultFocus),
    { targeted: true, effectivePolicy: 'foreground-preferred', focus: true, focusTarget: 'application', deliveryVia: 'foreground' },
    'targeted foreground keys planning',
  )
  const windowFocus = format.parseKeysArgs({ keys: ['cmd', 'l'], window_id: 'w1' })
  assertEqual(format.planKeysDelivery(windowFocus).focusTarget, 'window', 'window focus target')

  await assertRejects(() => format.parseKeysArgs({ keys: ['a'], policy: 'background-only' }), /requires a window_id or application_id target/, 'background policy without a target')
  await assertRejects(() => format.parseKeysArgs({ keys: ['a'], focus: true }), /requires a window_id or application_id target/, 'focus without a target')
  await assertRejects(() => format.parseKeysArgs({ keys: ['a'], focus: 'yes' }), /must be a boolean/, 'focus must be a boolean')
  await assertRejects(() => format.parseKeysArgs({ keys: ['a'], window_id: 'w', application_id: 'a' }), /only one of/, 'keys target exclusivity')
}

async function checkRepeatGuard() {
  const format = await importSrc('transport/sdk-format.mjs')
  const { createTools } = await importSrc('tools.mjs')
  const t0 = 1_700_000_000_000

  // Canonical identities: key order and allow_repeat do not matter.
  assertEqual(format.repeatGuardKey('t', { b: 1, a: 2 }), format.repeatGuardKey('t', { a: 2, b: 1 }), 'repeat guard key ignores argument order')
  assertEqual(format.repeatGuardKey('t', { a: 1 }), format.repeatGuardKey('t', { a: 1, allow_repeat: true }), 'repeat guard key ignores allow_repeat')
  assertEqual(format.repeatGuardKey('t', { a: 1 }), format.repeatGuardKey('t', { a: 1, allowRepeat: true }), 'repeat guard key ignores the parsed allowRepeat field')
  assertEqual(format.repeatGuardKey('t', { a: [1, 2] }), 't:{"a":[1,2]}', 'repeat guard canonical JSON shape')

  // Third identical call inside the window is blocked; the fourth stays blocked.
  const guard = format.createRepeatGuard()
  assertEqual(guard.check('auv_click', { x: 1, y: 2 }, t0).blocked, false, 'repeat guard first call')
  assertEqual(guard.check('auv_click', { x: 1, y: 2 }, t0 + 100).blocked, false, 'repeat guard second call')
  const third = guard.check('auv_click', { x: 1, y: 2 }, t0 + 200)
  assertEqual(third.blocked, true, 'repeat guard third call is blocked')
  assertEqual(third.repeatCount, 3, 'repeat guard blocked count')
  assert(third.message.includes('allow_repeat'), 'repeat guard message explains the override')
  assertEqual(guard.check('auv_click', { x: 1, y: 2 }, t0 + 300).blocked, true, 'repeat guard stays blocked')
  guard.bypass()
  assertEqual(guard.check('auv_click', { x: 1, y: 2 }, t0 + 400).blocked, false, 'repeat guard bypass clears the state')

  // A different call resets the counter.
  const other = format.createRepeatGuard()
  other.check('auv_click', { x: 1, y: 2 }, t0)
  other.check('auv_click', { x: 1, y: 2 }, t0 + 100)
  assertEqual(other.check('auv_type', { text: 'a' }, t0 + 200).blocked, false, 'a different call is not blocked')
  assertEqual(other.check('auv_click', { x: 1, y: 2 }, t0 + 300).blocked, false, 'a different call resets the count')

  // The window expires.
  const expired = format.createRepeatGuard()
  expired.check('auv_scroll', { dy: 5 }, t0)
  expired.check('auv_scroll', { dy: 5 }, t0 + 1_000)
  assertEqual(expired.check('auv_scroll', { dy: 5 }, t0 + 31_001).blocked, false, 'the repeat window expires after 30 s')

  assertEqual(format.REPEAT_GUARD_WINDOW_MS, 30_000, 'repeat guard window is 30 s')
  assertEqual(format.REPEAT_GUARD_LIMIT, 3, 'repeat guard limit is 3')
  assert(format.REPEAT_GUARD_MESSAGE.includes('allow_repeat:true'), 'repeat guard message documents the override')

  // The tools render a blocked value without touching the transport.
  const clickTool = createTools().find((tool) => tool.name === 'auv_click')
  assert(clickTool !== undefined, 'auv_click must exist')
  const rendered = clickTool.output.render({}, { status: 'no_effect_repeat', message: 'blocked for the check' })
  assert(Array.isArray(rendered) && rendered[0].text.includes('blocked for the check'), 'a blocked click renders the repeat message')
  const dragTool = createTools().find((tool) => tool.name === 'auv_drag')
  assert(dragTool !== undefined, 'auv_drag must exist')
  assert(dragTool.description.includes('allow_repeat'), 'auv_drag documents the repeat override')
}

async function checkDragKeysWaitWithFakeRunner() {
  const format = await importSrc('transport/sdk-format.mjs')
  const sdk = await importSrc('transport/sdk.mjs')
  const exec = { signal: new AbortController().signal }
  const calls = []
  const windowFrame = { x: 100, y: 200, width: 400, height: 300 }
  const displayFrame = { x: 50, y: 60, width: 1920, height: 1080 }
  const window = { ref: { windowId: 'w1' }, title: 'Fake', applicationId: 'com.fake', frame: windowFrame, isMain: true, isVisible: true, state: {} }
  const display = { displayId: 'd1', name: 'Fake Display', frame: displayFrame, scaleFactor: 2, primary: true, builtin: true }

  // Fake captures: `captureQueue` supplies CapturedFrames, `imageQueue` supplies
  // downscaled RGBA images consumed by auv_capture_state / auv_wait_for_change.
  let captureQueue = []
  let imageQueue = []
  const makeRgbaFrame = (mutate) => {
    const width = 8
    const height = 8
    const data = new Uint8Array(width * height * 4)
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 10
      data[index + 1] = 20
      data[index + 2] = 30
      data[index + 3] = 255
    }
    if (typeof mutate === 'function') mutate(data)
    return { width, height, data }
  }
  const unchangedImage = makeRgbaFrame()
  const changedImage = makeRgbaFrame((data) => {
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 255
      data[index + 1] = 255
      data[index + 2] = 255
    }
  })
  const tinyChangeImage = makeRgbaFrame((data) => {
    data[0] = 35 // 1 of 64 pixels differs by more than the default threshold
  })
  const fallbackCapture = { bounds: windowFrame, scaleFactor: 1, thumbhash: new Uint8Array([0xaa]) }
  const windowClient = {
    id: 'w1',
    window,
    setFocus: async () => {
      calls.push(['window.setFocus'])
      return { path: 'normal' }
    },
    refresh: async () => {
      calls.push(['window.refresh'])
      return window
    },
    pressKeys: async (keys, options) => {
      calls.push(['window.pressKeys', keys, options])
      return { verified: true }
    },
    click: async () => {
      calls.push(['window.click'])
      return { screenPoint: { x: 110, y: 220 }, windowPoint: { x: 10, y: 20 }, action: { verified: true } }
    },
    capture: async () => {
      const capture = captureQueue.length > 0 ? captureQueue.shift() : fallbackCapture
      calls.push(['window.capture'])
      return { window, capture }
    },
  }
  const runner = {
    windows: {
      get: async (id) => {
        calls.push(['windows.get', id])
        return windowClient
      },
      resolve: async () => windowClient,
    },
    applications: {
      activate: async (request) => {
        calls.push(['applications.activate', request])
        return { requestedApplicationId: request.applicationId, verification: { verification: { case: 'unavailable', value: { reason: 'fake' } } } }
      },
    },
    displays: {
      list: async () => [display],
      capture: async () => ({ display, capture: fallbackCapture }),
      captureRegion: async () => ({ display, capture: fallbackCapture }),
    },
    input: {
      dragMouse: async (request) => {
        calls.push(['input.dragMouse', request])
        return { point: { x: 210, y: 270 }, action: { verified: true } }
      },
      pressKeys: async (request) => {
        calls.push(['input.pressKeys', request])
        return { actions: [] }
      },
      click: async (target, options) => {
        calls.push(['input.click', target, options])
        const space = target?.coordinateSpace?.case
        const screenPoint = space === 'screen' ? { x: target.x, y: target.y } : { x: target.x + displayFrame.x, y: target.y + displayFrame.y }
        return { screenPoint, action: { verified: true } }
      },
    },
    captures: {
      image: async () => {
        calls.push(['captures.image'])
        const image = imageQueue.length > 0 ? imageQueue.shift() : unchangedImage
        return { data: image.data, width: image.width, height: image.height, encoding: 4 }
      },
    },
  }

  const deps = {
    connect: async (options) => {
      calls.push(['connect', options])
      return { close: async () => calls.push(['close']) }
    },
    createAuv: () => ({
      health: { check: async () => ({ id: 'fake-daemon', status: 'serving' }) },
      runner: () => runner,
    }),
    startAuv: async () => {
      throw new Error('startAuv must not be called when the fake daemon is attached')
    },
    discoverEndpoint: async () => ({ endpoint: 'unix:///fake.sock', local: true, transport: 'unix' }),
    resolveBinary: () => '/fake/auv',
  }

  const state = sdk.createSdkTransportState()
  try {
    sdk.resetCaptureStateStore()
    const facade = await sdk.initializeSdkTransport(state, deps)
    assertEqual(facade.mode, 'attached', 'the fake transport attaches')

    // Window-space drag: points are converted with the window frame and focus
    // happens before the drag (activation matters for real macOS drags).
    calls.length = 0
    const windowDrag = format.parseDragArgs({ from: { x: 10, y: 20 }, to: { x: 110, y: 70 }, window_id: 'w1' })
    const dragValue = await facade.drag(windowDrag, exec, 120_000)
    const dragCall = calls.find((entry) => entry[0] === 'input.dragMouse')
    assert(dragCall !== undefined, 'the fake runner received a dragMouse call')
    assertEqual(dragCall[1].movement.start.source.value, { x: 110, y: 220 }, 'window drag start converted to screen')
    assertEqual(dragCall[1].movement.curve.segments[0].end, { x: 100, y: 50 }, 'window drag displacement')
    assertEqual(dragCall[1].movement.options, { duration: 300, sampleRateHz: 60, curveTolerance: 0.5 }, 'window drag motion options')
    assertEqual(dragCall[1].button, 1, 'left button maps to MouseButton.LEFT')
    assert(calls.findIndex((entry) => entry[0] === 'window.setFocus') < calls.findIndex((entry) => entry[0] === 'input.dragMouse'), 'the window is focused before the drag')
    assertEqual(dragValue.command_id, 'input.dragMouse', 'drag command id')
    assertEqual(dragValue.screen_start, { x: 110, y: 220 }, 'drag result screen_start')
    assertEqual(dragValue.screen_end, { x: 210, y: 270 }, 'drag result screen_end')
    assertEqual(dragValue.window_point, { x: 10, y: 20 }, 'drag result window_point')
    assertEqual(dragValue.window_end, { x: 110, y: 70 }, 'drag result window_end')

    // Display-space drag: converted with the display frame, no activation.
    calls.length = 0
    const displayDrag = format.parseDragArgs({ from: { x: 8, y: 9 }, to: { x: 108, y: 59 }, display_id: 'd1' })
    const displayValue = await facade.drag(displayDrag, exec, 120_000)
    const displayDragCall = calls.find((entry) => entry[0] === 'input.dragMouse')
    assertEqual(displayDragCall[1].movement.start.source.value, { x: 58, y: 69 }, 'display drag start converted to screen')
    assertEqual(displayDragCall[1].movement.curve.segments[0].end, { x: 100, y: 50 }, 'display drag displacement')
    assertEqual(displayValue.display_start, { x: 8, y: 9 }, 'drag result display_start')
    assertEqual(displayValue.window_point, null, 'display drags have no window point')

    // auv_keys with a window target: focus first, then deliver with the policy.
    calls.length = 0
    const targetedKeys = format.parseKeysArgs({ keys: ['cmd', 'l'], window_id: 'w1', policy: 'background-preferred' })
    const keysValue = await facade.keys(targetedKeys, exec, 120_000)
    const pressCall = calls.find((entry) => entry[0] === 'window.pressKeys')
    assert(pressCall !== undefined, 'the fake runner received the targeted pressKeys call')
    assertEqual(pressCall[1], ['cmd', 'l'], 'keys pass through')
    assertEqual(pressCall[2].policy, 2, 'background-preferred maps to InputPolicy 2')
    assert(calls.findIndex((entry) => entry[0] === 'window.setFocus') < calls.findIndex((entry) => entry[0] === 'window.pressKeys'), 'keys focus before delivery')
    assertEqual(keysValue.policy, 'background-preferred', 'keys result policy')
    assertEqual(keysValue.focus, true, 'keys result focus flag')

    // auv_keys without a target: foreground press with foreground-preferred.
    calls.length = 0
    const foregroundKeys = format.parseKeysArgs({ keys: ['return'] })
    const foregroundValue = await facade.keys(foregroundKeys, exec, 120_000)
    const foregroundPress = calls.find((entry) => entry[0] === 'input.pressKeys')
    assert(foregroundPress !== undefined, 'the fake runner received the foreground pressKeys call')
    assertEqual(foregroundPress[1].target, { recipient: { case: 'foreground', value: true } }, 'foreground key recipient')
    assertEqual(foregroundPress[1].policy, 3, 'foreground-preferred policy for foreground keys')
    assertEqual(foregroundValue.focus, false, 'foreground keys do not focus a target')
    assert(/delivery only/.test(foregroundValue.warnings.join(' ')), 'keys warns that delivery is not proof of an effect')

    // auv_wait_for_change (captured baseline): pixel comparison detects a
    // changed frame and ignores an unchanged one.
    calls.length = 0
    captureQueue = [fallbackCapture, fallbackCapture]
    imageQueue = [unchangedImage, changedImage]
    const changedPlan = format.parseWaitForChangeArgs({ window_id: 'w1', timeout_ms: 500, interval_ms: 50 })
    const changedValue = await facade.waitForChange(changedPlan, exec, 120_000)
    assertEqual(changedValue.result, 'changed', 'wait_for_change sees the changed fake pixels')
    assertEqual(changedValue.changed, true, 'wait_for_change changed flag')
    assertEqual(changedValue.mode, 'window', 'wait_for_change window mode')
    assertEqual(changedValue.baseline_source, 'captured', 'wait_for_change captured baseline source')
    assertEqual(changedValue.comparison, 'pixels', 'wait_for_change compares pixels')
    assertEqual(changedValue.changed_ratio, 1, 'wait_for_change full-frame ratio')
    assertEqual(changedValue.min_changed_ratio, 0.01, 'wait_for_change default min ratio')
    assertEqual(changedValue.pixel_threshold, 24, 'wait_for_change default pixel threshold')
    assertEqual(changedValue.artifact_path, null, 'wait_for_change writes no artifact')

    // Timeout case: identical pixels never reach min_changed_ratio.
    calls.length = 0
    captureQueue = []
    imageQueue = []
    const timeoutPlan = format.parseWaitForChangeArgs({ window_id: 'w1', timeout_ms: 100, interval_ms: 50 })
    const timeoutValue = await facade.waitForChange(timeoutPlan, exec, 120_000)
    assertEqual(timeoutValue.result, 'timeout', 'wait_for_change times out on unchanged pixels')
    assertEqual(timeoutValue.changed, false, 'wait_for_change timeout changed flag')
    assertEqual(timeoutValue.changed_ratio, 0, 'wait_for_change timeout ratio')
    assert(timeoutValue.elapsed_ms >= 100, 'wait_for_change reports elapsed time')
    assert(timeoutValue.artifact_path === null, 'the timeout path writes no artifact')

    // auv_capture_state stores an in-memory snapshot; wait can use its token.
    calls.length = 0
    imageQueue = [unchangedImage]
    const captureValue = await facade.captureState(format.parseCaptureStateArgs({ window_id: 'w1' }), exec, 120_000)
    assert(typeof captureValue.state_token === 'string' && captureValue.state_token.length > 10, 'capture_state returns a token')
    assertEqual(captureValue.command_id, 'frame.captureState', 'capture_state command id')
    assertEqual(captureValue.hash, 'thumbhash:aa', 'capture_state stores the ThumbHash')
    assertEqual(captureValue.width, 8, 'capture_state width')
    assertEqual(captureValue.height, 8, 'capture_state height')
    assertEqual(captureValue.mode, 'window', 'capture_state mode')
    assert(/^\d{4}-\d{2}-\d{2}T/.test(captureValue.captured_at), 'capture_state returns an ISO timestamp')
    assertEqual(sdk.requireCaptureState(captureValue.state_token).width, 8, 'requireCaptureState resolves the stored pixels')

    // state_token path: changed when the ratio exceeds min_changed_ratio.
    imageQueue = [changedImage]
    const tokenPlan = format.parseWaitForChangeArgs({ state_token: captureValue.state_token, timeout_ms: 500, interval_ms: 50 })
    const tokenValue = await facade.waitForChange(tokenPlan, exec, 120_000)
    assertEqual(tokenValue.result, 'changed', 'wait_for_change state_token path detects a change')
    assertEqual(tokenValue.baseline_source, 'state_token', 'wait_for_change state_token baseline source')
    assertEqual(tokenValue.changed_ratio, 1, 'wait_for_change state_token ratio')

    // state_token path: a tiny change stays below a raised min_changed_ratio.
    imageQueue = [unchangedImage]
    const flickerState = await facade.captureState(format.parseCaptureStateArgs({ window_id: 'w1' }), exec, 120_000)
    imageQueue = [tinyChangeImage, tinyChangeImage, tinyChangeImage]
    const flickerPlan = format.parseWaitForChangeArgs({
      state_token: flickerState.state_token,
      min_changed_ratio: 0.5,
      timeout_ms: 100,
      interval_ms: 50,
    })
    const flickerValue = await facade.waitForChange(flickerPlan, exec, 120_000)
    assertEqual(flickerValue.result, 'timeout', 'a small flicker stays below min_changed_ratio')
    assertEqual(flickerValue.changed, false, 'flicker is not a change')
    assert(Math.abs(flickerValue.changed_ratio - 1 / 64) < 1e-9, 'flicker ratio is 1 of 64 pixels')

    // Unknown/expired token fails with a clear error before any capture.
    sdk.resetCaptureStateStore()
    await assertRejects(
      () => facade.waitForChange(format.parseWaitForChangeArgs({ state_token: captureValue.state_token, timeout_ms: 100, interval_ms: 50 }), exec, 120_000),
      /state_token/,
      'an expired state_token is rejected',
    )

    // auv_click space: "screen" uses the global screen click even with a window
    // target (Unity/Canvas-safe), and reports the converted window point.
    calls.length = 0
    const screenClick = await facade.click(format.parseClickArgs({ x: 10, y: 20, window_id: 'w1', space: 'screen' }), exec, 120_000)
    const screenClickCall = calls.find((entry) => entry[0] === 'input.click')
    assert(screenClickCall !== undefined, 'screen-space click uses runner.input.click')
    assertEqual(screenClickCall[1].coordinateSpace, { case: 'screen', value: true }, 'screen-space click uses a screen Position')
    assertEqual({ x: screenClickCall[1].x, y: screenClickCall[1].y }, { x: 10, y: 20 }, 'screen-space click coordinates')
    assert(calls.find((entry) => entry[0] === 'window.click') === undefined, 'screen-space click is not window-targeted')
    assertEqual(screenClick.space, 'screen', 'click result space')
    assertEqual(screenClick.screen_point, { x: 10, y: 20 }, 'click result screen_point')
    assertEqual(screenClick.window_point, { x: -90, y: -180 }, 'screen click reports the window point when a window target is given')

    // auv_click space: "display" delivers a display-relative click.
    calls.length = 0
    const displayClick = await facade.click(format.parseClickArgs({ x: 10, y: 20, display_id: 'd1', space: 'display' }), exec, 120_000)
    const displayClickCall = calls.find((entry) => entry[0] === 'input.click')
    assertEqual(displayClickCall[1].coordinateSpace, { case: 'displayId', value: 'd1' }, 'display-space click uses a display Position')
    assertEqual(displayClick.space, 'display', 'display click result space')
    assertEqual(displayClick.display_point, { x: 10, y: 20 }, 'display click result display_point')
    assertEqual(displayClick.screen_point, { x: 60, y: 80 }, 'display click result screen_point')
  } finally {
    sdk.resetCaptureStateStore()
    await sdk.disposeTransportState(state)
  }
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

async function checkCapturePrune() {
  const { mkdtemp, writeFile, utimes, readdir, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const sdk = await importSrc('transport/sdk.mjs')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-auv-prune-'))
  try {
    const now = Date.now()
    const write = async (name, ageMs) => {
      const filePath = path.join(directory, name)
      await writeFile(filePath, 'x')
      const time = new Date(now - ageMs)
      await utimes(filePath, time, time)
    }
    await write('old.webp', 2 * 60 * 60 * 1000)
    await write('mid.webp', 10 * 60 * 1000)
    await write('new.webp', 1 * 1000)
    await write('notes.txt', 3 * 60 * 60 * 1000)
    const first = await sdk.pruneCaptures({ directory, retentionMs: 60 * 60 * 1000, maxFiles: 10, now })
    assertEqual(first.deleted, 1, 'prune deletes only expired .webp files')
    assertEqual((await readdir(directory)).includes('old.webp'), false, 'expired capture removed')
    assertEqual((await readdir(directory)).includes('notes.txt'), true, 'prune leaves non-webp files alone')

    await write('a.webp', 7 * 1000)
    await write('b.webp', 6 * 1000)
    await write('c.webp', 5 * 1000)
    await sdk.pruneCaptures({ directory, retentionMs: 60 * 60 * 1000, maxFiles: 2, now })
    const remaining = (await readdir(directory)).filter((entry) => entry.endsWith('.webp')).sort()
    assertEqual(remaining, ['c.webp', 'new.webp'], 'prune keeps the newest maxFiles captures')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
    await assertRejects(() => byName.get('auv_drag').execute({}, exec), /Missing required parameter "from"/, 'auv_drag must require from')
    await assertRejects(
      () => byName.get('auv_drag').execute({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, space: 'window' }, exec),
      /requires window_id or application_id/,
      'auv_drag must reject window space without a window target',
    )
    await assertRejects(() => byName.get('auv_wait_for_change').execute({ timeout_ms: 50 }, exec), /between 100 and 120000/, 'auv_wait_for_change timeout bounds')
    await assertRejects(
      () => byName.get('auv_wait_for_change').execute({ window_id: 'w1', region: { x: 0, y: 0, width: 10, height: 10 } }, exec),
      /region is only supported/,
      'auv_wait_for_change must reject a region with a window target',
    )
    await assertRejects(
      () => byName.get('auv_wait_for_change').execute({ min_changed_ratio: 2 }, exec),
      /between 0 and 1/,
      'auv_wait_for_change must reject an out-of-range min_changed_ratio',
    )
    await assertRejects(
      () => byName.get('auv_wait_for_change').execute({ pixel_threshold: 999 }, exec),
      /between 0 and 255/,
      'auv_wait_for_change must reject an out-of-range pixel_threshold',
    )
    // An unknown state_token fails before any transport work.
    await assertRejects(
      () => byName.get('auv_wait_for_change').execute({ state_token: 'missing-token', timeout_ms: 100, interval_ms: 50 }, exec),
      /state_token/,
      'auv_wait_for_change must reject an unknown state_token',
    )
    await assertRejects(
      () => byName.get('auv_capture_state').execute({ window_id: 'w1', display_id: 'd1' }, exec),
      /not both/,
      'auv_capture_state must reject competing targets',
    )
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
  assertEqual(registered.length, 12, 'bundled apply() should register 12 tools')
  assert(new Set(registered.map((definition) => definition.name)).size === 12, 'bundled apply() registered duplicate tool names')
  assertEqual(
    registered.map((definition) => definition.name).sort(),
    Object.keys(EXPECTED).sort(),
    'bundled tool names must match the 12-tool surface',
  )
  assertEqual(disposers.length, 1, 'bundled apply() must register the SDK transport dispose effect')
  assert(typeof disposers[0] === 'function', 'bundled dispose effect must return a disposer')
  await disposers[0]()
}

async function main() {
  console.log('AUV plugin offline self-check')
  console.log(`plugin: ${PLUGIN}`)

  await check('missing AUV guidance', checkMissingAuvGuidance)
  await check('tool definitions (12, SDK-only)', checkToolDefinitions)
  await check('plugin entry point', checkEntryPoint)
  await check('manifest, resources, retired files', checkManifestAndResources)
  await check('SDK argument mapping', checkSdkArgumentMapping)
  await check('drag curve and coordinate mapping', checkDragAndCoordinateMapping)
  await check('drag request through the real SDK with a mock transport', checkDragRequestThroughSdkMock)
  await check('wait-for-change comparison logic', checkWaitForChangeLogic)
  await check('pixel diff and capture-state store', checkPixelDiffAndStateStore)
  await check('keys policy/focus planning', checkKeysPlanning)
  await check('repeat guard', checkRepeatGuard)
  await check('drag/keys/wait/capture/click-space with a fake runner (no input)', checkDragKeysWaitWithFakeRunner)
  await check('attach-first decision and ownership', checkAttachFirstDecision)
  await check('SDK doctor report helpers', checkDoctorHelpers)
  await check('capture cleanup retention and file cap', checkCapturePrune)
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
