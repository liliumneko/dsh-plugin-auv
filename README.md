<p align="right"><img src="icon.svg" width="72" alt="AUV desktop automation"></p>

# dsh-auv — AUV desktop automation for DeepSeek Harness

**English** | [简体中文](./README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Host plugin bundle that
exposes [AUV](https://github.com/moeru-ai/auv) OS automation as eleven native model tools:
screenshots, Vision OCR, clicks, typing, key presses, scrolling, window listing, app activation, a
raw command escape hatch, a readiness check, and catalog help.

> [!WARNING]
> **Installing this plugin alone does nothing.** It is only the DeepSeek Harness ↔ AUV bridge.
> Before the tools can automate anything you must install the external **AUV CLI** and grant
> macOS permissions to **DeepSeek Harness** — see [Before you start](#before-you-start).
> Until then the tools still load, but every call returns actionable setup instructions instead of
> working (`auv_doctor` reports what is missing).

## Before you start

The plugin has three external prerequisites. Skipping any of them is the most common reason the
tools appear to "do nothing".

1. **Install the AUV CLI and put it on `PATH`.** Check with `auv --version`.

   | Platform | Install |
   | --- | --- |
   | macOS | `brew install moeru-ai/tap/auv` |
   | macOS / Linux | `curl -fsSL https://auv.moeru.ai/install.sh \| sh` |
   | Windows | `scoop bucket add auv https://github.com/moeru-ai/auv` then `scoop install auv/auv` |
   | proto | `proto plugin add auv "https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml" --to global` then `proto install auv latest --config-mode global --pin global` |
   | Cargo / Nix | see the [AUV install guide](https://github.com/moeru-ai/auv#install) |

   If AUV lives outside `PATH`, set `AUV_BIN` to the absolute executable path before starting
   Harness.

2. **Grant macOS permissions to DeepSeek Harness** (not to `auv`, not to Terminal):
   - **Accessibility** — needed to click, type, press keys, scroll, and focus applications.
   - **Screen Recording** — needed for screenshots and OCR.
   - macOS 27+ merges the permission lists into **System Settings → Privacy & Security → Device
     Control and Data Access**; older macOS shows **Accessibility** and **Screen Recording** as
     separate rows. Enable `DeepSeek Harness.app` there (add it with `+` if it is missing).
   - **Quit and restart DeepSeek Harness** after granting; permissions are only read at process
     start.

3. **Install and enable this plugin** in the `desktop` profile (see [Install](#install)), then run
   `auv_doctor`. A ready host reports `all_ok: true`.

## What is AUV?

**AUV** means *Application Use Via ...*: a unified orchestration layer for OS automation, described
by its authors as "programmable computer use, more like Playwright for the OS".

- It is **not an agent**. AUV ships a CLI, a stdio MCP server, a local daemon, typed command
  contracts (Protobuf/gRPC), and TypeScript/Rust SDKs. Agents call it; it never decides for you.
- Repeated GUI work becomes **reusable, inspectable commands** (`auv invoke <command-id>`) that
  produce recorded Runs and artifacts, instead of a token-expensive screenshot → click → verify
  loop. Once a flow is a command, repeated execution costs no reasoning tokens.
- Platform support: macOS, Linux, and Windows; 43 core commands in AUV 0.0.43 covering displays,
  windows, input, accessibility, media, and scans.

Useful AUV links:

- Repository: <https://github.com/moeru-ai/auv>
- Documentation / install site: <https://auv.moeru.ai>
- Terms and concepts: <https://github.com/moeru-ai/auv/blob/main/docs/TERMS_AND_CONCEPTS.md>
- Supported apps and extensions: <https://github.com/moeru-ai/auv/tree/main/supported>

**Navigation:** [Before you start](#before-you-start) · [Install](#install) ·
[macOS permissions](#macos-permissions) · [Tools](#tools) · [Configuration](#configuration) ·
[Examples](#examples) · [Why a native plugin](#why-a-native-plugin-instead-of-the-mcp-bridge) ·
[Troubleshooting](#troubleshooting) · [Development](#development) · [Attribution](#attribution)

## Install

This repository *is* the plugin bundle package. The runtime artifact is the prebuilt single file
`dist/index.mjs` (built with [tsdown](https://tsdown.dev); no runtime npm dependencies), committed
to the repository, so cloning and installing needs no build step.

1. Install AUV, grant permissions, and restart Harness — see [Before you start](#before-you-start).
2. Clone this repository anywhere:

   ```sh
   git clone https://github.com/liliumneko/dsh-plugin-auv.git
   ```

3. Install the bundle into the current DSH profile, pointing at the clone:

   ```
   plugin_manager action=install_bundle target=/absolute/path/to/dsh-auv
   ```

   The equivalent UI path is **Settings → Plugins → Add plugin → Install from directory**, then
   enable the **AUV desktop automation** row.
4. The eleven `auv_*` tools appear for the next model step. Run `auv_doctor` to confirm the
   prerequisites; a machine that is ready reports `all_ok: true`.

The bundle is installed as a linked local directory: `git pull` and restart Harness to update.
Disable it with `plugin_manager action=set_plugin target=dsh-auv enabled=false`.

## macOS permissions

AUV drives the real desktop, so macOS must trust the **DeepSeek Harness** app, not just `auv`:

1. Open **System Settings → Privacy & Security**. On macOS 27+ the individual permission lists are
   merged into **Device Control and Data Access** (Chinese: 设备控制与数据访问); on older macOS open
   **Accessibility** and **Screen Recording** as separate rows.
2. Enable **DeepSeek Harness** in that permission list (the macOS 27+ pane shows one switch per
   app). If the app is missing, click `+` and choose `/Applications/DeepSeek Harness.app`, or
   trigger an input command once and approve the prompt.
3. **Quit and restart DeepSeek Harness** (permission grants are only read at process start).
4. Run `auv_doctor` and confirm `all_ok: true`; `permission.probe` should report
   `accessibility: granted` and `screen_recording: granted`.

| Permission | Needed for |
| --- | --- |
| Accessibility | `auv_click`, `auv_type`, `auv_keys`, `auv_scroll`, `auv_activate`, and any other input action |
| Screen Recording | `auv_screenshot`, `auv_ocr`, and the OCR step inside text-based `auv_click` |

Capturing can still work when Screen Recording is missing (AUV falls back to a non-permissioned
backend), but OCR fails with `vision OCR failed …` until it is granted.

## Tools

All tools run `auv` asynchronously, enforce a timeout, and are marked non-concurrency-safe because
OS input is mutually exclusive. Errors carry the AUV failure code plus a permission hint where
relevant; a missing AUV returns copy-pasteable install instructions.

| Tool | What it does | AUV command(s) |
| --- | --- | --- |
| `auv_doctor` | Reports platform, Accessibility/Screen Recording state, capture backend, `all_ok`, recommendation | `auv doctor --json` |
| `auv_screenshot` | Captures the desktop, a window, an application, a display, or a screen region; returns `artifact_path` for `read_image` | `display.capture`, `display.captureRegion`, `window.capture` |
| `auv_ocr` | Finds text on screen or in a window; optionally polls (`wait: true`) for it | `display.findText`, `window.findText`, `display.waitForText`, `window.waitForText` |
| `auv_click` | Clicks OCR text or an exact point, with optional target/display/button/fence | `display.clickText`, `window.clickText`, `input.clickPoint` |
| `auv_type` | Types or pastes text into the focused control | `input.typeText`, `input.pasteText` |
| `auv_keys` | Presses one key combination, optionally repeated | `input.pressKeys` |
| `auv_scroll` | Scrolls inside a window, or at a screen point (Linux/Windows only) | `window.scroll`, `input.scrollPoint` |
| `auv_windows` | Lists switchable windows with ids, app ids, titles, frames, state | `window.list` |
| `auv_activate` | Brings an application to the foreground | `application.activate` |
| `auv_invoke` | Runs any AUV command with typed inputs and an optional target | any catalog command |
| `auv_help` | Lists all command ids, or detailed arguments/examples for one | none (catalog only) |

### Window and display targeting

AUV 0.0.43 does not accept `window:<id>` on `window.capture`, `window.findText`,
`window.waitForText`, or `window.clickText` — those commands accept an application target plus an
optional `--title`. The plugin therefore resolves a `window_id` through `window.get` first (cached
for 30 seconds) and then calls the window command with `app:<application_id>` and the window title.

`display.*` commands forbid `--target` entirely. A `display_id` passed to `auv_screenshot` is
resolved through `display.list` and captured with `display.captureRegion` using the display frame.

`auv_scroll` without `window_id` maps to `input.scrollPoint`, which exists only on Linux and
Windows; on macOS it fails fast with an actionable error. Pass `window_id` instead.

`auv_invoke` can run every catalog command, but `dry_run` is not a universal no-side-effect flag:
`auv invoke application.activate --dry-run` still activates the application.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUV_BIN` | resolved from `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin` | Absolute path to the `auv` executable. Invalid values fail fast with install instructions. |
| `AUV_DSH_STORE_ROOT` | `$DSH_HOME/auv/runs` (usually `~/.dsh/auv/runs`) | `--store-root` for every invocation, so run receipts and `.webp` artifacts have stable paths. |
| `AUV_DSH_NO_DAEMON` | unset (use the local AUV daemon) | `1`/`true`/`yes` adds the root option `--no-daemon` to every `auv invoke`. |
| `AUV_DSH_OVERLAY` | unset (overlays off) | `1`/`true`/`yes` leaves AUV's live visual overlays enabled; by default the plugin passes `--no-overlay`. |

The `auv` child process inherits the Harness environment and gets
`/opt/homebrew/bin:/usr/local/bin` appended to `PATH`, so a GUI-launched Harness can find a
Homebrew-installed AUV.

## Examples

```
auv_doctor {}
```

```
auv_windows {}
```

```
auv_screenshot { "window_id": "<id from auv_windows>" }
# → { artifact_path: ".../….webp", width: 1886, height: 1190, ... }
# then: read_image { "file_path": "<artifact_path>" }
```

```
auv_ocr { "text": "Save", "application_id": "com.apple.TextEdit", "wait": true, "timeout_ms": 5000 }
```

```
auv_click { "text": "Save", "application_id": "com.apple.TextEdit" }
```

```
auv_type { "text": "hello", "application_id": "com.apple.TextEdit", "mode": "paste" }
```

```
auv_keys { "keys": ["cmd", "shift", "t"] }
```

```
auv_keys { "keys": ["cmd", "t"], "repeat": 3, "interval_ms": 120 }
# repeat > 1 sends --count plus --interval-ms (default 50 ms); AUV requires both.
```

```
auv_scroll { "window_id": "<id from auv_windows>", "dy": 600 }
```

```
auv_invoke { "command_id": "display.list" }
```

```
auv_help { "command_id": "display.findText" }
```

## Why a native plugin instead of the MCP bridge

AUV already ships `auv mcp serve`, and connecting it through `@deepseek-ai/dsh-mcp-client` works
with zero code. That route, however, exposes AUV's full MCP schema set: measured 181,539 bytes
pretty / 117,422 bytes compact on AUV 0.0.43 — about 29k tokens of tool schemas in **every** model
request, most of it AUV's embedded 74 KB command catalog inside a single `invoke` tool.

This bundle registers eleven focused tools whose schemas total **13,392 bytes (≈3.3k tokens)** —
about **8.8× smaller** than the MCP bridge's compact schema set — with no extra process and no MCP
handshake. The command catalog lives on disk (43 commands, generated from the AUV MCP server and
cross-checked against `auv invoke <id> --help`) and is used to build argv locally, while
`auv_help` exposes it to the model on demand. Screenshot artifacts are `.webp` files read through
DSH's own `read_image` tool.

## Troubleshooting

### `AUV was not found` / `AUV_BIN is not an executable file`

The plugin cannot find the external CLI. Install AUV (see [Before you start](#before-you-start)),
confirm `auv --version`, and restart Harness. The error message includes every install command and
the repository link; `auv_doctor` returns the same instructions.

### The plugin is installed but no tool does anything

Check the three prerequisites, in order: AUV installed, **DeepSeek Harness** holding Accessibility
and Screen Recording, Harness restarted after the grant. `auv_doctor` reports exactly what is
missing.

### Daemon / socket errors

The plugin uses the local AUV daemon by default (AUV autostarts it on demand). If the Host cannot
start or reach the daemon, set `AUV_DSH_NO_DAEMON=1` in the environment that launches DeepSeek
Harness and restart the app; each invocation then runs in-process (`auv --no-daemon invoke …`).

### `permission` / `TCC` / `accessibility` errors

Run `auv_doctor`. If `accessibility` or `screen_recording_preflight` is not granted, enable
**DeepSeek Harness** under **System Settings → Privacy & Security** (macOS 27+: the merged
**Device Control and Data Access** pane; older macOS: the **Accessibility** and **Screen Recording**
rows), then restart the app.

### OCR fails with `vision OCR failed …`

That is missing Screen Recording. Grant it, restart Harness, and re-run `auv_doctor`. A stale
permission state that still reports `vision OCR failed: unknownError` means the grant has not taken
effect for the Host process yet; restart and retry. Until OCR is available, use `auv_screenshot`
plus `read_image`, or accessibility-based commands.

### `auv_ocr` with `wait: true` times out

AUV 0.0.43 `display.waitForText` can time out even when `display.findText` finds the same text, and
`window.waitForText` has been observed to hang on some windows. The plugin maps to these commands
one-to-one (the same argv fails from the CLI), so this is an upstream AUV quirk. Prefer `auv_ocr`
without `wait` and retry, keeping `timeout_ms` short.

### The screenshot path is not readable

The plugin returns an absolute path inside `AUV_DSH_STORE_ROOT`. Pass that exact path to the
`read_image` tool; image bytes are never returned by the tool result.

## Development

Source lives in `index.js` + `src/` as plain ESM. The runtime artifact is one self-contained file,
**`dist/index.mjs`**, built with [tsdown](https://tsdown.dev) (Rolldown): the tool definitions, the
generated AUV catalog, and the [es-toolkit](https://es-toolkit.dev) helpers are inlined, while Node
builtins stay external. There are no runtime npm dependencies, and `dist/` is committed so a
directory install does not need a build step.

```sh
pnpm install                        # dev-only tooling (tsdown, es-toolkit)
pnpm build                          # tsdown -> dist/index.mjs (commit the result)
pnpm check                          # offline checks: source, manifest, catalog mirror, bundle
node notes/catalog-selfcheck.mjs    # catalog argv self-check (43 commands)
```

Catalog maintenance after an AUV upgrade:

```sh
node tools/generate-catalog.mjs     # refresh src/catalog.json (MCP + CLI cross-check)
node tools/sync-catalog-data.mjs    # mirror src/catalog.json -> src/catalog-data.mjs (runtime data)
pnpm build                          # rebuild the single-file bundle
```

`src/catalog.json` is generated from `auv mcp serve` and cross-checked against
`auv invoke <id> --help`; `src/catalog.mjs` validates input keys, builds argv, and produces the
`auv_help` text. `src/catalog-data.mjs` is the generated ESM mirror that the bundle inlines.

## Repository layout

```
package.json          bundle manifest (dsh.bundle.patch, exports "." -> dist/index.mjs)
cordis.patch.yml      Loader patch inserting the dsh-auv row
index.js              plugin entry source: inject ['tools'] + apply() registering the eleven tools
src/auv.mjs           binary discovery + install guidance, spawn runner, timeout/abort, receipt errors
src/catalog.json      generated AUV command catalog (43 commands, AUV 0.0.43)
src/catalog-data.mjs  generated ESM mirror of catalog.json, inlined by the bundler
src/catalog.mjs       argv builder, target formatting, catalog help text
src/tools.mjs         the eleven ToolDefinitions
dist/index.mjs        prebuilt single-file runtime bundle (tsdown; commit this)
tsdown.config.mjs     bundler configuration
locale/en.json        plugin title/description (English)
locale/zh.json        plugin title/description (Chinese)
icon.svg              official AUV logo on a white rounded background
tools/                maintainer scripts (offline checks, catalog generator, data mirror)
notes/                design/verification evidence from the integration work
DESIGN.md             the build specification used for this integration
```

The DSH loader imports `dist/index.mjs` through `package.json` `exports["."]`; the static DSH
resources (`cordis.patch.yml`, `locale/`, `icon.svg`) are never bundled.

## Status

Verified end-to-end on macOS 27.2 with AUV 0.0.43 and DeepSeek Harness: all eleven tools through
the live Host process, including real input delivery (`auv_click` → `auv_type` → `auv_keys`
typing and sending a message in the Harness composer), screenshot → `read_image`, OCR, window and
display targeting, and negative/argument cases. Evidence: [`notes/verification-report.md`](notes/verification-report.md).

## Attribution

The plugin icon is the official AUV logo (`docs/assets/logo-light.svg` in the
[AUV repository](https://github.com/moeru-ai/auv)) placed on a white rounded background. AUV and the
AUV logo are © the moeru-ai contributors and licensed under
[Apache-2.0](https://github.com/moeru-ai/auv/blob/main/LICENSE.md). Everything else in this
repository is part of this integration.

## License

[Apache-2.0](LICENSE)
