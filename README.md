<img src="icon.svg" width="72" alt="AUV desktop automation"/>

# dsh-auv — AUV desktop automation for DeepSeek Harness

**English** | [简体中文](./README.zh.md)

Adds [AUV](https://github.com/moeru-ai/auv) desktop automation to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as native model tools.


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

Sections: [Before you start](#before-you-start) · [Install](#install) · [macOS permissions](#macos-permissions) · [Tools](#tools) · [Configuration](#configuration) · [Daemon](#daemon-lifecycle) · [Troubleshooting](#troubleshooting) · [Status](#status)

## Install

The plugin is prebuilt.

Open **Settings → Plugins → Add plugin** and paste the latest release tarball:

```
https://github.com/liliumneko/dsh-plugin-auv/releases/latest/download/dsh-plugin-auv.tgz
```

Click install, then enable **AUV desktop automation**. The twelve `auv_*` tools show up on the next
model step. Run `auv_doctor` first.

The same input box also accepts an npm package name or a local directory. The repository does not
contain the built bundle, so use the release tarball for normal installs. Development builds and
the release process are documented in [docs/implementation.md](https://github.com/liliumneko/dsh-plugin-auv/blob/main/docs/implementation.md).

From a session you can use the command form with the same link:

```
plugin_manager action=install_bundle target=https://github.com/liliumneko/dsh-plugin-auv/releases/latest/download/dsh-plugin-auv.tgz
```

Disable the plugin with
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

All twelve tools control AUV through the daemon connection described in [Daemon lifecycle](#daemon-lifecycle).

| Tool | What it does |
| --- | --- |
| `auv_doctor` | Reports permissions, daemon state and whether the setup is ready. Returns install and permission guidance when something is missing; it does not throw. |
| `auv_screenshot` | Captures the desktop, a window, an app, a display or a screen region. Returns a `.webp` file path for `read_image`, plus capture bounds and pixel metadata. |
| `auv_ocr` | Finds text on screen or in a window. With `wait: true` it polls until the text appears. Matches carry screen, window and image pixel points. |
| `auv_click` | Clicks text found by OCR, or an exact point. Optional button, target, click area and coordinate space (`space: "screen"` is the reliable choice for Unity/Canvas apps). |
| `auv_type` | Types or pastes text into the focused control. |
| `auv_keys` | Presses one key combination, optionally repeated. `policy` and `focus` control delivery. |
| `auv_scroll` | Scrolls inside a window, using window-local coordinates. |
| `auv_drag` | Drags the mouse from one point to another; screen, window or display coordinates, button, duration, and an optional focus-first step. |
| `auv_capture_state` | Captures an in-memory snapshot of a window or region and returns a `state_token`; use it before an action. |
| `auv_wait_for_change` | Watches a window or region and compares frames, returning `changed`, `no_effect` or `timeout` with a `changed_ratio`. Pass a `state_token` from `auv_capture_state` for the reliable check. |
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
| `AUV_DSH_CAPTURE_RETENTION_MS` | `3600000` (one hour) | Delete `.webp` screenshots older than this after each new capture. Set `0` to keep files forever. |
| `AUV_DSH_CAPTURE_MAX_FILES` | `200` | Keep at most this many screenshot files (newest win). Set `0` for no count limit. |

AUV's own `AUV_ENDPOINT` and `AUV_DISCOVERY_FILE` are honored when finding a daemon to connect to.
`DSH_HOME` changes the default data directory above.

## Daemon lifecycle

If an AUV daemon is already running, the plugin connects to it and leaves it alone. Otherwise it
starts a private daemon for this plugin and stops it when Harness unloads or reloads. `auv_doctor`
shows which mode is active and where the daemon listens.

## Coordinates and verifying an input

Points returned by the tools are logical screen points. Inputs accept screen, window or display
coordinates; each tool description says which space applies.

When a result carries a capture, convert between spaces with:

```
image_pixel  = (screen_point - bounds.origin) * pixel_ratio
window_point = screen_point - window.frame.origin
screen_point = window_point + window.frame.origin
```

`image_pixel` belongs to the capture that produced the value, not necessarily to a screenshot you
took earlier; `pixel_ratio` is `pixel_size.width / bounds.width`. Screenshot values include
`bounds`, `origin`, `scale_factor`, `pixel_size` and `coordinate_note`; OCR matches include
`screen_point`, `image_pixel`, `window_point` and `pixel_ratio` next to `bounds`.

Input tools return delivery evidence, not proof that the app reacted. To verify an input:

1. Call `auv_capture_state` on the target window or region before the action.
2. Do the action (`auv_click`, `auv_drag`, `auv_type`, `auv_keys`, `auv_scroll`).
3. Call `auv_wait_for_change` with the returned `state_token`. It compares downscaled RGBA frames
   and returns `changed_ratio`; `min_changed_ratio` and `pixel_threshold` filter cursor or button
   flicker.

`baseline_hash` is still accepted for a coarse ThumbHash-only check, but `state_token` is the
reliable path. The default `min_changed_ratio` of 0.01 ignores cursor and button flicker; for a
small change (a log line, a checkbox) capture just that region, or lower `min_changed_ratio`
(for example 0.0005). `changed: false` only means the screen did not change enough; it is not
proof that keys were delivered. The plugin also stops the third identical mutating call within 30 seconds
with `no_effect_repeat`; pass `allow_repeat: true` to send it anyway after re-checking the screen.

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
auv_drag { "from": { "x": 300, "y": 500 }, "to": { "x": 600, "y": 500 }, "duration_ms": 400 }
auv_capture_state { "window_id": "<id from auv_windows>" }        # → state_token
auv_drag { "from": { "x": 300, "y": 500 }, "to": { "x": 600, "y": 500 } }
auv_wait_for_change { "state_token": "<state_token>", "timeout_ms": 3000 }
```

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

**`auv_ocr` with `wait: true` times out.** If the text is still loading, retry with a shorter
`timeout_ms` instead of one long wait.

**A screenshot path cannot be read.** Pass the exact absolute path to `read_image`. Capture files
are temporary: after every new screenshot, files older than `AUV_DSH_CAPTURE_RETENTION_MS` (one
hour by default) or beyond `AUV_DSH_CAPTURE_MAX_FILES` (200) are deleted. Increase either value if
you need screenshots to survive a longer session.

**Keys do not reach a Unity/Canvas game (Space, Return).** AUV key injection can report
`completed` while the game ignores the event; this has been observed with Stacklands. Use screen
clicks or OCR-driven clicks instead, and treat `changed: false` as "the screen did not change", not
as proof that the key was not delivered. This is an upstream AUV driver limitation.

## Status

Tested on macOS 27.2 with AUV 0.0.43 and DeepSeek Harness. Drag, screen-coordinate clicks and
change detection work on a real Stacklands session. AUV key injection does not reach that Unity
game; this is an upstream driver limitation. Build, release, design and verification details are in
[docs/implementation.md](https://github.com/liliumneko/dsh-plugin-auv/blob/main/docs/implementation.md).

## Attribution

The plugin icon is the official AUV logo (`docs/assets/logo-light.svg` in the
[AUV repository](https://github.com/moeru-ai/auv)) on a white rounded background. AUV and the AUV
logo are © the moeru-ai contributors and licensed under
[Apache-2.0](https://github.com/moeru-ai/auv/blob/main/LICENSE.md).

## License

[Apache-2.0](LICENSE)
