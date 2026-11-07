# Independent end-to-end verification plan — @local/dsh-auv

Owner: auv-catalog-smith (task-3). Independent of auv-plugin-builder.
Status: **Phase B executed 2026-11-08 ~04:09–04:15 +08:00 after the Lead's `INSTALLED` message —
results in `notes/verification-report.md` (PASS, 0 plugin defects).**
This file is the pre-registered plan; safety rules below were followed (no real input actions).

Phase A scope: this plan only. Phase B (after `INSTALLED`): execute the read-only checks below,
record exact payloads, write `notes/verification-report.md`.

## Safety rules for Phase B

- **No real input actions**: never invoke `auv_click` with text/coords, `auv_type`, `auv_keys` with
  valid keys, `auv_scroll` with a window, or `auv_activate` for real. Their delivery mapping is
  covered offline by `tools/check-tools.mjs` + `notes/catalog-selfcheck.mjs` + the verified CLI argv
  in `notes/auv-cli-contract.md`.
- For those five tools, only **validation-only calls** are allowed (calls that fail the plugin's own
  argument checks before any AUV spawn) and **schema inspection**.
- No `plugin_manager` actions by me (Lead owns install/removal), no `~/.dsh` edits, no new servers.
- Read-only AUV calls allowed: `doctor`, `display.list`, `display.capture`, `display.captureRegion`,
  `window.list`, `window.get`, `permission.probe`, `input.getPointerPosition`.
- `auv_screenshot` (capture) is allowed: it writes a `.webp` artifact but delivers no input.
- `auv_ocr`/`display.findText`/`window.findText` are read-only; on this host they are expected to
  fail at the Vision OCR stage (see baseline). That is a SKIP(permissions), not a FAIL, as long as
  the error is actionable.

## Phase B entry check (must all be true)

1. Lead has sent exactly `INSTALLED`.
2. `cordis_inspect_query(platform:"host", provider:"Tool", method:"listTools")` lists all of:
   `auv_doctor`, `auv_screenshot`, `auv_ocr`, `auv_click`, `auv_type`, `auv_keys`, `auv_scroll`,
   `auv_windows`, `auv_activate`, `auv_invoke`, `auv_help` (exactly 11, no extra `auv_*`).
   Pre-install baseline checked 2026-11-08T04:02+08:00: **0** auv_* tools in Tool.listTools.
3. I can actually **call** the auv_* tools from this agent. If Tool.listTools lists them but my
   callable tool surface does not include them, stop and report the blocker to the Lead (agent
   scoping) instead of guessing — do not simulate calls via CLI and present them as harness E2E.
4. Re-read the installed `pkg/dsh-auv/src/tools.mjs`/`catalog.mjs` from the profile-linked package
   path only if needed to explain a failure; the authoritative schema source is Tool.listTools.

## CLI baseline (captured 2026-11-08T04:04+08:00, read-only)

Commands used (sandbox-safe recipe):

```sh
cd /Users/liliumneko/Projects/dshplugin
export AUV_LOG_DIR="$PWD/.auvtest/logs"
auv doctor --json
auv --no-daemon invoke display.list --json --no-overlay
auv --no-daemon invoke window.list --json --no-overlay
auv --no-daemon invoke permission.probe --json --no-overlay
auv --no-daemon invoke display.capture --json --no-overlay
```

Snapshots saved to `/tmp/auv-baseline/*.json` (ephemeral, not shipped). Recorded facts:

| baseline | value |
| --- | --- |
| `doctor` | `platform=macos`, `accessibility="missing"`, `screen_recording_preflight="granted"`, `screen_capture_kit="granted"`, `all_ok=false`, recommendation = grant Accessibility |
| `permission.probe` | `accessibility="missing"`, `automation_to_system_events="missing"`, `screen_capture_kit="granted"`, `screen_recording="granted"` |
| `display.list` | status completed, 1 display `id="1"`, 1728×1117 logical, `scale_factor=2`, builtin+primary |
| `window.list` | status completed, 14 windows (`--exclude-minimized` default? CLI default includes all; 14 observed) |
| notable windows | DSH itself: `reference.id=4012`, `application_id="com.deepseek.dsh"`, title "moeru-ai auv repository — DeepSeek Harness"; system window: `id=5`, `application_id=null`, "Window Server / Menubar" |
| `display.capture` | completed, backend `xcap.macos`, pixel_dimensions 3456×2234, artifact `content_type=image/webp`, `file_path` absolute `.webp` |
| raw sizes | doctor 378 B, display.list 606 B, permission.probe 351 B, window.list 10579 B, display.capture 1899 B |

