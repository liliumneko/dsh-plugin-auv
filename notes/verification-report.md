# Independent E2E verification report — @local/dsh-auv (installed)

- Owner: auv-catalog-smith (task-3), independent of auv-plugin-builder.
- Date: 2026-11-08 ~04:09–04:15 +08:00 (Asia/Taipei).
- Plugin: `@local/dsh-auv` 0.1.0, auv 0.0.43, installed in the live `desktop` profile by the Lead
  (`plugin_manager install_bundle` → application: applied, enabled).
- Store root (from receipts): `/Users/liliumneko/.dsh/auv/runs` (Host daemon mode).
- Permission state (`auv_doctor` via harness, twice): `platform: macos`,
  `accessibility: missing`, `screen_recording_preflight: granted`, `screen_capture_kit: granted`,
  `all_ok: false`. Vision OCR works now that Screen Recording is granted.
- Safety: no clicks, typing, key presses, or activation were performed. `auv_click`, `auv_type`,
  `auv_keys`, `auv_scroll`, `auv_activate` were verified schema + validation only; their delivery
  argv mapping is covered offline by `tools/check-tools.mjs` and `notes/catalog-selfcheck.mjs`.

## Verdict

**PASS — 11/11 auv_* tools independently verified in the live profile. 0 plugin defects found.**
Counts: 11 tool PASS, 0 FAIL, 5 delivery paths SKIP(safety) (validation PASS instead), 1 environment
note (OCR permission state changed since Phase A). Schema footprint is **8.8× smaller than the
compact MCP-bridge baseline** (13.6× smaller than the 181,539 B pretty dump).

## Schema / token-bloat measurement

Source: `cordis_inspect_query(host, Tool, listTools)` after install — 53 total tools, exactly 11
`auv_*` tools with the expected names. Bytes = `JSON.stringify({name, description, parameters})`.

| tool | compact B | pretty B | description chars | top-level params |
| --- | ---: | ---: | ---: | ---: |
| auv_doctor | 591 | 631 | 463 | 0 |
| auv_screenshot | 1,599 | 2,080 | 509 | 4 |
| auv_ocr | 1,149 | 1,381 | 459 | 5 |
| auv_click | 1,966 | 2,639 | 484 | 8 |
| auv_type | 1,205 | 1,530 | 397 | 5 |
| auv_keys | 1,253 | 1,516 | 413 | 5 |
| auv_scroll | 1,052 | 1,284 | 401 | 5 |
| auv_windows | 756 | 871 | 413 | 2 |
| auv_activate | 627 | 719 | 335 | 1 |
| auv_invoke | 2,632 | 3,011 | 1,352 | 4 |
| auv_help | 562 | 642 | 341 | 1 |
| **plugin total (11 tools)** | **13,392** | **16,304** | max 1,352 | — |

Comparison baseline (measured from a raw `auv mcp serve` `tools/list`, 7 tools):

| baseline | bytes | plugin ratio |
| --- | ---: | ---: |
| MCP tools/list raw file (pretty) | 181,539 | **13.56×** smaller |
| MCP tools/list compact JSON | 117,422 | **8.77×** smaller |
| MCP `invoke` tool alone (compact, incl. 74,213 B embedded `x-auv-commands`) | 111,094 | **8.30×** smaller |

- Approx. tokens (bytes/4): **plugin ≈ 3,348** vs MCP compact ≈ 29,356 / MCP pretty ≈ 45,385.
- On-disk `catalog.json` (93,262 B pretty / 57,307 B compact) is **not** in model context unless
  `auv_help` is called; only the 11 tool schemas above are.
- Schema subset check: all 11 parameters are object roots with `additionalProperties: false`;
  keywords are limited to `type/properties/required/additionalProperties/items/enum/const/
  description` (no `$ref`/`format`/`minimum`/`default`/`oneOf`). Required fields exactly:
  `auv_ocr:[text]`, `auv_type:[text]`, `auv_keys:[keys]`, `auv_scroll:[dy]`,
  `auv_activate:[application_id]`, `auv_invoke:[command_id]`; others none. All descriptions
  < 1.5 KB (max `auv_invoke` 1,352 chars).

## Tool-by-tool results

### T1 `auv_doctor` — PASS
- Call: `auv_doctor {}`.
- Render: "AUV doctor: AUV is not fully ready." + `platform/accessibility/screen_recording_preflight/
  screen_capture_kit/recommendation` + explicit System Settings fix steps (all_ok false).
- Payload: `{platform:"macos", process_id:7128, executable:"/opt/homebrew/bin/auv",
  accessibility:"missing", screen_recording_preflight:"granted", screen_capture_kit:"granted",
  screen_capture_kit_error:null, all_ok:false, warnings:[], recommendation:"Grant Accessibility…"}`.
