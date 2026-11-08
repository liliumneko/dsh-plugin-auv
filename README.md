<img src="icon.svg" width="72" alt="AUV desktop automation"/>

# dsh-auv — AUV desktop automation for DeepSeek Harness

**English** | [简体中文](./README.zh.md)

Adds [AUV](https://github.com/moeru-ai/auv) desktop automation to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as native model tools.

Uses [`@auv-js/sdk`](https://www.npmjs.com/package/@auv-js/sdk).

> [!WARNING]
> **Please install AUV before using this plugin.** On macOS, also grant **DeepSeek Harness** the
> required permissions. See [Before you start](#before-you-start).

## Before you start

1. **Install the AUV command line tool and make sure it is on `PATH`.** Check with `auv --version`.

   | Platform | Install |
   | --- | --- |
   | macOS | `brew install moeru-ai/tap/auv` |
   | macOS / Linux | `curl -fsSL https://auv.moeru.ai/install.sh \| sh` |
   | Windows | `scoop bucket add auv https://github.com/moeru-ai/auv` then `scoop install auv/auv` |
   | proto | `proto plugin add auv "https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml" --to global` then `proto install auv latest --config-mode global --pin global` |

   If AUV is not on `PATH`, set `AUV_BIN` to the full path of the `auv` executable before starting
   Harness. A running AUV daemon is enough for the plugin to connect, but starting one itself
   needs the executable.

2. **Install and enable this plugin** (see [Install](#install)), then run `auv_doctor`. A ready
   setup reports `all_ok: true`.

## What is AUV

**AUV** means *Application Use Via ...*. Its authors describe it as programmable computer use — like
Playwright, but for the operating system.

- It is not an agent. It provides a command line tool, a local daemon, a stdio MCP server, typed
  command contracts and TypeScript/Rust SDKs. An agent or app calls it.
- Repeated GUI work becomes reusable commands that record runs and artifacts, instead of a
  screenshot → click → check loop. Once a flow is a command, repeating it costs almost no model
  tokens.
- macOS, Linux and Windows are supported. AUV 0.0.43 has 43 core commands for displays, windows,
  input, accessibility, media and scans.

Links:

- Repository: <https://github.com/moeru-ai/auv>
- Docs and install: <https://auv.moeru.ai>
- Terms and concepts: <https://github.com/moeru-ai/auv/blob/main/docs/TERMS_AND_CONCEPTS.md>
- Supported apps and extensions: <https://github.com/moeru-ai/auv/tree/main/supported>

Sections: [Before you start](#before-you-start) · [Install](#install) · [macOS permissions](#macos-permissions) · [Tools](#tools) · [Configuration](#configuration) · [Daemon](#daemon-lifecycle) · [Why not MCP](#why-not-the-mcp-bridge) · [Troubleshooting](#troubleshooting) · [Development](#development)

## Install

The plugin is prebuilt. The release tarball contains only the files the plugin needs at runtime
(about 330 KB): `dist/index.mjs`, the manifest, the plugin patch, locales and the icon.

Open **Settings → Plugins → Add plugin** and paste the latest release tarball:

```
https://github.com/liliumneko/dsh-plugin-auv/releases/latest/download/dsh-plugin-auv.tgz
```

Click install, then enable **AUV desktop automation**. The nine `auv_*` tools show up on the next
model step. Run `auv_doctor` first.

The same input box also accepts an npm package name or a local directory. The repository itself
does not contain the built bundle, so installing from the repository address does not work; use
the release tarball, or build from a clone for development.

From a session you can use the command form with the same link:

```
plugin_manager action=install_bundle target=https://github.com/liliumneko/dsh-plugin-auv/releases/latest/download/dsh-plugin-auv.tgz
```

To change the code, clone the repository, install and build it, then install the local directory:

```
git clone https://github.com/liliumneko/dsh-plugin-auv.git
cd dsh-plugin-auv
pnpm install
pnpm build
plugin_manager action=install_bundle target=/absolute/path/to/dsh-plugin-auv
```

A local directory install is linked, so rebuild with `pnpm build` and restart Harness after code
changes. Disable the plugin with
`plugin_manager action=set_plugin target=dsh-auv enabled=false`.

## macOS permissions

AUV controls the real desktop, so macOS must trust **DeepSeek Harness**, not just `auv`:

1. Open **System Settings → Privacy & Security**. On macOS 27 and later the permission lists are
   under **Device Control and Data Access**; older versions show **Accessibility** and
   **Screen Recording** separately.
2. Enable **DeepSeek Harness** there. If it is not listed, add
   `/Applications/DeepSeek Harness.app`, or trigger an input command once and allow the prompt.
3. Quit and reopen DeepSeek Harness. Permission changes are only read when the process starts.
4. Run `auv_doctor`. `all_ok` should be `true`; the report shows which permission is missing
   otherwise.

Screenshots and OCR need Screen Recording. Clicking, typing, key presses and scrolling need
Accessibility.

## Tools

All nine tools talk to AUV through the SDK. Every call validates its arguments first, then uses the
daemon connection (see [Daemon lifecycle](#daemon-lifecycle)).

| Tool | What it does |
| --- | --- |
| `auv_doctor` | Reports permissions, daemon state and whether the setup is ready. Returns install and permission guidance when something is missing; it does not throw. |
| `auv_screenshot` | Captures the desktop, a window, an app, a display or a screen region. Returns a `.webp` file path for `read_image`. |
| `auv_ocr` | Finds text on screen or in a window. With `wait: true` it polls until the text appears. |
| `auv_click` | Clicks text found by OCR, or an exact point. Optional button, target and click area. |
| `auv_type` | Types or pastes text into the focused control. |
| `auv_keys` | Presses one key combination, optionally repeated. |
| `auv_scroll` | Scrolls inside a window, using window-local coordinates. |
| `auv_windows` | Lists windows with ids, app ids, titles, frames and state. |
| `auv_activate` | Brings an application to the front. |

Screenshots are saved as `.webp` files. Call DSH's `read_image` tool with the returned path to
look at one; the tool result never contains image bytes.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUV_BIN` | searched in `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin` | Full path to the `auv` executable. Needed only when the plugin has to start its own daemon. Invalid values fail with install instructions. |
| `AUV_DSH_SDK_STORE_ROOT` | `$DSH_HOME/auv/sdk` (usually `~/.dsh/auv/sdk`) | Store directory for the daemon the plugin starts itself. |
| `AUV_DSH_CAPTURE_DIR` | `$DSH_HOME/auv/sdk-captures` (usually `~/.dsh/auv/sdk-captures`) | Where screenshots are written for `read_image`. |

AUV's own `AUV_ENDPOINT` and `AUV_DISCOVERY_FILE` are honored when finding a daemon to connect to.
`DSH_HOME` changes the default data directory above.

## Daemon lifecycle

The plugin does not start a daemon if you already have one.

- **First tool call:** it looks for a running AUV daemon and connects to it (about two seconds at
  most). If none is found, it starts a private `auv serve` process: its own socket, a launcher
  token, no registration in AUV's discovery file, and it exits when Harness exits. Only in this
  case does it need the `auv` executable.
- **Later calls:** reuse the same connection. When the daemon goes away, the next call connects
  again or starts a new one.
- **Unload or reload:** the connection is closed. A daemon started by the plugin is stopped; a
  daemon you started yourself keeps running.
- **Doctor:** tells you whether it is connected to an existing daemon or using one it started, and
  where that daemon listens.

Screenshots use logical resolution (one pixel per screen point) and are capped at 2048×2048. The
SDK does not create AUV runs per call, so tool results have `run_id: null`; that differs from the
old command line based version.

## Examples

```
auv_doctor {}
auv_windows {}
auv_screenshot { "window_id": "<id from auv_windows>" }
# then read_image { "file_path": "<artifact_path>" }
auv_ocr { "text": "Save" }
auv_click { "text": "Save", "application_id": "com.apple.TextEdit" }
auv_type { "text": "hello", "application_id": "com.apple.TextEdit", "mode": "paste" }
auv_keys { "keys": ["cmd", "t"], "repeat": 3, "interval_ms": 120 }
auv_scroll { "window_id": "<id from auv_windows>", "dy": 600 }
```

## Why not the MCP bridge

AUV ships `auv mcp serve`, and `@deepseek-ai/dsh-mcp-client` can connect it with no code. That
connection loads AUV's full MCP schema every request: measured 181,539 bytes pretty / 117,422 bytes
compact on AUV 0.0.43, about 29k tokens, most of it the command list inside the single `invoke`
tool.

This plugin has nine tools whose schemas total 10,645 bytes, about 2.7k tokens — roughly 11 times
smaller — and there is no separate MCP process or handshake. The bundle is about 1.45 MB unpacked
because the SDK and its gRPC client are included; the release tarball is about 330 KB. It is
loaded once and does not add to the model context.

## Troubleshooting

**`AUV was not found` / `AUV_BIN` is not an executable file.** The plugin cannot find the `auv`
executable. Install AUV as described in [Before you start](#before-you-start), check
`auv --version`, and restart Harness. If AUV is outside `PATH`, set `AUV_BIN`.

**The plugin is installed but nothing happens.** Run `auv_doctor`. It reports whether AUV is found,
whether it can connect to a daemon, and which macOS permission is missing.

**Daemon connection errors.** If a daemon is running but the plugin cannot use it, run
`auv_doctor` to see the endpoint and the error. Make sure `AUV_DSH_SDK_STORE_ROOT` is writable when
the plugin has to start its own daemon. The plugin never replaces or stops a daemon you started.

**Permission errors.** Follow [macOS permissions](#macos-permissions), then restart Harness and run
`auv_doctor` again.

**OCR returns `vision OCR failed …`.** Screen Recording is missing or the grant has not taken
effect yet. Grant it, restart Harness and retry. Until then, use `auv_screenshot` plus `read_image`.

**`auv_ocr` with `wait: true` times out.** The SDK version polls `findText` on the client. If the
text is still loading, a shorter `timeout_ms` retry usually works better than a long wait.

**A screenshot path cannot be read.** Pass the exact absolute path to `read_image`. Files older
than seven days are pruned.

## Development

The source is plain ESM in `index.js` and `src/`. The runtime artifact is one file,
`dist/index.mjs`, built with [tsdown](https://tsdown.dev). It includes the nine tool definitions,
the SDK transport and the `es-toolkit` helpers; Node builtins stay external. There are no runtime
npm dependencies. `dist/` is not committed; GitHub Actions builds it and attaches the packed
tarball to each release.

```sh
pnpm install
pnpm build     # write dist/index.mjs
pnpm check     # offline checks: tools, manifest, SDK mapping, attach logic, bundle
```

The bundle is about 1.45 MB unpacked; the release tarball is about 330 KB. Attach behavior and
daemon ownership are covered by the offline checks; they use fake transport dependencies, so no
daemon is needed.

To publish a release, bump `version` in `package.json`, commit, and push a matching tag
(`vX.Y.Z`). GitHub Actions installs dependencies, builds, runs the checks, packs the plugin and
attaches `dsh-plugin-auv-X.Y.Z.tgz` and `dsh-plugin-auv.tgz` to the release.

## Status

Tested on macOS 27.2 with AUV 0.0.43 and DeepSeek Harness. The nine tools were checked with
read-only calls (doctor, windows, screenshot → `read_image`, OCR) in both modes: connecting to a
running daemon, and starting the plugin's own daemon. The daemon was stopped on unload when the
plugin had started it, and left running when it had not. Input tools (click, type, keys, scroll,
activate) were tested by argument validation and earlier CLI-based tests; they were not re-run as
real desktop input in this version.

Historical evidence, including the older CLI implementation and the SDK API research, is in
[`notes/`](notes/).

## Attribution

The plugin icon is the official AUV logo (`docs/assets/logo-light.svg` in the
[AUV repository](https://github.com/moeru-ai/auv)) on a white rounded background. AUV and the AUV
logo are © the moeru-ai contributors and licensed under
[Apache-2.0](https://github.com/moeru-ai/auv/blob/main/LICENSE.md).

## License

[Apache-2.0](LICENSE)