IDs/counts can drift between runs (windows open/close). Re-run the CLI baseline immediately before
the harness comparisons and compare **counts/shape**, not exact window ids, except ids read from the
plugin's own `auv_windows` result inside the same Phase B session.

## Schema / token-bloat measurement (Phase B)

MCP-bridge baseline (measured 2026-11-08 from `/tmp/auv-tools.json`, raw `tools/list` of
`auv mcp serve`):

- 7 tools, pretty-printed raw file **181,539 B**, compact JSON **117,422 B**.
- `invoke` tool alone: **111,094 B** compact, of which `inputSchema["x-auv-commands"]` is
  **74,213 B** (the full 43-command catalog glued into one tool schema).

Plugin measurement procedure:

1. From `Tool.listTools`, take the 11 entries whose name starts with `auv_`.
2. `pluginBytes = Σ Buffer.byteLength(JSON.stringify({ name, description, parameters }))`
   (compact; also compute pretty, and per-tool bytes for the report).
3. `mcpBytes = 117,422` (compact) / `181,539` (pretty) → ratio `mcpBytes / pluginBytes`.
4. Also report ratio against the MCP `invoke` tool alone (111,094 B).
5. Tokens ≈ bytes / 4 (rough); report both absolute bytes and estimated tokens.
6. PASS criterion: `pluginBytes < 117,422` (strictly smaller than the *compact* MCP baseline) and
   expected ratio ≥ 3×. FAIL if the 11 schemas exceed the MCP baseline. Also report the on-disk
   `catalog.json` size (93 KB) as "not in model context unless auv_help is called".
7. Sanity-check each schema against the DSH supported subset: object root with `type`,
   `properties`, `required`, `additionalProperties:false`, `items`, scalar `enum`/`const`,
   `description`; no `$ref`/`format`/`minimum`/`default`/`oneOf`. Also: 11 names exactly, no
   duplicate names, descriptions mention macOS setup/permissions, description lengths
   (≤ ~1.2 KB each except `auv_invoke`).

## Positive checks — the 11 tools

For every row: capture the full tool result payload (bounded), the rendered text if available, and
the wall-clock status. PASS/SKIP/FAIL rules are per row.

### T1 `auv_doctor`

- Call: `auv_doctor {}`
- Expected payload: `{ platform:"macos", process_id:<int>, executable:<path>, accessibility:"missing", screen_recording_preflight:"granted", screen_capture_kit:"granted", screen_capture_kit_error:null, all_ok:false, warnings:[], recommendation:<string> }`
- PASS: returns the report (no throw), `platform==="macos"`, boolean `all_ok`, render mentions
  `accessibility` and the System Settings fix steps when `all_ok===false`.
- SKIP: n/a (doctor must never need permissions).
- FAIL: throws, empty/missing fields, render claims "all checks passed" while `all_ok:false`.

### T2 `auv_screenshot`

- 2a `auv_screenshot {}` → `display.capture`
  - Expected: `{ run_id, command_id:"display.capture", status:"completed", artifact_path:"/…/x.webp", content_type:"image/webp", width:3456, height:2234, result:{capture:{backend,bounds,pixel_dimensions,scale_factor,fallback_reason},display:{…}}, artifacts:[{uri,purpose,content_type,file_extension,byte_length,sha256,attributes,file_path}], warnings:[] }`
  - PASS: `status==="completed"`, `artifact_path` is absolute, ends `.webp`, equals
    `artifacts[0].file_path`, file exists, `read_image(artifact_path)` returns an image, width/height
    match `result.capture.pixel_dimensions`.
  - FAIL: no artifact, path not `.webp`, `read_image` rejects the path, width/height null, throw.
- 2b `auv_screenshot {region:{x:0,y:0,width:200,height:120}}` → `display.captureRegion`
  - PASS: `command_id==="display.captureRegion"`, artifact exists, `width===400`, `height===240`
    (logical 200×120 × scale 2), result.capture.backend present.
- 2c `auv_screenshot {application_id:"com.deepseek.dsh"}` → `window.capture` (app target)
  - PASS: `command_id==="window.capture"`, completed, artifact `.webp`, result.window present.
  - SKIP: if the app has no capturable window at that moment → record reason (not FAIL).
- 2d `auv_screenshot {display_id:"1"}` → plugin resolves display → `display.captureRegion`
  - PASS: `command_id==="display.captureRegion"`, completed, full-display pixel size 3456×2234.
