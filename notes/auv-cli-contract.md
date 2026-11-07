# AUV CLI contract — verified against auv 0.0.43

Working notes for the `@local/dsh-auv` plugin. Everything here was checked against the installed
`/opt/homebrew/bin/auv` (`auv 0.0.43`) on macOS. CLI help wins over MCP metadata for argv.

- Catalog: `pkg/dsh-auv/src/catalog.json` (43 commands, generated).
- Runtime helpers: `pkg/dsh-auv/src/catalog.mjs`.
- Regenerator: `tools/generate-catalog.mjs`.
- Offline self-check: `node notes/catalog-selfcheck.mjs` (23 checks, no auv needed).

## How to run AUV from the DSH bash sandbox

`auv`'s default state/log dir under `~/Library/Application Support/ai.moeru.auv` is not writable by
the DSH bash tool. Every CLI test here used:

```sh
cd /Users/liliumneko/Projects/dshplugin
AUV_LOG_DIR="$PWD/.auvtest/logs" auv --no-daemon invoke <command-id> ...
```

`--no-daemon` is a **root** option (`auv [ROOT OPTIONS] invoke …`) and must come before `invoke`.
`doctor` needs no daemon: `AUV_LOG_DIR=… auv doctor --json`. Help needs neither daemon nor store:
`auv --no-daemon invoke <id> --help` (exit 0; no receipt). The installed plugin itself runs in the
unsandboxed Host process, so it can use the normal daemon; `--no-daemon` is only for sandbox tests.

`--store-root <PATH>` is a **subcommand** option of `invoke` (must come after `invoke <id>`;
`auv --store-root … invoke …` is a clap error). It moves the receipt's `store_root` and artifact
paths:

```sh
auv --no-daemon invoke display.list --store-root "$PWD/.auvtest/store" --json
```

## Invocation grammar (verified)

```
auv [--device <name>|--device-id <id>] [--no-daemon] invoke <command-id> [ARGUMENTS] [OPTIONS]
```

- Positionals come from the command's clap `Arguments` section, in clap order.
- Options may be interleaved after `invoke <id>` (examples put them after positionals). Repeated
  value options repeat the flag (`--modifiers shift --modifiers cmd`).
- Common subcommand options (never catalogued, always appendable):
  `--json`, `--dry-run`, `--no-overlay`, `--store-root <PATH>`, `--detail`, `--wide`, `-h/--help`.
- `--target <TARGET>` is a subcommand option on commands that accept one (see target contract).
- Always pass `--json` (machine receipt on stdout) and `--no-overlay` (avoid visual overlays).
- Root also supports `--run <id>` (append to an existing Run) and `--device/--device-id` (remote
  Device); the plugin does not need them in v1.

## Receipt shapes (verified)

Success (`--json`): `status: "completed"`, non-null `result`, optional `artifacts[]`:

```json
{
  "run_id": "01a1b798-…",
  "status": "completed",
  "command_id": "display.capture",
  "store_root": "/Users/liliumneko/Projects/dshplugin/.auv/store",
  "result": { "capture": { "backend": "xcap.macos", "bounds": {…}, "pixel_dimensions": {…}, "scale_factor": 2, "fallback_reason": null }, "display": {…} },
  "artifacts": [ { "uri": "auv://runs/…/artifacts/…", "purpose": "…", "content_type": "image/webp", "file_extension": "webp", "byte_length": 12345, "sha256": "…", "attributes": {…}, "file_path": "/abs/path/to.webp" } ]
}
```

Command failure still prints JSON on stdout (exit code 0):

```json
{
  "run_id": "…", "status": "failed", "command_id": "window.capture", "store_root": "…",
  "result": null,
  "failure": "window.capture does not support window: targets; accepted target types: application",
  "failure_details": { "code": "invalid_target", "message": "…" }
}
```

Clap argument errors are **not JSON**: empty stdout, plain text on stderr, exit code 1:

