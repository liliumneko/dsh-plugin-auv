#!/usr/bin/env node
/**
 * Offline self-check for src/catalog.json + catalog.mjs.
 * No auv spawn, no network: imports the runtime module and asserts the argv
 * contract the plugin relies on.
 *
 * Run: node notes/catalog-selfcheck.mjs        (exit 0 = PASS)
 */

import assert from 'node:assert/strict'
import {
  CATALOG,
  loadCatalog,
  getCommand,
  formatTarget,
  buildInvokeArgs,
  summaryText,
  commandHelpText,
} from '../src/catalog.mjs'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

function throws(fn, matcher) {
  assert.throws(fn, (error) => {
    const message = String(error?.message ?? error)
    return matcher.test(message)
  })
}

// ---------------------------------------------------------------------------
// catalog shape
// ---------------------------------------------------------------------------

check('catalog loads with auv_version and 43 commands', () => {
  assert.equal(typeof CATALOG.auv_version, 'string')
  assert.match(CATALOG.auv_version, /^\d+\.\d+\.\d+/)
  assert.equal(CATALOG.commands.length, 43)
  assert.equal(loadCatalog(), CATALOG)
})

check('command ids are unique and namespaced', () => {
  const ids = new Set()
  for (const command of CATALOG.commands) {
    assert.equal(typeof command.id, 'string')
    assert.ok(command.id.includes('.'), `${command.id} has namespace`)
    assert.equal(ids.has(command.id), false, `duplicate ${command.id}`)
    ids.add(command.id)
    assert.equal(command.namespace, command.id.split('.')[0])
    assert.equal(typeof command.description, 'string')
    assert.ok(command.description.length > 0)
  }
  assert.equal(ids.size, 43)
})

check('argument kinds, flags and keys are valid everywhere', () => {
  for (const command of CATALOG.commands) {
    const keys = new Set()
    for (const argument of command.arguments) {
      const where = `${command.id}/${argument.input_key}`
      assert.ok(argument.input_key, `${command.id}: missing input_key`)
      assert.equal(keys.has(argument.input_key), false, `${where}: duplicate input_key`)
      keys.add(argument.input_key)
      assert.ok(['positional', 'value', 'flag'].includes(argument.kind), `${where}: bad kind`)
      assert.equal(typeof argument.required, 'boolean', `${where}: required`)
      assert.equal(typeof argument.repeated, 'boolean', `${where}: repeated`)
      if (argument.kind === 'positional') {
        assert.equal(argument.flag, null, `${where}: positional needs null flag`)
        assert.ok(argument.value_name, `${where}: positional needs value_name`)
      } else {
        assert.match(argument.flag, /^--[a-z0-9-]+$/, `${where}: bad flag`)
        if (argument.kind === 'flag') assert.equal(argument.value_name, null, `${where}: presence flag has no value_name`)
        else assert.ok(argument.value_name, `${where}: value option needs value_name`)
      }
    }
    assert.ok(['forbidden', 'required', 'optional'].includes(command.target.policy), `${command.id}: target policy`)
    assert.ok(Array.isArray(command.target.accepted_types))
    if (command.target.policy === 'forbidden') assert.deepEqual(command.target.accepted_types, [])
    assert.ok(command.support && typeof command.support.macos === 'string')
  }
})

check('window-scoped target capabilities match the CLI', () => {
  const accepted = (id) => getCommand(id).target.accepted_types
  assert.deepEqual(accepted('window.capture'), ['application'])
  assert.deepEqual(accepted('window.findText'), ['application'])
  assert.deepEqual(accepted('window.waitForText'), ['application'])
  assert.deepEqual(accepted('window.clickText'), ['application'])
  assert.deepEqual(accepted('window.get').sort(), ['application', 'window'])
  assert.deepEqual(accepted('window.focus').sort(), ['application', 'window'])
  assert.deepEqual(accepted('window.scroll').sort(), ['application', 'window'])
  for (const id of ['display.capture', 'display.captureRegion', 'display.findText', 'display.waitForText', 'display.clickText']) {
    assert.equal(getCommand(id).target.policy, 'forbidden', id)
    assert.deepEqual(getCommand(id).target.accepted_types, [], id)
  }
  assert.equal(getCommand('application.activate').target.policy, 'required')
  assert.equal(getCommand('window.scroll').target.policy, 'required')
  assert.equal(getCommand('input.clickPoint').target.policy, 'optional')
})