- 2e `auv_screenshot {window_id:"<id from auv_windows for com.deepseek.dsh>"}` → window.get
  resolution → `window.capture` with `app:` target
  - PASS: completed artifact; `warnings` may mention title fallback (acceptable).
  - SKIP: window id gone between calls (id churn) → retry once with fresh id, then SKIP(reason).
- FAIL for 2b–2e: wrong `command_id`, `window:<id>` reaching AUV (expect an `invalid_target` failure
  receipt if it ever does — that is a plugin mapping defect, not a PASS), or no artifact.
- Note: if `read_image` fails with a **sandbox read denial** for an artifact under `~/.dsh/...`, mark
  SKIP(environment/sandbox) and ask Lead to confirm the image; not a plugin bug.

### T3 `auv_ocr`

Current host expectation: Vision OCR fails even though doctor reports Screen Recording granted
(`display.findText Settings` → `macos native find_ocr_text failed: vision OCR failed: unknownError`).
- 3a `auv_ocr {text:"Settings"}` → `display.findText`
  - PASS if OCR succeeds (matches returned) **or** the thrown error is actionable: contains
    `vision OCR` (or `Screen Recording`) plus the System Settings/restart/`auv_doctor` hint.
    Actionable permission failure = **SKIP(permissions)** in the report, never FAIL.
  - FAIL: raw/unhelpful error, wrong hint, crash, or a "success" that hides an OCR failure.
- 3b `auv_ocr {text:"Settings", wait:true, timeout_ms:100}` → `display.waitForText`; same PASS rule;
  if it returns a receipt with `timed_out:true`, PASS (mapping works).
- 3c validation `auv_ocr {text:"x", timeout_ms:1000}` (no `wait`) → expected plugin error
  `timeout_ms is only valid with wait: true.` → PASS if clear, no AUV input call.
- 3d validation `auv_ocr {text:"x", wait:true, timeout_ms:50}` → expected range error
  `timeout_ms must be between 100 and 120000.` → PASS.
- Optional 3e `auv_ocr {text:"Settings", application_id:"com.apple.systempreferences"}` → exercises
  `window.findText` + app-target resolution; same actionable-permission PASS rule.
- FAIL: unclear message, no auv_doctor hint, or a misleading success.

### T4 `auv_click` — validation only, NO delivery

- 4a `auv_click {}` → expected error requires `text` or both `x`/`y` (before any AUV spawn) → PASS.
- 4b `auv_click {text:"Settings", x:1, y:2}` → expected mutual-exclusion error → PASS.
- 4c `auv_click {x:1}` → expected error requires both `x` and `y` → PASS.
- 4d (schema) parameters expose `text,x,y,window_id,application_id,display_id,button(left|right|middle),within{left,top,right,bottom}`.
- Delivery mapping (**not executed, SKIP(safety)**) is verified offline: `display.clickText query
  [--within "l,t,r,b"]`, `window.clickText query --title` with `app:` target,
  `input.clickPoint x y [--button]` with `app:/window:/display:` target.
- FAIL: a validation call reaches AUV/spawns input, or an error is incomprehensible.

### T5 `auv_type` — validation only, NO delivery

- 5a `auv_type {}` → harness schema rejection (missing required `text`) → PASS.
- 5b `auv_type {text:"x", window_id:"1", application_id:"com.deepseek.dsh"}` → expected plugin
  error `Pass only one of window_id or application_id` (before spawn) → PASS.
- 5c (schema) `mode` enum `type|paste`, `policy` enum
  `background-only|background-preferred|foreground-preferred`.
- Delivery mapping (**SKIP(safety)**): `input.typeText text --input-policy <p>` with `app:/window:`
  target; paste → `input.pasteText`.
- FAIL: validation reaches AUV, text is delivered, or error unclear.

### T6 `auv_keys` — validation only, NO output of keys

- 6a `auv_keys {}` → harness schema rejection (missing `keys`) → PASS.
- 6b `auv_keys {keys:[]}` → expected plugin error `requires "keys" as a non-empty array` (before
  spawn) → PASS.
- 6c `auv_keys {keys:["ctrl","l"], repeat:300}` → expected `repeat must be between 1 and 255.` → PASS.
- 6d `auv_keys {keys:["ctrl","l"], interval_ms:10}` → expected `interval_ms is only valid with
  repeat greater than 1.` → PASS.
