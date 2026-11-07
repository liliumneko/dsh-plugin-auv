# DSH × AUV integration plugin — build spec

Status: historical build specification for this repository (the integration is implemented and
verified; see README.md and notes/verification-report.md). File paths describe the repository as it
was laid out during the build (each package file lived under pkg/dsh-auv/ then; it is now at the
repository root).

## Goal

Build a DeepSeek Harness (DSH) **Host plugin bundle** named `@local/dsh-auv` that exposes
[AUV](https://github.com/moeru-ai/auv) OS-automation as first-class native DSH tools
(screenshot, OCR, click, type, keys, scroll, windows, activate, raw invoke, doctor, help).

Install target: the `desktop` profile at `~/.dsh/profiles/desktop`, installed by the Lead with
`plugin_manager install_bundle`. This is a local directory install (linked, not packed), so
`files` metadata is informational.

## Environment facts (verified)

- Workspace: `/Users/liliumneko/Projects/dshplugin` (empty except test dirs). No git repo.
- DSH install: `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`
  (read-only; only the Host process can read inside it).
- AUV 0.0.43 installed at `/opt/homebrew/bin/auv` (Homebrew symlink).
- auv state/log dirs live under `~/Library/Application Support/ai.moeru.auv`; **the DSH bash tool
  sandbox cannot write there**, so all teammate command-line tests of `auv` must set
  `AUV_LOG_DIR="$PWD/.auvtest/logs"` and pass root option `--no-daemon` (e.g.
  `AUV_LOG_DIR="$PWD/.auvtest/logs" auv --no-daemon invoke display.list --json`).
  With those two, invocations write only `<cwd>/.auv/store` and succeed inside the sandbox.
  The installed plugin itself runs in the unsandboxed Host process and uses the normal daemon.
- Current macOS permission state (`auv doctor --json`): `accessibility: missing`,
  `screen_recording_preflight: missing`, but `display.capture` still succeeds via `xcap.macos`;
  `display.findText` (Vision OCR) currently fails with `vision OCR failed: unknownError` until
  Screen Recording is granted. Tools must surface this clearly instead of pretending success.
- Existing DSH tool API facts:
  - Host plugin export form: `export const inject = ['tools']; export function apply(ctx) { ... }`,
    optional `export const Config` (we do NOT use Config: see constraints).
  - `ctx.tools.register(definition)` is effect-scoped by the registry: no manual disposal needed in
    `apply`; a later unload removes the tools.
  - A `ToolDefinition` is a plain object:
    `{ name, description, parameters /* object JSON Schema */, output: { schema, render(args, value) }, execute(args, exec), timeoutMs?, isConcurrencySafe?(args) }`.
    `render` returns ContentBlock[] like `[{ type: 'text', text: '...' }]`. `execute` returns a
    lossless JSON value validated against `output.schema`. `exec.signal` is an AbortSignal.
  - Supported raw-JSON-schema subset (parameters): object root with `type`, `properties`,
    `required`, `additionalProperties: false`, `items`, `oneOf`, scalar `enum`/`const`,
    `description`. No `$ref`, `format`, `minimum`, `default`, etc. For output use the
    annotation-only schema `{}` (accepts any JSON) unless a stricter object schema is easy.
- DSH native `read_image` tool exists; it accepts PNG/JPEG/WebP/GIF paths. AUV capture artifacts
  are `.webp` files with an absolute `file_path` in the receipt, so screenshot tools return that
  path and the model reads it with `read_image`. Do NOT return image bytes.

## Hard constraints

1. Plain ESM JavaScript only. **No npm dependencies and no imports from `@deepseek-ai/*` or any
   non-builtin module** (resolution from a profile-linked package is unreliable). Node builtins
   (`node:child_process`, `node:fs`, `node:path`, `node:os`, `node:url`) are fine.
2. No TypeScript, no build step, no bundler. `node --check` must pass on every `.js`/`.mjs` file.
3. Plugin must degrade safely: if `auv` is missing, tools register and fail at execute time with a
   clear, actionable error (install AUV / set `AUV_BIN`), never crash the Host.
4. Never block the Host event loop; every auv call is async with abort + timeout handling.
5. Only write files inside your assigned write scope. Never touch `~/.dsh` directly.

## Package layout

The repository root is the bundle package itself:

```
.
  package.json
  cordis.patch.yml
  index.js                 # plugin entry: inject/apply, registers tools
  src/auv.mjs              # binary discovery + spawn/JSON runner + receipt helpers
  src/catalog.mjs          # catalog loading + CLI argv builder
  src/catalog.json         # generated command catalog
  src/tools.mjs            # all ToolDefinitions built from auv.mjs + catalog.mjs
  locale/en.json           # meta.title / meta.description
  locale/zh.json           # meta.title / meta.description
  icon.svg                 # official AUV logo on a white rounded background
  README.md, README.zh.md  # user documentation (English / Chinese)
  LICENSE                  # Apache-2.0
tools/
  generate-catalog.mjs     # regenerates src/catalog.json from `auv mcp serve`
  check-tools.mjs          # offline schema/argv/missing-AUV self-checks
notes/                     # verification evidence (not part of the npm files list)
```

`index.js`:

```js
export const inject = ['tools']
export function apply(ctx) {
  const { createTools } = await import('./src/tools.mjs') // or static import
  for (const definition of createTools()) ctx.tools.register(definition)
}
```

Static imports are fine; keep top-level import of local files. Do not install anything at module
load; resolve the auv binary lazily on first execute.

`package.json`:

```json
{
  "name": "@local/dsh-auv",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "src", "cordis.patch.yml", "locale", "icon.svg", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-auv
      name: '@local/dsh-auv'
```

## AUV CLI contract (verified unless marked TODO)

- Root options precede the subcommand: `auv [--device <name>|--device-id <id>] [--no-daemon] invoke <command-id> [ARGS] [OPTIONS]`.
- `--json` renders a machine-readable receipt on stdout. Reply shape on success:
  `{ "run_id": "...", "status": "completed", "command_id": "...", "store_root": "...", "result": <command result>, "artifacts": [ { "uri", "purpose", "content_type", "file_path", "byte_length", "sha256", "attributes": {...} } ] }`.
  On command failure stdout still carries JSON:
  `{ "run_id", "status": "failed", "command_id", "store_root", "result": null, "failure": "...", "failure_details": { "code": "command_failed", "message": "..." } }`.
  A missing/unsupported CLI arg instead prints a plain-text clap error on stderr with a non-JSON
  stdout (exit code != 0). The runner must handle both.
- `--store-root <PATH>` persists the run/artifacts there. The plugin passes an explicit root
  (`<DSH_HOME or ~/.dsh>/auv/runs`, env override `AUV_DSH_STORE_ROOT`) so artifact paths are stable.
- Daemon: default is to use the local daemon (auto-started). Env `AUV_DSH_NO_DAEMON=1` adds the
  root option `--no-daemon`. Visual overlays: pass `--no-overlay` by default; env
  `AUV_DSH_OVERLAY=1` leaves overlays on.
- `auv doctor --json` (no daemon needed) reports permissions/readiness. Field names include
  `platform`, `accessibility`, `screen_recording_preflight`, `screen_capture_kit`, `all_ok`,
  `recommendation`.
- Capture receipts put the artifact file in `artifacts[0].file_path` (absolute, `.webp`).
- Command argument shapes are discovered from `auv invoke <id> --help` (Arguments section =
  positionals, Options section = `--flag <VALUE>` vs presence-only flags). TODO (catalog-smith):
  verify each command's exact argv for the tool mappings below, especially repeated flags,
  boolean flags, `--target` accepted forms (`app:<id>` / `window:<id>` / `display:<id>`), and
  positional order.
- `window.list` result is an array of windows with `reference.id`, `application_id`, `app_name`,
  `title`, `frame`, `state`.
- `display.capture` result: `{ capture: { backend, bounds, pixel_dimensions, scale_factor, fallback_reason }, display: {...} }`.
- `display.list` result: `{ displays: [ { id, name, frame, scale_factor, is_primary, is_builtin, coordinate_space } ] }`.
- `display.findText` on failure: `failure` string contains `vision OCR failed ...`; the plugin should
  append a hint to grant Screen Recording to DeepSeek Harness.

## Runner requirements (`src/auv.mjs`)

Exports (suggested; builder may refine):

- `resolveAuvBinary()` → absolute path string. Order: `process.env.AUV_BIN` (must exist) →
  candidates derived from PATH plus `/opt/homebrew/bin`, `/usr/local/bin`, `${HOME}/.local/bin`,
  `${HOME}/.cargo/bin` → throw actionable error. Cache once resolved.
- `runAuv({ commandId, argv, target, device, dryRun, extraOptions, signal, timeoutMs })` →
  `Promise<receipt>`; builds the full argv, spawns, enforces timeout and abort (kill child,
  reject with a message including stderr tail), parses JSON stdout. On `status: 'failed'` throw an
  `Error` whose message includes `failure` + `failure_details.message`; attach the receipt for
  `auv_doctor`-style output? (Keep it simple: `Error` with compact JSON detail, truncated.)
- Child env: `{ ...process.env }` plus PATH augmented with `/opt/homebrew/bin:/usr/local/bin`.
  Do not scrub vars. `cwd` may be omitted.
- Keep stdout/stderr captured with a bounded buffer (e.g. 8 MiB) and include the stderr tail on
  errors.
- Timeout default 120_000 ms; per-call override from tool args (`timeout_ms`), clamp 1_000..300_000.

## Catalog contract (`src/catalog.json` + `src/catalog.mjs`)

`tools/generate-catalog.mjs` runs the MCP handshake against `auv mcp serve` (spawn, JSON-RPC
`initialize` with protocolVersion `2025-06-18`, then `tools/list`), takes
`tools[].name === 'invoke'`, and serializes:

```json
{
  "auv_version": "0.0.43",
  "generated_at": "<ISO date>",
  "commands": [
    {
      "id": "display.findText",
      "namespace": "display",
      "description": "...",             // one-paragraph, from x-auv-commands
      "target": { "policy": "forbidden|required|optional", "accepted_types": ["window","application","display"] },
      "arguments": [
        { "input_key": "query", "flag": null, "kind": "positional", "required": true, "repeated": false, "value_name": "TEXT", "help": "..." },
        { "input_key": "timeout-ms", "flag": "--timeout-ms", "kind": "value", "required": false, "repeated": false, "value_name": "MS", "help": "..." }
      ],
      "examples": [ { "cli": "auv invoke display.findText \"Settings\"", "call": { "command_id": "...", "inputs": {...} } } ]
    }
  ]
}
```

`kind` rules:
- `positional`: clap `Arguments` entry (`<TEXT>`, `<X> <Y>`); `flag: null`.
- `value`: option that takes a value (`--timeout-ms <MS>`, `--x <X>`).
- `flag`: presence-only boolean option (`--exclude-minimized`); value in inputs is `true`/`false`
  (or `"true"`/`"false"`); include the flag only when truthy.
- `repeated`: option that may appear multiple times (inherited from x-auv-commands `repeated`).
- `required`: from x-auv-commands; positional ordering must follow clap help order.
Cross-check the MCP metadata (flags/input_key) against parsed CLI help; if they disagree, CLI help
wins for argv and the mismatch is noted in `notes/`.

`src/catalog.mjs` exports:
- `loadCatalog()` / `CATALOG` (sync read from `./catalog.json` via `readFileSync` + `new URL`).
- `getCommand(id)`.
- `buildInvokeArgs(command, inputs)` → `{ args: string[], target?: string, warnings: string[] }`:
  converts `inputs` object (string | number | boolean | string[] values) into positional + flag
  argv, validates required arguments and unknown keys (unknown key → throw), maps boolean flags,
  arrays to repeats. Also `formatTarget(target)` → `app:<id>` / `window:<id>` / `display:<id>`.
- `summaryText()` / `commandHelpText(id)` for the `auv_help` tool (compact: id + first sentence;
  detail: description, required/optional args with kinds, support, examples).

## Tools (11) — exact model-facing names and mappings

All tools: `isConcurrencySafe: () => false` (machine input is mutually exclusive), `timeoutMs`
between 120_000 and 180_000. Descriptions must state macOS setup (`auv_doctor` first; grant
Accessibility + Screen Recording to DeepSeek Harness if commands report permission errors) and be
sentence-case.

1. `auv_doctor` — no parameters. argv: `doctor --json` (no daemon option). Returns the report.
   Render: pretty JSON plus a short English summary; when `all_ok === false`, append explicit
   steps: `System Settings → Privacy & Security → Accessibility / Screen Recording → enable
   DeepSeek Harness, restart the app`.
2. `auv_screenshot` — params: `window_id?` string, `application_id?` string, `display_id?` string,
   `region?` object `{x:number,y:number,width:number,height:number}` (all required inside; only
   valid without a window target).
   Mapping: window target → `window.capture`; else region → `display.captureRegion` (+ `--x`,
   `--y`, `--width`, `--height`; display target if `display_id` accepted — verify); else
   `display.capture` (+ display target if supported). Return value
   `{ run_id, command_id, status, artifact_path, content_type, width, height, result, artifacts }`
   where `artifact_path = artifacts[0].file_path` (null if none). Render text containing
   `artifact_path` and the instruction to call `read_image` with it.
3. `auv_ocr` — params: `text` string required, `window_id?`, `application_id?`, `wait?` boolean,
   `timeout_ms?` integer (100..120000, only with wait). Mapping: wait →
   `display.waitForText`/`window.waitForText` (positional `text`, `--timeout-ms`); else
   `display.findText`/`window.findText`. Return receipt result (matches).
4. `auv_click` — params: `text?` string, `x?` number, `y?` number, `window_id?`, `application_id?`,
   `display_id?`, `button?` enum left|right|middle, `within?` object
   `{left:number,top:number,right:number,bottom:number}`. Rule: exactly one of `text` or (`x` and
   `y`). Text → `display.clickText`/`window.clickText` positional text (+ `--within` as
   `left,top,right,bottom`; verify format). Coords → `input.clickPoint` positional `x y`, `--button`
   (default left) and target. Validate rule in execute and throw a clear error otherwise.
5. `auv_type` — params: `text` required, `mode?` enum `type`|`paste` (default `type`), `window_id?`,
   `application_id?`, `policy?` enum `background-only`|`background-preferred`|`foreground-preferred`.
   Mapping: `input.typeText` / `input.pasteText` positional text, `--input-policy`, `--target`.
6. `auv_keys` — params: `keys` string[] required (key names like `["ctrl","l"]`), `repeat?` integer,
   `window_id?`, `application_id?`. Mapping: `input.pressKeys` (verify: repeated positional keys
   vs `--keys`/`--repeat`; show help in README).
7. `auv_scroll` — params: `dy` number required (positive scrolls down), `dx?` number, `window_id?`,
   `x?`, `y?`. Mapping: window target → `window.scroll` (verify flag names, likely `--dy`/`--dx`);
   else `input.scrollPoint` positional x y (+ `--delta-x`/`--delta-y`; verify).
8. `auv_windows` — params: `include_minimized?` boolean, `include_other_desktops?` boolean.
   Mapping: `window.list` with the CLI's exclude flags (`--exclude-minimized`,
   `--exclude-other-desktops`; verify they are presence flags) inverted from the params.