```
error: error: the following required arguments were not provided:
  <TEXT>

Usage: auv invoke display.findText <TEXT>
```
The runner must handle both (parse stdout JSON when possible, else surface stderr tail).

`auv doctor --json` exits 0 even when `all_ok` is false — read `all_ok`, not the exit code.

## MCP handshake used by the generator

`auv mcp serve` speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. Sequence:

1. `initialize` with `protocolVersion: "2025-06-18"`, `clientInfo` → reply (server negotiates
   `2025-03-26`, `serverInfo.version: "0.0.43"`).
2. `notifications/initialized`.
3. `tools/list` → 7 tools: `device_ensure_user_session_unlocked`, `device_ensure_user_session_locked`,
   `device_list_user_sessions`, `device_get_user_session`, `invoke`, `op_run`, `artifact_read_image`.
4. The catalog lives at `tools[name=invoke].inputSchema["x-auv-commands"]` (array of 43 command
   records: `id`, `namespace`, `description`, `arguments[]`, `examples[]`, `target`,
   `target_policy`, `target_help`, `support`, `runner_support`, `role`).

`tools/generate-catalog.mjs` does that handshake, then runs `auv --no-daemon invoke <id> --help` for
all 43 commands and merges: MCP wins for `id/description/required/repeated/examples/support`; **CLI
help wins for `kind` (positional vs value vs flag), flag spelling, positional order/name, and enum
candidate values**. `--check` re-generates and diffs against the file on disk.

## Catalog schema (what `catalog.mjs` consumes)

```json
{
  "auv_version": "0.0.43",
  "generated_at": "…",
  "generated_by": "tools/generate-catalog.mjs",
  "commands": [
    {
      "id": "display.findText",
      "namespace": "display",
      "description": "…",
      "target": {
        "policy": "forbidden|required|optional",   // normalized from MCP target_policy
        "accepted_types": ["application","window","display"],
        "required": false
      },
      "support": { "macos": "supported|partial|unsupported", "linux": "…", "windows": "…" },
      "support_note": { "macos": "…" },              // only when AUV documents a macOS caveat
      "runner_support": { "route": "direct|cells|no_route" },
      "arguments": [
        { "input_key": "query", "flag": null, "kind": "positional", "required": true,
          "repeated": false, "value_name": "TEXT", "help": "…" },
        { "input_key": "timeout-ms", "flag": "--timeout-ms", "kind": "value", "required": false,
          "repeated": false, "value_name": "MS", "help": "…", "possible_values": ["…"] }
      ],
      "examples": [ { "cli": "auv invoke display.findText \"Settings\"",
                      "call": { "command_id": "display.findText", "inputs": { "query": "Settings" } } } ]
    }
  ]
}
```

Notes:

- `kind`: `positional` (`flag: null`), `value` (`--flag <VALUE>`), `flag` (presence-only boolean).
- `input_key` is exactly the key `auvinvoke.inputs` / `buildInvokeArgs` expects. AUV's convention:
  positional keys are often `query`/`x`/`y`/`delta_x`/`delta_y`/`text`, while option keys are the
  flag name without `--` and keep hyphens (`"input-policy"`, `"exclude-minimized"`,
  `"interval-ms"`, `"click-count"`). Keys are **not** normalized — unknown keys throw.
- `possible_values` is added when clap help lists `[possible values: …]` (e.g. `--button`,
  `--input-policy`, `--relative-to`, overlay `--label-visible` which is an explicit
  `--label-visible <true|false>` **value** option, not a presence flag).
- `support_note.macos` exists only for `input.scrollPoint` in 0.0.43.

### Input-key names differ from DESIGN prose (use the catalog's `input_key`)

DESIGN.md describes parameters as "text", "query", etc.; the actual AUV input keys (what
`auvinvoke.inputs` and `buildInvokeArgs` accept) are:

| command | required/primary input_key(s) | other keys |
| --- | --- | --- |
| `display.findText` / `display.waitForText` / `display.clickText` / `window.findText` / `window.waitForText` / `window.clickText` | `query` (OCR text anchor) | `window.*`: `title`, `index`, `input-policy`, `click-count`, `click-interval-ms`, `timeout-ms`, `interval-ms` |
| `input.typeText` / `input.pasteText` | `text` | `input-policy` |
| `input.pressKeys` | `keys` (repeated positional) | `input-policy`, `count`, `interval-ms` |
| `input.clickPoint` | `x`, `y` | `button`, `relative-to`, `normalized`, `title`, `input-policy`, `click-count`, `click-interval-ms`, `modifiers` |
| `input.scrollPoint` | `x`, `y`, `delta_x`, `delta_y` | `settle-ms` |
| `window.scroll` | `x`, `y` | `dx`, `dy`, `normalized`, `title`, `input-policy`, `settle-ms`, `duration-ms`, `easing`, `sample-rate-hz` |
| `window.list` | — | `exclude-minimized`, `exclude-other-desktops` |
| `application.activate` | — (`target` only) | — |
| `display.captureRegion` | `x`, `y`, `width`, `height` | `label` |
| `window.capture` | — | `title` |

When building the auv_screenshot/auv_ocr/auv_click/auv_type/auv_keys/auv_scroll tool mappings, translate
the tool parameters into these keys before calling `buildInvokeArgs` (e.g. auv_click's `text` →
`query`; auv_ocr's `text` → `query`; auv_type's `text` → `text`; auv_keys' `keys` → `keys`,
`repeat` → `count` + `interval-ms`).

## MCP-vs-CLI mismatches found (all encoded as CLI truth)

Exactly six MCP argument records claim a `value_name` but the CLI has a presence-only flag. The
catalog stores them as `kind: "flag", value_name: null`:

| command | argument | MCP | CLI |
| --- | --- | --- | --- |
| `window.list` | `exclude-minimized` | value `EXCLUDE_MINIMIZED` | presence flag `--exclude-minimized` |
| `window.list` | `exclude-other-desktops` | value `EXCLUDE_OTHER_DESKTOPS` | presence flag `--exclude-other-desktops` |
| `window.scroll` | `normalized` | value `NORMALIZED` | presence flag `--normalized` |
| `window.scrollUntil` | `normalized` | value `NORMALIZED` | presence flag `--normalized` |
| `input.clickPoint` | `normalized` | value `NORMALIZED` | presence flag `--normalized` |
| `input.dragMouse` | `normalized` | value `NORMALIZED` | presence flag `--normalized` |

Everything else agreed: no CLI-only options, no MCP-only options, no positional order/name conflicts,
no requiredness conflicts (43/43 commands, `node tools/generate-catalog.mjs --check` = OK).
MCP `target_policy`/`target.accepted_types` **agree** with CLI behavior; the "mismatches" below are
against DESIGN.md's assumed mapping, not MCP vs CLI.

## Target contract (`--target`)

Accepted CLI forms: `app:<application-id>` (bare ids are also accepted and mean app),
`window:<id>`, `display:<id>`. `window.list` `reference.id` is the window id; `application_id` is the
app id (`null` for system windows such as Window Server).

| commands | target | notes |
| --- | --- | --- |
| `display.capture`, `display.list`, `display.captureRegion`, `display.findText`, `display.waitForText`, `display.clickText`, `window.list`, `input.scrollPoint`, `input.moveMouse`, `input.getPointerPosition`, `permission.probe`, overlay/media/scan | forbidden | passing `--target` yields JSON receipt failure `… forbids --target` |
| `window.get`, `window.setFrame`, `window.setState`, `window.focus`, `window.scroll`, `window.scrollUntil` | **required**, `app:` or `window:` | accepts `window:<id>` |
| `window.capture`, `window.findText`, `window.waitForText`, `window.clickText` | optional, **`app:` only** | `--target window:<id>` fails with `does not support window: targets; accepted target types: application`; `--title <text>` narrows the window inside the app |
| `input.typeText`, `input.pasteText`, `input.pressKeys`, `input.holdKeys`, `input.performKeyboardInputs` | optional, `app:` or `window:` | |
| `input.clickPoint`, `input.dragMouse` | optional, `app:`, `window:`, or `display:` | |
| `application.activate`, `accessibility.focusText` | **required**, `app:` only | |