- Evidence: matches CLI `auv doctor --json` (all_ok false). Re-ran after all negative cases
  (process_id 7742) — still healthy (N9).

### T2 `auv_screenshot` — PASS (5/5 variants + read_image)
| variant | call | result |
| --- | --- | --- |
| 2a display | `{}` | `display.capture`, completed, 3456×2234, `image/webp`, artifact `…/abafdafe-…/01a1b79f-98e8-745d-9a03-8b6e3f34c61d.webp` 382,210 B; `read_image` displayed it (1728×1117 logical image, sha256 matches artifact) |
| 2b region | `{region:{x:0,y:0,width:200,height:120}}` | `display.captureRegion`, completed, 400×240, artifact `…/ba60211f-…/01a1b79f-991a-759c-9b75-2081a4a180a6.webp` 10,174 B; file exists |
| 2c application | `{application_id:"com.deepseek.dsh"}` | `window.capture`, completed, 2560×1640, artifact `…/d6a90dea-…/*.webp` 194,178 B; warning "Capturing the application's main visible window; pass window_id to choose a specific window." (honest hint, acceptable) |
| 2d display_id | `{display_id:"1"}` | resolved to `display.captureRegion`, completed, 3456×2234 (full display), artifact `…/1871b60d-…/*.webp` 388,250 B |
| 2e window_id | `{window_id:"4012"}` | resolved via `window.get` → `window.capture`, completed, 2560×1640, `result.window.reference.id=4012`, no warning; artifact `…/ff0bacdd-…/*.webp` 194,148 B; `read_image` displayed it |
- All artifacts are absolute `.webp` paths under `~/.dsh/auv/runs`, identical to
  `artifacts[0].file_path`, and exist on disk with matching `byte_length` (incl. 2a region
  2c/2d sizes). `read_image` works on `~/.dsh` paths (no sandbox read issue).

### T3 `auv_ocr` — PASS (OCR works; waitForText quirk noted)
- 3a `{text:"DeepSeek Harness"}` → `display.findText` **completed**, `timed_out:false`, 3 matches
  (bounds + confidence), run `476d88c7-…`. **OCR now works** (Screen Recording granted); the
  Phase-A "expected permission failure" no longer applies. Evidence: `display.findText` returns
  `result.matches[{bounds,confidence,text}]`.
- 3e `{text:"DeepSeek Harness", application_id:"com.deepseek.dsh"}` → `window.findText`
  **completed**, 3 matches, `result.window.reference.id=4012`, run `02370b37-…`.
- 3b `{text:"DeepSeek Harness", wait:true, timeout_ms:100}` and retry `timeout_ms:5000` →
  `display.waitForText` failed with actionable
  `did not find text "DeepSeek Harness" within … ms; capture the screen to check what is shown, or
  raise --timeout-ms (command_failed)`, with the exact command line shown. Same failure reproduced
  directly via CLI (`AUV_LOG_DIR=… auv --no-daemon invoke display.waitForText "DeepSeek Harness"
  --timeout-ms 5000`, also for "Settings") → **AUV 0.0.43 upstream behavior, not a plugin mapping
  bug** (the plugin emitted the correct `--timeout-ms` argv). `window.waitForText` via CLI hung
  past its timeout (>60 s, killed) — avoid long window.waitForText probes.
- 3c `{text:"x", timeout_ms:1000}` (no wait) → `Error: timeout_ms is only valid with wait: true.` PASS.
- 3d `{text:"x", wait:true, timeout_ms:50}` → `Error: timeout_ms must be between 100 and 120000.` PASS.
- No click was performed.

### T4 `auv_click` — PASS (validation/schema; delivery SKIP safety)
- `{}` → `Error: auv_click requires either "text" or both "x" and "y".`
- `{text:"Settings", x:1, y:2}` → `Error: Pass either "text" or both "x" and "y" to auv_click, not both forms.`
- `{x:1}` → `Error: auv_click requires either "text" or both "x" and "y".`
- Schema: 8 params, `button` enum `left|right|middle`, `within` requires left/top/right/bottom.
- Delivery mapping verified offline: `display.clickText query [--within "l,t,r,b"]`,
  `window.clickText query --title` with app target, `input.clickPoint x y [--button]`. SKIP(safety).

### T5 `auv_type` — PASS (validation/schema; delivery SKIP safety)
- `{}` → `Error: Missing required parameter "text".`
- `{text:"x", window_id:"4012", application_id:"com.deepseek.dsh"}` →
  `Error: Pass only one of window_id or application_id to auv_type.`
- Schema: `mode` enum `type|paste`, `policy` enum
  `background-only|background-preferred|foreground-preferred`. Mapping (`input.typeText`/
  `input.pasteText text --input-policy`) verified offline. SKIP(safety).