9. `auv_activate` — params: `application_id` string required. Mapping: `application.activate`
   positional app id (verify).
10. `auv_invoke` — params: `command_id` string required (enum of all catalog ids is too large; use
    a free string plus a short id list in the description, or `enum` only if under ~30 ids — the
    builder decides but must keep description under ~1.5 KB), `inputs?` object with
    `additionalProperties` oneOf string|array-of-strings, `target?` object
    `{application_id?, window_id?, display_id?}` (exactly one), `dry_run?` boolean.
    Mapping: `buildInvokeArgs`, plus `--target`, `--dry-run`, `--json`. Return receipt
    `{ run_id, command_id, status, result, artifacts }`.
11. `auv_help` — params: `command_id?` string. No auv invocation: returns `summaryText()` (all 43
    ids + one-line description) or `commandHelpText(id)` for a specific id. Include a note that
    `auv_invoke.command_id` must be one of these ids.

Tool description rules: each must explain "what it does", "when to use", required setup/permissions,
and that input actions need Accessibility permission. Keep each description under ~1.2 KB except
`auv_invoke`.

## Render requirements

- Success: human-readable text summary + `JSON.stringify(value, null, 2)` only when small
  (bounded to e.g. 20 KB); artifacts list paths.
- Failure is thrown from `execute`, so the registry renders the error text; include the auv
  `failure_details.message` and a hint for permission failures (`permission`, `TCC`,
  `accessibility`, `vision OCR`) pointing at `auv_doctor` and System Settings.