- 6e (schema) `keys` array of string, `repeat ≤255`, `interval_ms` documented, window/application
  ids; mapping (`SKIP(safety)`) → repeated positionals + `--count`/`--interval-ms` (count>1 must
  send a positive interval; builder defaults interval to 50 ms).
- FAIL: any validation call presses keys or error unclear.

### T7 `auv_scroll` — validation only, NO scrolling

- 7a `auv_scroll {}` → harness schema rejection (missing required `dy`) → PASS.
- 7b `auv_scroll {dy:100}` → expected error requires `window_id` or both screen `x`/`y` → PASS.
- 7c `auv_scroll {dy:100, x:100, y:100}` → expected macOS error `macOS cannot scroll at a screen
  point` (before any input) → PASS.
- 7d (schema) `dy` required, `dx`, `window_id`, `x`, `y`.
- Delivery mapping (**SKIP(safety)**): `window.scroll x y --dy --dx` with required `window:<id>`
  target (window-local center when x/y omitted); `input.scrollPoint` intentionally not used on macOS.
- FAIL: any validation call scrolls, or message does not explain the macOS constraint.

### T8 `auv_windows` — read-only

- 8a `auv_windows {}` → plugin `{ run_id, command_id:"window.list", status:"completed", windows:[…], warnings:[…] }`
  - PASS: `Array.isArray(windows)`, every entry has `reference.id`, `application_id` (string|null),
    `title`, `frame.origin/size`, `state`; count equals the freshly measured CLI `window.list`
    count (allow a small drift only if a window opened/closed between calls — record it); the DSH
    window (`application_id="com.deepseek.dsh"`) appears and its `reference.id` is usable by T2e.
  - FAIL: `windows` missing/not array, ids missing, or count differs grossly from CLI (>±2 without
    explanation).
- 8b `auv_windows {include_minimized:true, include_other_desktops:true}` → expect count ≥ 8a count
  (flags inverted correctly; presence flags only). PASS if ≥; FAIL if flags ignored/changed shape.

### T9 `auv_activate` — validation only, NO activation

- 9a `auv_activate {}` → harness schema rejection (missing `application_id`) → PASS.
- 9b (schema) `application_id` required, description explains bundle id.
- Delivery mapping (**SKIP(safety)**; activation changes foreground focus, Lead's read-only list
  excludes it): `application.activate --target app:<id>` (no positional), verified via CLI in
  task-1. If Lead later explicitly approves one benign activation of the already-foreground DSH app,
  do it then and record the `{activated_window, method, verification}` payload.
- FAIL: schema missing/loose, or a validation call activates something.

### T10 `auv_invoke` — read-only subset only

- 10a `auv_invoke {command_id:"display.list"}` → `{run_id, command_id:"display.list", status:"completed", result:{displays:[{id:"1",…}]}, artifacts:[], warnings:[]}`
  - PASS: `status==="completed"`, `result.displays.length === 1`, display id `"1"` (match CLI baseline).
- 10b `auv_invoke {command_id:"window.list", inputs:{}}` → `result` array; count/shape matches T8a/CLI.
- 10c `auv_invoke {command_id:"display.captureRegion", inputs:{x:0,y:0,width:100,height:80}}`
  - PASS: completed, `artifacts[0].content_type==="image/webp"`, result capture pixel_dimensions
    200×160; artifact file_path absolute `.webp`.
- 10d `auv_invoke {command_id:"permission.probe"}` → result matches CLI `permission.probe`
  (`accessibility:"missing"`, `screen_recording:"granted"`, `automation_to_system_events:"missing"`).
- 10e `auv_invoke {command_id:"window.get", target:{window_id:"<fresh id>"}}` → completed,
  `result.reference.id` echoes the id, `result.application_id` subset; PASS.
- 10f `auv_invoke {command_id:"display.list", dry_run:true}` → dry-run receipt (status completed,
  result may be null); PASS if `dry_run` wiring produces a receipt without a real result artifact.
- 10g `auv_invoke {command_id:"input.getPointerPosition"}` (read-only; no input delivered) → result
  pointer position `{x,y}`; PASS (SKIP if not exposed by driver, record message).
- FAIL: receipts missing `status`, wrong command_id, artifacts malformed, or the call acts on input.

### T11 `auv_help` — read-only, no auv

- 11a `auv_help {}` → `{mode:"summary", count:43, text:"AUV 0.0.43 invoke commands (43):…"}`
  - PASS: `count===43` (or equals installed catalog count) and text lists `display.findText` etc.
- 11b `auv_help {command_id:"display.findText"}` → `{mode:"command", command_id, text}` where text
  contains `# display.findText`, `query (positional <TEXT>, required)`, target rules, examples.