## Verified argv for the 11 plugin tools

All forms below are from `auv invoke <id> --help` (43/43 parsed) plus live dry-runs / read-only runs;
the "built args" column is exactly what `buildInvokeArgs(command, inputs)` emits (the runner appends
`--target <t>` when `target` is returned, then `--json --no-overlay [--store-root <P>]`).

### 1. `auv_doctor`
- CLI: `auv doctor --json` (root command, no `invoke`, no daemon).
- Fields: `platform, process_id, executable, accessibility, screen_recording_preflight,
  screen_capture_kit, screen_capture_kit_error, all_ok, warnings, recommendation`.
- Current state on this Mac: `accessibility: "missing"`, `screen_recording_preflight: "granted"`,
  `screen_capture_kit: "granted"`, `all_ok: false`.

### 2. `auv_screenshot`
- window target → `window.capture`; **there is no window-id argument**. Use
  `--target app:<application_id>` and optionally `--title <window title>`:
  `auv invoke window.capture --target app:com.mitchellh.ghostty --title "…" --json`
  (verified completed, artifact `.webp`, result `{capture, window}`).
- region → `display.captureRegion` with **required value options in this order**:
  `--x <X> --y <Y> --width <WIDTH> --height <HEIGHT>` (+ optional `--label <LABEL>`), no target.
  Verified: `display.captureRegion --x 0 --y 0 --width 200 --height 120 --json` → completed,
  result `{capture, display}`, artifact `file_path` absolute `.webp`.
- else → `display.capture` (no arguments, target forbidden); verified result
  `{capture:{backend,bounds,pixel_dimensions,scale_factor,fallback_reason}, display:{…}}`.
- `display_id` cannot be passed to `display.capture`/`display.captureRegion` (target forbidden on
  macOS); keep `display_id` as a hint only / ignore with a warning.
- **Window-id mapping problem**: `window.capture` rejects `window:<id>`. If only a `window_id` is
  known, resolve it first with `window.get --target window:<id> --json`, whose `result` contains
  `application_id` and `title` (verified), then call `window.capture --target app:<application_id>
  [--title <title>]`. If `application_id` is null (system window), fail with a clear message.

### 3. `auv_ocr`
- `display.findText <TEXT>` (positional, target forbidden; no `--timeout-ms`).
- `display.waitForText <TEXT> [--timeout-ms <MS>] [--interval-ms <MS>]` (bounds 100..=120000 /
  50..=10000 according to help).
- `window.findText <TEXT> [--title <TITLE>]` / `window.waitForText <TEXT> [--title <TITLE>]
  [--timeout-ms] [--interval-ms]` — **app target only** (`--target app:<id>`), never `window:<id>`;
  same window-id resolution problem as above.
- OCR status update (2026-11-08, Phase B): with **Screen Recording granted to DeepSeek Harness and
  the app restarted**, `display.findText "DeepSeek Harness"` returns `status: completed` with 3
  matches and `window.findText` (app target) also succeeds. Before the grant landed it failed with
  `macos native find_ocr_text failed: vision OCR failed: unknownError; recovery=verify Screen
  Recording/capture output and retry`. Keep surfacing that old failure as a permissions/setup
  limitation ("enable Screen Recording for DeepSeek Harness and restart the app") when it recurs.
- AUV 0.0.43 quirk (CLI-reproduced, not a plugin bug): `display.waitForText` reported
  `did not find text … within 5000 ms` for text that `display.findText` finds on the same screen
  (reproduced via `auv --no-daemon invoke display.waitForText "DeepSeek Harness" --timeout-ms 5000`).
  `window.waitForText` additionally hung past its `--timeout-ms` in one CLI probe (>60 s, killed).
  The plugin maps the argv correctly; the timeout receipt is actionable, but avoid long
  window.waitForText probes.