### T6 `auv_keys` — PASS (validation/schema; delivery SKIP safety)
- `{}` → `Error: auv_keys requires "keys" as a non-empty array of key names…`
- `{keys:[]}` → same actionable error.
- `{keys:["ctrl","l"], repeat:300}` → `Error: repeat must be between 1 and 255.`
- `{keys:["ctrl","l"], interval_ms:10}` → `Error: interval_ms is only valid with repeat greater than 1.`
- Schema includes `keys` (array of string), `repeat`, `interval_ms`, window/application ids.
  Mapping: repeated positionals + `--count`/`--interval-ms` (count>1 sends positive interval,
  default 50 ms) — verified offline. SKIP(safety).

### T7 `auv_scroll` — PASS (validation/schema; delivery SKIP safety)
- `{}` → `Error: auv_scroll requires "dy", the vertical delta…`
- `{dy:100}` → `Error: auv_scroll requires "window_id", or both "x" and "y" screen coordinates. On
  macOS AUV cannot scroll at a raw screen point, so prefer window_id.`
- `{dy:100, x:100, y:100}` → `Error: macOS cannot scroll at a screen point: AUV's
  input.scrollPoint is available only on Linux and Windows. Pass window_id …`
- Mapping: `window.scroll x y --dy [--dx]` with required `window:<id>` target; no
  `input.scrollPoint` on macOS. SKIP(safety).

### T8 `auv_windows` — PASS
- `{}` → `{command_id:"window.list", status:"completed", windows:[14 entries], warnings:[]}`.
  14 windows == CLI `window.list` baseline 14 (same run session). Every entry has
  `reference.id`, `application_id` (string|null), `title`, `frame.origin/size`, `state`
  (is_minimized/is_maximized/stack_index/…). DSH window present: `id 4012`,
  `application_id com.deepseek.dsh`, title "…DeepSeek Harness"; system Window Server window
  `id 5` has `application_id:null` (rendered "(unknown app)").
- `{include_minimized:true, include_other_desktops:true}` → also 14 (no minimized/other-desktop
  windows existed at the time; result ≥ default, flags are presence-only in the catalog and were
  inverted correctly — default sends both exclude flags; static + offline check covers the inversion).
- One window title changed between calls ("You are auv-catalog-smith…" vs earlier) — normal churn.

### T9 `auv_activate` — PASS (schema/validation; delivery SKIP safety)
- `{}` → `Error: Missing required parameter "application_id".`
- Schema: single required `application_id`, description says bundle id. Mapping
  `application.activate --target app:<id>` was CLI-verified in task-1. Activation not executed
  (foreground change not on the read-only list). SKIP(safety).

### T10 `auv_invoke` — PASS (7 read-only cases + negatives)
| case | call | result |
| --- | --- | --- |
| 10a | `{command_id:"display.list"}` | completed, `result.displays.length=1`, id `"1"` 1728×1117 @2× — matches CLI |
| 10b | `{command_id:"window.list", inputs:{}}` | completed, `result` array of 14 — matches T8/CLI |
| 10c | `{command_id:"display.captureRegion", inputs:{x:0,y:0,width:100,height:80}}` | completed, `artifacts[0].content_type="image/webp"`, `pixel_dimensions=200×160`, file `…/002b871d-…/*.webp` 3,996 B |
| 10d | `{command_id:"permission.probe"}` | completed: `accessibility:"missing"`, `automation_to_system_events:"granted"`, `screen_capture_kit:"granted"`, `screen_recording:"granted"` (run `f8bf9308-…`) |
| 10e | `{command_id:"window.get", target:{window_id:"4012"}}` | completed, result echoes `reference.id=4012`, `application_id=com.deepseek.dsh` (run `e82b9a80-…`) |
| 10f | `{command_id:"display.list", dry_run:true}` | status completed, `result:null`, no artifacts — dry-run wiring works |
| 10g | `{command_id:"input.getPointerPosition"}` | completed, `result:{x:1051.0234375,y:504.0390625}` (read-only) |

- Note: `permission.probe` via the Host daemon reports `automation_to_system_events:"granted"`,
  while sandboxed CLI `auv --no-daemon` reports `"missing"` — TCC context difference between Host
  and sandboxed child, not a plugin defect.

### T11 `auv_help` — PASS
- `{}` → `mode:"summary"`, `count:43`, text lists all 43 ids with one-line descriptions, note that
  `auv_invoke.command_id` must be one of them.
- `{command_id:"display.findText"}` → `mode:"command"`; text contains `# display.findText`,
  `query (positional <TEXT>, required)`, `Target: none allowed`, support, examples and the
  `auv_invoke` inputs example.
- `{command_id:"not.a.command"}` (`N8`) → `Error: Unknown AUV command "not.a.command". Call
  auv_help without command_id to list every command id.`

## Negative / regression results