check('MCP value/flag corrections are encoded as presence flags', () => {
  for (const [id, inputKey, flag] of [
    ['window.list', 'exclude-minimized', '--exclude-minimized'],
    ['window.list', 'exclude-other-desktops', '--exclude-other-desktops'],
    ['window.scroll', 'normalized', '--normalized'],
    ['input.clickPoint', 'normalized', '--normalized'],
  ]) {
    const argument = getCommand(id).arguments.find((entry) => entry.input_key === inputKey)
    assert.ok(argument, `${id}/${inputKey} exists`)
    assert.equal(argument.kind, 'flag')
    assert.equal(argument.flag, flag)
    assert.equal(argument.value_name, null)
  }
})

check('repeated positionals: pressKeys/holdKeys keys', () => {
  for (const id of ['input.pressKeys', 'input.holdKeys']) {
    const keys = getCommand(id).arguments.find((entry) => entry.input_key === 'keys')
    assert.equal(keys.kind, 'positional')
    assert.equal(keys.repeated, true)
    assert.equal(keys.value_name, 'KEY')
  }
})

check('getCommand returns null for unknown ids', () => {
  assert.equal(getCommand('nope.nope'), null)
  assert.equal(getCommand(), null)
})

// ---------------------------------------------------------------------------
// formatTarget
// ---------------------------------------------------------------------------

check('formatTarget formats and validates targets', () => {
  assert.equal(formatTarget(null), null)
  assert.equal(formatTarget(undefined), null)
  assert.equal(formatTarget({ application_id: 'com.apple.Safari' }), 'app:com.apple.Safari')
  assert.equal(formatTarget({ window_id: '3159' }), 'window:3159')
  assert.equal(formatTarget({ display_id: 1 }), 'display:1')
  assert.equal(formatTarget({ window_id: 'window:3159' }), 'window:3159')
  assert.equal(formatTarget('com.apple.TextEdit'), 'app:com.apple.TextEdit')
  assert.equal(formatTarget('window:123'), 'window:123')
  throws(() => formatTarget({}), /exactly one/)
  throws(() => formatTarget({ window_id: '1', application_id: 'a' }), /exactly one/)
  throws(() => formatTarget(''), /non-empty/)
})

// ---------------------------------------------------------------------------
// buildInvokeArgs
// ---------------------------------------------------------------------------

const invoke = (id, inputs, options) => buildInvokeArgs(getCommand(id), inputs, options)

check('display.findText: positional query, forbidden target', () => {
  const result = invoke('display.findText', { query: 'Settings' })
  assert.deepEqual(result.args, ['Settings'])
  assert.deepEqual(result.warnings, [])
  assert.equal('target' in result, false)

  const withTarget = invoke('display.findText', { query: 'Settings' }, { target: { application_id: 'com.apple.Safari' } })
  assert.deepEqual(withTarget.args, ['Settings'])
  assert.equal('target' in withTarget, false)
  assert.match(withTarget.warnings.join(' '), /does not accept a target/)

  throws(() => invoke('display.findText', {}), /missing required input\(s\).*query/)
  throws(() => invoke('display.findText', { query: 'x', bogus: 1 }), /unknown input key/)
  throws(() => invoke('display.findText', { query: ['a'] }), /single positional/)
})

check('display.captureRegion: --x/--y/--width/--height values', () => {
  const result = invoke('display.captureRegion', { x: 0, y: 0, width: 800, height: 600 })
  assert.deepEqual(result.args, ['--x', '0', '--y', '0', '--width', '800', '--height', '600'])
  throws(() => invoke('display.captureRegion', { x: 0, y: 0, width: 800 }), /missing required.*height/)
  assert.deepEqual(invoke('display.captureRegion', { x: 0, y: 0, width: 800, height: 600, label: 'region' }).args, [
    '--x', '0', '--y', '0', '--width', '800', '--height', '600', '--label', 'region',
  ])
})