### 4. `auv_click`
- text → `display.clickText <TEXT> [--within <LEFT,TOP,RIGHT,BOTTOM>]` (target forbidden). `--within`
  is a **single value** string like `0,0,100,100` (value name `LEFT,TOP,RIGHT,BOTTOM`).
- text + app/window → `window.clickText <TEXT> [--title <TITLE>] [--index <N>] [--input-policy …]
  [--click-count <N>] [--click-interval-ms <MS>]`, **app target only** (`--target app:<id>`), no
  `--within` and no `window:<id>`.
- coords → `input.clickPoint <X> <Y> [--button <left|right|middle>] [--relative-to
  <screen|window|display>] [--normalized] [--title <TEXT>] [--input-policy …] [--click-count <N>]
  [--click-interval-ms <MS>] [--modifiers <KEYS> repeatable] [--target app:|window:|display:]`.
  Verified arg order: positionals first, then options.

### 5. `auv_type`
- `input.typeText <TEXT> [--input-policy <background-only|background-preferred|foreground-preferred>]`
  or `input.pasteText <TEXT> [--input-policy …]`, optional `--target app:<id>|window:<id>`.
- Positional text first; options after.

### 6. `auv_keys`
- `input.pressKeys [KEY]... [--count <N>] [--interval-ms <MS>] [--input-policy …]
  [--target app:|window:]` — **keys are repeated positionals**, not `--keys`:
  `input.pressKeys cmd shift p`, `input.pressKeys return --count 2 --interval-ms 100`.
- `--count` > 1 **requires `--interval-ms` > 0** (verified: `--count 2` alone fails with
  `repeated presses require a positive interval; a single press requires zero interval`).
- Map `repeat` (count) to `--count N --interval-ms 100` (or a chosen interval) to avoid that failure.

### 7. `auv_scroll`
- window target → `window.scroll <X> <Y> [--dx <DX>] [--dy <DY>] …` with **required**
  `--target app:<id>|window:<id>` (window-local coordinates; `--normalized` is a flag;
  `--dy` positive scrolls down). `--dx`/`--dy` default to 0.
- no window target → `input.scrollPoint <X> <Y> <DELTA_X> <DELTA_Y> [--settle-ms <MS>]` — four
  **positionals** (NO `--delta-x/--delta-y` flags, NO target). Verified completed.
  **macOS runtime limitation**: `input.scrollPoint` is Linux/Windows-only; help table says macOS
  `no` and catalog `support.macos = "unsupported"` with
  note "the driver exposes only window-owned scrolling". So on macOS scrolling requires a window
  target (`window.scroll`), and `input.scrollPoint` will fail at runtime.
- `window.scrollUntil` exists too: `<X> <Y> --until <CONDITION> --target …` (+ optional `--dx/--dy`
  /`--max-steps`/`--settle-ms`/`--confirmations`/`--region`/`--normalized` flag/`--title`/
  `--input-policy`/`--step-duration-ms`/`--easing`/`--sample-rate-hz`).

### 8. `auv_windows`
- `window.list [--exclude-minimized] [--exclude-other-desktops]` — both are **presence-only flags**;
  invert the plugin params (`include_minimized` → omit `--exclude-minimized`).
- Verified `window.list --exclude-minimized --json` → completed. `result` is the array directly
  (`result[].reference.id`, `.application_id`, `.app_name`, `.title`, `.frame`, `.state`).
  `--wide` only adds human table columns.

### 9. `auv_activate`
- `application.activate --target app:<application-id>` — **required target, no positional app id**
  (MCP example: `--target com.apple.TextEdit`; bare values mean app). Verified
  `application.activate --target app:com.apple.Safari --dry-run --json` parses/executes.
- Result: `{activated_window, application_id_kind, method, requested_application_id, verification,
  window_observation}`; `verification.status` may be `activation_only_foreground_mismatch` when the
  app is not running/foreground.