## Offline checks (`tools/check-tools.mjs`, owned by plugin-builder)

No auv invocation; import `src/tools.mjs` and `src/catalog.mjs` and assert:
- every tool definition has valid name/description/parameters object/required fields;
- `parameters` passes the supported subset (write a local minimal validator mirroring
  dsh-tools' subset);
- `buildInvokeArgs` produces expected argv for representative cases: `display.findText` with
  `{query:"Settings"}` → positional; `display.captureRegion` flags; `window.list` boolean flags;
  `input.clickPoint` positional x y; unknown key throws; missing required throws.
- print PASS lines and exit non-zero on any failure.

## Verification (Lead)

1. `node --check` all JS.
2. `node tools/check-tools.mjs` (builder) + Lead re-runs it.
3. Lead installs with `plugin_manager action=install_bundle target=/Users/liliumneko/Projects/dshplugin` (the repo root is the package),
   then confirms tools appear (cordis_inspect Tool.listTools shows `auv_*`).
4. Lead invokes through the harness: `auv_doctor`, `auv_screenshot` (+ `read_image` on the returned
   path), `auv_windows`, `auv_invoke` with `display.list`. OCR/input may fail on missing macOS
   permissions; that must be reported as a permission limitation, not a plugin bug.
5. Cleanup test dirs `.auv`, `.auvtest`, `.auvprobe` before final delivery.

## Notes / open items

- `auv` daemon autostart from the Host process is expected to work because the Host is unsandboxed;
  if the first tool call fails with a daemon socket/permission error, fall back to `--no-daemon` by
  default and record why in README.
- Do not add approval gating in v1; document that input tools perform real clicks/typing.