check('window.list: exclude flags are presence-only', () => {
  assert.deepEqual(invoke('window.list', {}).args, [])
  assert.deepEqual(invoke('window.list', { 'exclude-minimized': true }).args, ['--exclude-minimized'])
  assert.deepEqual(invoke('window.list', { 'exclude-minimized': 'false', 'exclude-other-desktops': 'false' }).args, [])
  assert.deepEqual(invoke('window.list', { 'exclude-minimized': 'true', 'exclude-other-desktops': true }).args, [
    '--exclude-minimized', '--exclude-other-desktops',
  ])
})

check('input.clickPoint: positional x y, --button value, target', () => {
  const result = invoke('input.clickPoint', { x: 1032.5, y: 1212, button: 'left' })
  assert.deepEqual(result.args, ['1032.5', '1212', '--button', 'left'])
  assert.deepEqual(invoke('input.clickPoint', { x: 1, y: 2 }).args, ['1', '2'])
  const targeted = invoke('input.clickPoint', { x: 100, y: 200 }, { target: { window_id: '3159' } })
  assert.equal(targeted.target, 'window:3159')
  throws(() => invoke('input.clickPoint', { x: 1 }), /missing required.*y/)
})

check('window.scroll: positional x y, --dx/--dy, required target', () => {
  const result = invoke(
    'window.scroll',
    { x: 200, y: 300, dy: 300 },
    { target: { application_id: 'com.google.Chrome' } },
  )
  assert.deepEqual(result.args, ['200', '300', '--dy', '300'])
  assert.equal(result.target, 'app:com.google.Chrome')
  const missingTarget = invoke('window.scroll', { x: 200, y: 300, dy: 300 })
  assert.match(missingTarget.warnings.join(' '), /requires a target/)
  throws(() => invoke('window.scroll', { dy: 300 }), /missing required.*x, y/)
})

check('window.scroll: --normalized is a flag; warn on window target mismatch is absent here', () => {
  const result = invoke('window.scroll', { x: 0.5, y: 0.5, dy: -600, normalized: true }, { target: { window_id: '12345' } })
  assert.deepEqual(result.args, ['0.5', '0.5', '--dy', '-600', '--normalized'])
  assert.equal(result.target, 'window:12345')
})

check('input.scrollPoint: four positionals, no target', () => {
  const result = invoke('input.scrollPoint', { x: 640, y: 360, delta_x: 0, delta_y: 120 })
  assert.deepEqual(result.args, ['640', '360', '0', '120'])
  throws(() => invoke('input.scrollPoint', { x: 640, y: 360, delta_x: 0 }), /missing required.*delta_y/)
})

check('input.pressKeys: repeated positionals + --count/--interval-ms', () => {
  assert.deepEqual(invoke('input.pressKeys', { keys: ['cmd', 'shift', 'p'] }).args, ['cmd', 'shift', 'p'])
  assert.deepEqual(invoke('input.pressKeys', { keys: ['return'], count: 2, 'interval-ms': 100 }).args, [
    'return', '--count', '2', '--interval-ms', '100',
  ])
  const parsed = invoke('input.pressKeys', { keys: '["ctrl","l"]' })
  assert.deepEqual(parsed.args, ['ctrl', 'l'])
  assert.match(parsed.warnings.join(' '), /JSON-encoded array/)
})

check('input.typeText: positional text + --input-policy, optional app target', () => {
  const result = invoke(
    'input.typeText',
    { text: 'hello from AUV', 'input-policy': 'background-only' },
    { target: { application_id: 'com.apple.TextEdit' } },
  )
  assert.deepEqual(result.args, ['hello from AUV', '--input-policy', 'background-only'])
  assert.equal(result.target, 'app:com.apple.TextEdit')
})