### 10. `auv_invoke` (generic)
- `buildInvokeArgs` emits positionals then value/flag options, returns formatted `target` separately
  (runner appends `--target`). Then append `--json --no-overlay` (and `--dry-run` only if requested)
  and `--store-root <path>`.
- Unknown `inputs` keys throw; required args validated; arrays flatten repeated args; booleans only
  emitted when truthy (accepts `true`/`false`, `"true"`/`"false"`, `1`/`0`).
- Inputs for repeated `keys` may be arrays; MCP-style JSON-array strings (`'["cmd","l"]'`) are parsed
  with a warning.

### 11. `auv_help` (offline)
- No invocation: `summaryText()` lists all 43 ids + first sentence;
  `commandHelpText(id)` renders description/target/support/arguments/examples (throws for unknown id).

## Other gotchas / limitations found while verifying

1. **`--dry-run` is not a guaranteed no-op.** `application.activate --dry-run` still ran an Apple
   Script activation (returned `method: "apple_script_activate"` and observed the foreground app).
   Do not use `--dry-run` to test input commands blindly; `input.pressKeys`/`input.scrollPoint`
   dry-runs did validate without delivering input.
2. **Targeted input requires Accessibility.** `input.pressKeys cmd l --target app:… --dry-run`
   failed validation with `accessibility permission denied; recovery=grant Accessibility permission`
   (doctor currently reports `accessibility: "missing"`). Untargeted keystrokes use current focus.
3. **OCR/Vision was failing before Screen Recording was granted** (`vision OCR failed:
   unknownError`) even with doctor's `screen_recording_preflight: granted`; after granting Screen
   Recording and restarting the Host it works (`display.findText` completed, 3 matches on
   2026-11-08). When the failure recurs, hint to grant/refresh Screen Recording / restart the app.
   Separately, `display.waitForText` can time out for text that `display.findText` finds (AUV
   quirk, CLI-reproduced); `window.waitForText` hung once in CLI testing.
4. **`--count` requires `--interval-ms`** (see auv_keys).
5. **`window.capture` / `window.findText` / `window.waitForText` / `window.clickText` accept only
   app targets**; `window:<id>` ⇒ JSON receipt failure `invalid_target`. Resolve via `window.get`.
6. **`display.*` forbid `--target`**; a provided target becomes a JSON receipt failure
   (`… forbids --target`) rather than a clap error.
7. **`input.scrollPoint` is unsupported on macOS** at runtime; `window.scroll` needs a target.
8. **`--store-root` placement**: after `invoke <id>`, not before `invoke`.
9. **`doctor` exits 0 when `all_ok` is false**; read the JSON.
10. **`input.scrollPoint` input keys use underscores** (`delta_x`, `delta_y`) while option keys use
    hyphens (`interval-ms`, `exclude-minimized`); mixed conventions come from AUV itself.
11. **`application.activate` and `accessibility.focusText` have no positionals** — only `--target`.
12. Overlay commands exist (`overlay.outline/cursor/status/captureFrame/clickTarget`) with many
    `--…` appearance value options and presence flags such as `--label-visible` (boolean value).
    Not needed by the 11 tools.

## Regeneration / verification

```sh
cd /Users/liliumneko/Projects/dshplugin
node --check tools/generate-catalog.mjs
node --check pkg/dsh-auv/src/catalog.mjs
AUV_LOG_DIR="$PWD/.auvtest/logs" node tools/generate-catalog.mjs          # rewrite catalog.json
AUV_LOG_DIR="$PWD/.auvtest/logs" node tools/generate-catalog.mjs --check  # verify it is current
node notes/catalog-selfcheck.mjs                                          # offline argv/builder checks
```

`generate-catalog.mjs` also works without `AUV_LOG_DIR` (it creates a fresh temp log dir), but the
sandbox-safe recipe above is preferred. Re-run if the installed auv version changes.
