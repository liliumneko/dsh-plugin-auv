#!/usr/bin/env node
/**
 * Offline self-check for the @local/dsh-auv bundle.
 *
 * Imports the plugin entry, the tool definitions, and (when present) the AUV
 * catalog, then asserts that:
 *   - every ToolDefinition is well formed and its JSON Schemas stay inside the
 *     DSH-enforced schema subset;
 *   - the eleven auv_* tools exist with the expected parameters, description
 *     limits, timeouts, and `isConcurrencySafe: () => false`;
 *   - the package manifest, locales, patch, icon, and entry point are sane;
 *   - catalog.buildInvokeArgs maps representative inputs to the expected argv
 *     (catalog-dependent checks are skipped with a SKIP note when
 *     src/catalog.json / src/catalog.mjs have not been generated yet).
 *
 * No AUV process is spawned: this script is safe to run anywhere.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
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

function skip(label, detail) {
  console.log(`SKIP ${label}: ${detail}`)
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
// Expected tool surface (from DESIGN.md)
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
  auv_invoke: { required: ['command_id'], properties: ['command_id', 'inputs', 'target', 'dry_run'] },
  auv_help: { required: [], properties: ['command_id'] },
}

const DESCRIPTION_LIMITS = { auv_invoke: 1_600, default: 1_200 }
const PERMISSION_TOOLS = ['auv_doctor', 'auv_screenshot', 'auv_ocr', 'auv_click', 'auv_type', 'auv_keys', 'auv_scroll']

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkToolDefinitions() {
  const { createTools, TOOL_NAMES } = await import(pathToFileURL(path.join(SRC, 'tools.mjs')).href)
  assert(typeof createTools === 'function', 'src/tools.mjs must export createTools()')
  assert(Array.isArray(TOOL_NAMES), 'src/tools.mjs must export the TOOL_NAMES array')

  const tools = createTools()
  assert(Array.isArray(tools), 'createTools() must return an array')
  assert(tools.length === 11, `expected 11 tools, got ${tools.length}`)

  const names = tools.map((tool) => tool?.name)
  assertEqual([...names].sort(), [...TOOL_NAMES].sort(), 'tool names must match TOOL_NAMES')
  assertEqual([...names].sort(), Object.keys(EXPECTED).sort(), 'tool names must match the DESIGN.md surface')
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
    if (PERMISSION_TOOLS.includes(name)) {
      assert(tool.description.includes('auv_doctor'), `${name} description must point at auv_doctor`)
      assert(/Accessibility|Screen Recording/.test(tool.description), `${name} description must name the macOS permission`)
    }
    if (name === 'auv_invoke') {
      assert(tool.description.includes('auv_help'), 'auv_invoke description must point at auv_help for the id list')
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
  assertEqual(entry.inject, ['tools'], 'index.js must export inject = [\'tools\']')
  assert(typeof entry.apply === 'function', 'index.js must export apply(ctx)')
  const registered = []
  const ctx = { tools: { register(definition) { registered.push(definition) } } }
  entry.apply(ctx)
  assert(registered.length === 11, `apply() should register 11 tools, registered ${registered.length}`)
  assert(new Set(registered.map((definition) => definition.name)).size === 11, 'apply() registered duplicate tool names')
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

  for (const file of ['index.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'src/auv.mjs', 'src/tools.mjs', 'src/catalog-data.mjs', 'dist/index.mjs']) {
    assert(existsSync(path.join(PLUGIN, file)), `missing required file ${file}`)
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

async function checkCatalog() {
  const catalogJson = path.join(SRC, 'catalog.json')
  const catalogModule = path.join(SRC, 'catalog.mjs')
  if (!existsSync(catalogJson) || !existsSync(catalogModule)) {
    skip('catalog checks', 'src/catalog.json / src/catalog.mjs not generated yet (run tools/generate-catalog.mjs)')
    return
  }
  assert(existsSync(catalogJson) && existsSync(catalogModule), 'catalog.json and catalog.mjs must ship together')

  const catalog = await import(pathToFileURL(catalogModule).href)
  for (const name of ['loadCatalog', 'getCommand', 'buildInvokeArgs', 'formatTarget', 'summaryText', 'commandHelpText']) {
    assert(typeof catalog[name] === 'function', `catalog.mjs must export ${name}()`)
  }
  const data = await catalog.loadCatalog()
  assert(Array.isArray(data?.commands), 'catalog.json must contain a commands array')
  assert(data.commands.length === 43, `catalog should contain 43 commands, found ${data.commands.length}`)
  const ids = data.commands.map((command) => command.id)
  assert(new Set(ids).size === ids.length, 'catalog command ids must be unique')
  assert(typeof catalog.CATALOG === 'object' && catalog.CATALOG !== null, 'catalog.mjs must export CATALOG')

  const get = (id) => {
    const command = catalog.getCommand(id)
    assert(command !== undefined && command !== null, `catalog.getCommand("${id}") returned nothing`)
    return command
  }
  const argsOf = (command) => (Array.isArray(command.arguments) ? command.arguments : [])
  const positional = (command, index = 0) => {
    const found = argsOf(command).filter((argument) => argument.kind === 'positional')[index]
    assert(found !== undefined, `${command.id} has no positional argument ${index}`)
    assert(typeof found.input_key === 'string', `${command.id} positional argument ${index} has no input_key`)
    return found
  }
  const flagged = (command, flag) => {
    const found = argsOf(command).find((argument) => argument.flag === flag)
    assert(found !== undefined, `${command.id} has no ${flag} argument`)
    assert(typeof found.input_key === 'string', `${command.id} ${flag} argument has no input_key`)
    return found
  }
  const build = async (id, inputs) => {
    const built = await catalog.buildInvokeArgs(get(id), inputs)
    assert(Array.isArray(built?.args), `buildInvokeArgs(${id}) must return { args: string[] }`)
    return built.args.map((argument) => String(argument))
  }
  const hasPair = (args, flag, value) => args.some((argument, index) => argument === flag && args[index + 1] === String(value))

  // Input-key names the tools resolve dynamically at runtime (must match CLI truth).
  assertEqual(positional(get('display.findText'), 0).input_key, 'query', 'display.findText positional input key')
  assertEqual(positional(get('window.findText'), 0).input_key, 'query', 'window.findText positional input key')
  assertEqual(positional(get('window.waitForText'), 0).input_key, 'query', 'window.waitForText positional input key')
  assertEqual(positional(get('display.clickText'), 0).input_key, 'query', 'display.clickText positional input key')
  assertEqual(positional(get('input.typeText'), 0).input_key, 'text', 'input.typeText positional input key')
  assertEqual(positional(get('input.pressKeys'), 0).input_key, 'keys', 'input.pressKeys positional input key')
  assertEqual(positional(get('input.pressKeys'), 0).repeated, true, 'input.pressKeys keys must be repeated')
  const scrollPoint = get('input.scrollPoint')
  assertEqual(
    [0, 1, 2, 3].map((index) => positional(scrollPoint, index).input_key),
    ['x', 'y', 'delta_x', 'delta_y'],
    'input.scrollPoint positional input keys',
  )
  assertEqual(flagged(get('display.clickText'), '--within').input_key, 'within', 'display.clickText --within input key')
  assertEqual(flagged(get('window.clickText'), '--title').input_key, 'title', 'window.clickText --title input key')
  assertEqual(flagged(get('window.capture'), '--title').input_key, 'title', 'window.capture --title input key')
  assertEqual(flagged(get('input.pressKeys'), '--count').input_key, 'count', 'input.pressKeys --count input key')
  assertEqual(flagged(get('input.pressKeys'), '--interval-ms').input_key, 'interval-ms', 'input.pressKeys --interval-ms input key')
  assertEqual(flagged(get('window.scroll'), '--dx').input_key, 'dx', 'window.scroll --dx input key')
  assertEqual(flagged(get('window.scroll'), '--dy').input_key, 'dy', 'window.scroll --dy input key')
  assertEqual(flagged(get('input.typeText'), '--input-policy').input_key, 'input-policy', 'input.typeText --input-policy input key')

  // Positional mapping: display.findText TEXT.
  const findText = get('display.findText')
  const findTextKey = positional(findText, 0).input_key
  assertEqual(await build('display.findText', { [findTextKey]: 'Settings' }), ['Settings'], 'display.findText positional argv')

  // Required value flags: display.captureRegion --x --y --width --height.
  const region = get('display.captureRegion')
  const regionInputs = {
    [flagged(region, '--x').input_key]: 10,
    [flagged(region, '--y').input_key]: 20,
    [flagged(region, '--width').input_key]: 300,
    [flagged(region, '--height').input_key]: 200,
  }
  const regionArgs = await build('display.captureRegion', regionInputs)
  assert(hasPair(regionArgs, '--x', 10), `display.captureRegion args missing --x 10: ${JSON.stringify(regionArgs)}`)
  assert(hasPair(regionArgs, '--y', 20), `display.captureRegion args missing --y 20: ${JSON.stringify(regionArgs)}`)
  assert(hasPair(regionArgs, '--width', 300), `display.captureRegion args missing --width 300: ${JSON.stringify(regionArgs)}`)
  assert(hasPair(regionArgs, '--height', 200), `display.captureRegion args missing --height 200: ${JSON.stringify(regionArgs)}`)

  // Presence flags: window.list --exclude-minimized / --exclude-other-desktops.
  const list = get('window.list')
  const excludeMinimizedKey = flagged(list, '--exclude-minimized').input_key
  const excludeOtherKey = flagged(list, '--exclude-other-desktops').input_key
  const listArgs = await build('window.list', { [excludeMinimizedKey]: true, [excludeOtherKey]: true })
  assert(listArgs.includes('--exclude-minimized'), 'window.list true flag should add --exclude-minimized')
  assert(listArgs.includes('--exclude-other-desktops'), 'window.list true flag should add --exclude-other-desktops')
  const listArgsOff = await build('window.list', { [excludeMinimizedKey]: false, [excludeOtherKey]: false })
  assert(!listArgsOff.includes('--exclude-minimized'), 'window.list false flag must not add --exclude-minimized')
  assert(!listArgsOff.includes('--exclude-other-desktops'), 'window.list false flag must not add --exclude-other-desktops')

  // Positional numbers: input.clickPoint X Y.
  const clickPoint = get('input.clickPoint')
  assertEqual(
    await build('input.clickPoint', { [positional(clickPoint, 0).input_key]: 10, [positional(clickPoint, 1).input_key]: 20 }),
    ['10', '20'],
    'input.clickPoint positional argv',
  )

  // Repeated arguments: input.pressKeys KEY...
  const pressKeys = get('input.pressKeys')
  const keyArg = positional(pressKeys, 0)
  const keyInputs = keyArg.repeated === true ? { [keyArg.input_key]: ['ctrl', 'l'] } : { [keyArg.input_key]: 'ctrl' }
  const keyArgs = await build('input.pressKeys', keyInputs)
  if (keyArg.repeated === true) assertEqual(keyArgs.slice(0, 2), ['ctrl', 'l'], 'input.pressKeys repeated positional argv')
  else assert(keyArgs.length > 0, 'input.pressKeys positional argv must not be empty')

  // Unknown keys and missing required arguments reject.
  await assertRejects(() => build('display.findText', { [findTextKey]: 'Settings', not_a_real_key: 1 }), /unknown|not.*recogniz|not_a_real_key/i, 'buildInvokeArgs must reject unknown inputs')
  await assertRejects(() => build('display.findText', {}), /missing|required/i, 'buildInvokeArgs must reject missing required inputs')
  await assertRejects(
    () => build('display.captureRegion', { [flagged(region, '--x').input_key]: 10, [flagged(region, '--y').input_key]: 20, [flagged(region, '--width').input_key]: 300 }),
    /missing|required/i,
    'buildInvokeArgs must reject missing required --height',
  )

  // Target formatting.
  assertEqual(await catalog.formatTarget({ application_id: 'com.apple.TextEdit' }), 'app:com.apple.TextEdit', 'formatTarget application')
  assertEqual(await catalog.formatTarget({ window_id: '1234' }), 'window:1234', 'formatTarget window')
  assertEqual(await catalog.formatTarget({ display_id: '1' }), 'display:1', 'formatTarget display')

  // app:<id> must map onto the catalog's "application" accepted type (the plugin's
  // auv_invoke comparison uses targetTypeName for exactly this mapping).
  const fakeAppCommand = { id: 'fake.command', arguments: [], target: { policy: 'optional', accepted_types: ['application'] } }
  const fakeAppBuilt = await catalog.buildInvokeArgs(fakeAppCommand, {}, { target: 'app:com.apple.TextEdit' })
  assertEqual(fakeAppBuilt.target, 'app:com.apple.TextEdit', 'app: target must be returned for an application target')
  assert(
    !fakeAppBuilt.warnings.some((warning) => /accepts|not .*target/i.test(warning)),
    `app: target must be accepted as an application target; warnings: ${JSON.stringify(fakeAppBuilt.warnings)}`,
  )
  const fakeWindowCommand = { id: 'fake.window', arguments: [], target: { policy: 'required', accepted_types: ['application', 'window'] } }
  const fakeWindowBuilt = await catalog.buildInvokeArgs(fakeWindowCommand, {}, { target: 'window:42' })
  assertEqual(fakeWindowBuilt.target, 'window:42', 'window: target must be returned for a window target')

  // Help text.
  const summary = await catalog.summaryText()
  assert(typeof summary === 'string' && summary.length > 100, 'summaryText() must return a non-empty string')
  assert(summary.includes('display.findText'), 'summaryText() must mention display.findText')
  const detail = await catalog.commandHelpText('display.findText')
  assert(typeof detail === 'string' && detail.includes('display.findText'), 'commandHelpText("display.findText") must return its details')
}

async function checkOfflineExecuteGuards() {
  const { createTools, targetTypeName } = await import(pathToFileURL(path.join(SRC, 'tools.mjs')).href)
  const byName = new Map(createTools().map((tool) => [tool.name, tool]))
  const exec = { signal: new AbortController().signal }

  assertEqual(targetTypeName('app:com.apple.TextEdit'), 'application', 'target type name for app: targets')
  assertEqual(targetTypeName('window:1234'), 'window', 'target type name for window: targets')
  assertEqual(targetTypeName('display:1'), 'display', 'target type name for display: targets')

  await assertRejects(() => byName.get('auv_click').execute({}, exec), /requires either "text"/, 'auv_click must reject an empty click')
  await assertRejects(() => byName.get('auv_click').execute({ text: 'OK', x: 1, y: 2 }, exec), /not both forms/, 'auv_click must reject text plus coordinates')
  await assertRejects(() => byName.get('auv_type').execute({}, exec), /Missing required parameter "text"/, 'auv_type must require text')
  await assertRejects(() => byName.get('auv_keys').execute({ keys: [] }, exec), /non-empty array/, 'auv_keys must require a non-empty keys array')
  await assertRejects(() => byName.get('auv_keys').execute({ keys: ['a'], interval_ms: 50 }, exec), /only valid with repeat/, 'auv_keys must reject interval_ms without repeat')
  await assertRejects(() => byName.get('auv_keys').execute({ keys: ['a'], repeat: 2, interval_ms: 0 }, exec), /positive integer/, 'auv_keys must reject a non-positive interval_ms')
  await assertRejects(() => byName.get('auv_scroll').execute({}, exec), /requires "dy"/, 'auv_scroll must require dy')
  await assertRejects(() => byName.get('auv_ocr').execute({ text: 'Hello', timeout_ms: 5000 }, exec), /only valid with wait/, 'auv_ocr must reject timeout_ms without wait')
  await assertRejects(() => byName.get('auv_screenshot').execute({ window_id: '1', display_id: '1' }, exec), /only one of/, 'auv_screenshot must reject competing targets')
  await assertRejects(() => byName.get('auv_invoke').execute({}, exec), /Missing required parameter "command_id"/, 'auv_invoke must require command_id')
  if (process.platform === 'darwin') {
    await assertRejects(
      () => byName.get('auv_scroll').execute({ dy: 10, x: 1, y: 2 }, exec),
      /macOS cannot scroll at a screen point/,
      'auv_scroll must fail fast for screen-point scrolling on macOS',
    )
  }
}

async function checkMissingAuvGuidance() {
  const {
    AUV_INSTALL_GUIDANCE,
    resetAuvBinaryCache,
    resolveAuvBinary,
  } = await import(pathToFileURL(path.join(SRC, 'auv.mjs')).href)

  assert(typeof AUV_INSTALL_GUIDANCE === 'string', 'AUV_INSTALL_GUIDANCE must be exported as a string')
  for (const needle of [
    'brew install moeru-ai/tap/auv',
    'https://auv.moeru.ai/install.sh',
    'github.com/moeru-ai/auv',
    'AUV_BIN',
    'auv_doctor',
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

async function checkCatalogData() {
  const jsonPath = path.join(SRC, 'catalog.json')
  const dataPath = path.join(SRC, 'catalog-data.mjs')
  assert(existsSync(jsonPath), 'src/catalog.json must exist (run node tools/catalog.mjs)')
  assert(existsSync(dataPath), 'src/catalog-data.mjs must exist (run node tools/sync-catalog-data.mjs)')

  const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const data = (await import(pathToFileURL(dataPath).href)).default
  assert(isDeepStrictEqual(json, data), 'src/catalog-data.mjs must mirror src/catalog.json exactly; run node tools/sync-catalog-data.mjs')

  const catalogSource = readFileSync(path.join(SRC, 'catalog.mjs'), 'utf8')
  assert(catalogSource.includes("from './catalog-data.mjs'"), 'catalog.mjs must import the generated data module')
  assert(!/readFileSync\(/.test(catalogSource), 'catalog.mjs must not read catalog.json at runtime (the bundle has no side files)')
}

async function checkBundle() {
  const distPath = path.join(PLUGIN, 'dist', 'index.mjs')
  assert(existsSync(distPath), 'dist/index.mjs is missing; run `pnpm build` (tsdown) and commit dist/')

  const source = readFileSync(distPath, 'utf8')
  const relativeImports = [...source.matchAll(/^import\s+(?:[^'"]+from\s+)?["']([^"']+)["']/gm)].map((match) => match[1])
  const nonNodeImports = relativeImports.filter((specifier) => !specifier.startsWith('node:'))
  assert(nonNodeImports.length === 0, `dist/index.mjs must only import node: builtins, found: ${nonNodeImports.join(', ')}`)
  assert(!source.includes('import("./') && !source.includes("import('./"), 'dist/index.mjs must not dynamically import local modules')

  const bundle = await import(`${pathToFileURL(distPath).href}?check=${Date.now()}`)
  assertEqual(bundle.inject, ['tools'], "bundle must export inject = ['tools']")
  assert(typeof bundle.apply === 'function', 'bundle must export apply(ctx)')
  const registered = []
  bundle.apply({ tools: { register(definition) { registered.push(definition) } } })
  assertEqual(registered.length, 11, 'bundled apply() should register 11 tools')
  assert(new Set(registered.map((definition) => definition.name)).size === 11, 'bundled apply() registered duplicate tool names')

  const help = registered.find((definition) => definition.name === 'auv_help')
  const value = await help.execute({}, { signal: new AbortController().signal })
  assert(value?.mode === 'summary' && value?.count === 43, 'bundled auv_help must read the inlined catalog (43 commands)')
}

async function main() {
  console.log('AUV plugin offline self-check')
  console.log(`plugin: ${PLUGIN}`)

  await check('missing AUV guidance', checkMissingAuvGuidance)
  await check('tool definitions', checkToolDefinitions)
  await check('plugin entry point', checkEntryPoint)
  await check('manifest, patch, locales, icon', checkManifestAndResources)
  await check('catalog data mirror', checkCatalogData)
  await check('bundled dist/index.mjs', checkBundle)
  await check('offline execute guards', checkOfflineExecuteGuards)
  await check('catalog contract', checkCatalog)

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