- 11c `auv_help {command_id:"not.a.command"}` → error `Unknown AUV command "not.a.command"` with a
  pointer to call `auv_help` without args → PASS as clear error.
- FAIL: missing count, unknown id silently returns empty, or the tool spawns AUV.

## Negative / regression checks

| ID | call | expected | classification |
| --- | --- | --- | --- |
| N1 | `auv_invoke {command_id:"bogus.nope"}` | clear error `Unknown AUV command "bogus.nope"`; no auv spawn side effects | PASS if clear; FAIL if raw crash/empty |
| N2 | `auv_invoke {command_id:"display.findText", inputs:{}}` | `missing required input(s) for display.findText: query` + pointer to `auv_help`; no auv run | PASS |
| N3 | `auv_invoke {command_id:"display.list", inputs:{bogus:1}}` | `unknown input key(s) for display.list: bogus (allowed: target)` | PASS |
| N4 | `auv_invoke {command_id:"display.list", target:{display_id:"1"}}` | deterministic rejection before spawn: `does not accept a target` (builder policy check), or a warning + target dropped. No receipt with `invalid_target` | PASS if clear/early; FAIL if confusing/partial receipt |
| N5 | `auv_ocr {text:"Settings"}` | expected Vision OCR permission failure but **actionable**: mentions vision OCR / Screen Recording / auv_doctor / System Settings/restart | SKIP(permissions) if actionable; FAIL if not actionable |
| N6 | `auv_invoke {command_id:"window.get", target:{application_id:"com.deepseek.dsh"}}` | **app/application regression**: must reach AUV and return a window result (or an AUV-level JSON failure, e.g. no main window). MUST NOT fail early with `does not accept a app target` | PASS only if no app/application type-mismatch error |
| N6c | `auv_invoke {command_id:"window.get", target:{window_id:"<fresh id>"}}` | control case: window target works, result echoes id | PASS |
| N7 | `auv_invoke {command_id:"window.capture", target:{window_id:"<id>"}}` | catalog policy rejects `window:` for window.capture before spawn: `does not accept a window target; accepted target types: application` (or AUV JSON `invalid_target` if it reaches AUV — still acceptable evidence of honest catalog data, but note which layer caught it) | PASS if clear; FAIL if silent/misleading |
| N8 | `auv_help {command_id:"not.a.command"}` | clear unknown-command error | PASS |
| N9 | repeat T1/T8 after all negative cases | tool list still intact; no Host crash; auv_* tools still callable | PASS |

`auv_invoke` with `target:{window_id:…}` must be `window.get`/`window.list`-style read-only commands
only — never `input.clickPoint`/`window.clickText`, even with `dry_run:true` (dry-run is not
guaranteed side-effect free; see `notes/auv-cli-contract.md`).

## Phase B report (`notes/verification-report.md`)

For each of the 11 tools + N1–N9, report:

```
### <ID> <tool>
call: <exact JSON args>
outcome: PASS | FAIL | SKIP(reason)
expected: <one line>
observed: <bounded payload excerpt or error text>
evidence: <artifact path(s), CLI baseline comparison, schema bytes>
```

Plus:

1. Schema list: 11 names + per-tool `name+description+parameters` byte sizes (compact + pretty),
   `pluginBytes`, `mcpBytes=117422/181539`, `ratio = mcpBytes/pluginBytes`, ≈tokens.
2. Installed tool-description sanity: lengths, macOS permission guidance present.
3. Defect list: every FAIL with exact harness call + reproduction via CLI
   (`AUV_LOG_DIR="$PWD/.auvtest/logs" auv --no-daemon invoke … --json`) and observed vs expected.
4. Environment notes: permissions state (doctor), artifact store root, any sandbox-related SKIPs.
5. Verdict: PASS/FAIL for "plugin independently verified in live desktop profile", with counts
   (PASS/FAIL/SKIP) and the schema ratio.

## Expected result summary (pre-registered)

- Expected PASS: T1, T2a–T2d, T8, T10a–T10f, T11, N1–N4, N6, N6c, N7, N8, N9.
- Expected SKIP(permissions): T3 (OCR Vision), optional T10g.
- Expected SKIP(safety): T4–T7 and T9 delivery mappings (validation-only PASS instead), T2e only if
  window id churn.
- Any FAIL must name a concrete plugin defect with a reproduction command; environment/permission
  limitations are reported as SKIP with the doctor evidence, never as PASS.