check('application.activate: target only (no positional app id)', () => {
  assert.deepEqual(getCommand('application.activate').arguments, [])
  const result = invoke('application.activate', {}, { target: { application_id: 'com.apple.TextEdit' } })
  assert.deepEqual(result.args, [])
  assert.equal(result.target, 'app:com.apple.TextEdit')
  const bare = invoke('application.activate', { target: 'com.apple.TextEdit' })
  assert.equal(bare.target, 'app:com.apple.TextEdit')
  assert.deepEqual(bare.args, [])
})

check('window.capture: window target warns (CLI accepts only application targets)', () => {
  const result = invoke('window.capture', {}, { target: { window_id: '3159' } })
  assert.equal(result.target, 'window:3159')
  assert.match(result.warnings.join(' '), /accepts application targets, not window/)
})

check('flag coercion + ill-typed inputs', () => {
  assert.deepEqual(invoke('input.clickPoint', { x: 1, y: 2, normalized: 'false' }).args, ['1', '2'])
  assert.deepEqual(invoke('input.clickPoint', { x: 1, y: 2, normalized: true }).args, ['1', '2', '--normalized'])
  assert.deepEqual(invoke('window.list', { 'exclude-minimized': 0 }).args, [])
  throws(() => invoke('input.clickPoint', { x: 1, y: 2, normalized: ['a'] }), /presence flag/)
  throws(() => invoke('display.findText', { query: NaN }), /finite number/)
  throws(() => invoke('display.findText', { query: { a: 1 } }), /must be a string, number, or boolean/)
})

check('every command builds argv from its full required-input set', () => {
  for (const command of CATALOG.commands) {
    const inputs = {}
    for (const argument of command.arguments) {
      if (!argument.required) continue
      inputs[argument.input_key] =
        argument.kind === 'flag' ? true : argument.repeated ? ['a', 'b'] : argument.kind === 'positional' ? 'value' : '1'
    }
    let result
    try {
      result = buildInvokeArgs(command, inputs)
    } catch (error) {
      throw new Error(`${command.id}: ${error.message}`)
    }
    assert.ok(Array.isArray(result.args), command.id)
    for (const argument of command.arguments.filter((entry) => entry.required && entry.kind === 'flag')) {
      assert.ok(result.args.includes(argument.flag), `${command.id}: ${argument.flag} missing`)
    }
    const positionals = command.arguments.filter((entry) => entry.kind === 'positional')
    const positionalTokens = result.args.slice(0, positionals.length)
    for (const [index, argument] of positionals.entries()) {
      if (!argument.required) continue
      assert.equal(positionalTokens[index], argument.repeated ? 'a' : 'value', `${command.id}: positional ${argument.input_key}`)
    }
  }
})

// ---------------------------------------------------------------------------
// help text
// ---------------------------------------------------------------------------

check('summaryText lists every command id', () => {
  const text = summaryText()
  assert.match(text, /AUV \d+\.\d+\.\d+ invoke commands \(43\):/)
  for (const command of CATALOG.commands) assert.ok(text.includes(`- ${command.id} —`), `missing ${command.id}`)
})

check('commandHelpText renders one command', () => {
  const text = commandHelpText('display.findText')
  assert.match(text, /^# display\.findText/m)
  assert.match(text, /query \(positional <TEXT>, required\)/)
  assert.match(text, /Target: none allowed/)
  assert.match(text, /auv invoke display\.findText "Settings"/)
  assert.match(text, /Example inputs for auv_invoke: \{"command_id":"display\.findText"/)
})

check('commandHelpText exposes macOS limitations', () => {
  const text = commandHelpText('input.scrollPoint')
  assert.match(text, /macOS no/)
  assert.match(text, /window-owned scrolling/)
  throws(() => commandHelpText('not.a.command'), /unknown AUV command id/)
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

console.log('')
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s) failed, ${passed} passed`)
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack ?? failure.error.message}`)
  process.exit(1)
}
console.log(`PASS: all ${passed} catalog self-checks passed`)