| ID | call | observed | verdict |
| --- | --- | --- | --- |
| N1 | `auv_invoke {command_id:"bogus.nope"}` | `Error: Unknown AUV command "bogus.nope". Call auv_help without arguments to list every command id.` | PASS |
| N2 | `auv_invoke {command_id:"display.findText", inputs:{}}` | `Error: Cannot build arguments for AUV command "display.findText": missing required input(s) for display.findText: query Call auv_help with command_id "display.findText"…` | PASS |
| N3 | `auv_invoke {command_id:"display.list", inputs:{bogus:1}}` | `Error: Cannot build arguments for AUV command "display.list": unknown input key(s) for display.list: bogus (allowed: target) …` | PASS |
| N4 | `auv_invoke {command_id:"display.list", target:{display_id:"1"}}` | `Error: AUV command "display.list" does not accept a target. Omit the target parameter.` — deterministic, pre-spawn, no receipt | PASS |
| N5 | OCR permission failure case | Not reproducible: Screen Recording is granted and OCR now completes (T3a/T3e). The closest actionable failure, T3b waitForText timeout, included the "capture the screen … or raise --timeout-ms" hint | SKIP(environment changed) |
| N6 | `auv_invoke {command_id:"window.get", target:{application_id:"com.deepseek.dsh"}}` | **completed** with window result (run `44dc2c57-…`) — earlier `app` vs `application` type-mismatch **regression is fixed** | PASS |
| N6c | `auv_invoke {command_id:"window.get", target:{window_id:"4012"}}` | completed, echoes id (run `e82b9a80-…`) | PASS |
| N7 | `auv_invoke {command_id:"window.capture", target:{window_id:"4012"}}` | catalog-driven early rejection: `Error: AUV command "window.capture" does not accept a window target; accepted target types: application.` | PASS |
| N8 | `auv_help {command_id:"not.a.command"}` | clear unknown-command error | PASS |
| N9 | `auv_doctor {}` after all negative/validation calls | still returns the report (process_id 7742); tool surface intact; no Host crash | PASS |

## Defects

**None found in the plugin.** All 11 tools registered, executed against the live AUV 0.0.43 install,
and produced correctly shaped results/errors within their documented behavior.

Non-plugin observations worth carrying forward:

1. **README wording (builder file, for Lead):** `pkg/dsh-auv/README.md` line 51 and the
   troubleshooting block at lines 199–206 still frame OCR as failing (`vision OCR failed …`). That
   failure was real before Screen Recording was granted; it now completes with matches. Wording
   should describe it conditionally / current state. (`notes/auv-cli-contract.md` was updated with
   the new OCR + waitForText findings in this verification.)
2. **AUV 0.0.43 upstream quirk:** `display.waitForText` reports "did not find text" for text that
   `display.findText` finds on the same screen (CLI-reproduced, not plugin); `window.waitForText`
   hung past `--timeout-ms` once in CLI probing. Plugin mapping is correct; the emitted timeout
   error is actionable. Consider a docs caveat rather than code change.
3. **`auv_windows` inversion coverage:** no minimized/other-desktop windows existed, so the
   default-vs-include flag difference could not be observed live; the presence-flag mapping is
   verified by catalog/self-check and the code path is exercised (default sent both exclude flags,
   result matched CLI). Low risk.
4. **Environment:** Host daemon reports `automation_to_system_events:"granted"` while sandboxed CLI
   reports `"missing"` (TCC context difference); `accessibility` remains `missing` for the AUV child
   (`all_ok:false`), so input tools are expected to be permission-limited until granted — not
   exercised here by design.

## Evidence inventory

- Harness tool calls: doctor ×2, windows ×2, help ×3, screenshot ×5 (+2 read_image), ocr ×5,
  click/type/keys/scroll/activate validation ×14, invoke ×13, read-only CLI cross-checks ×5.
- Screenshot artifacts (all under `/Users/liliumneko/.dsh/auv/runs/artifacts/`):
  `abafdafe-86b3-2038-b48e-fb3fe736abfc/…webp` (display, 382,210 B),
  `ba60211f-c340-819d-6e11-ddb2acc23392/…webp` (region, 10,174 B),
  `d6a90dea-a4a9-ac63-8bb8-5170d865e449/…webp` (app window, 194,178 B),
  `1871b60d-1f4a-1cf6-c8ed-703f8bf219e7/…webp` (display_id region, 388,250 B),
  `ff0bacdd-a38f-6672-488c-146dbbf43c54/…webp` (window_id 4012, 194,148 B),
  `002b871d-2412-f326-0c78-68879e7f0e39/…webp` (invoke captureRegion, 3,996 B).
- CLI baselines: `/tmp/auv-phaseb/{doctor,display.list,window.list,permission.probe}.json`
  (ephemeral) — window count 14, display id "1", DSH window id 4012, matching harness results.
- Plan: `notes/verification-plan.md`. Contract notes: `notes/auv-cli-contract.md`.
