# Implementation notes

This document covers how the plugin is built and how it works. User-facing setup and tool usage live
in [README.md](../README.md) and [README.zh.md](../README.zh.md).

## Layout

| Path | Purpose |
| --- | --- |
| `index.js` | DSH plugin entry. Injects `tools`, registers the `auv_*` tool definitions and wires SDK disposal. |
| `src/tools.mjs` | Model-facing tool definitions and argument validation. |
| `src/transport/sdk.mjs` | `@auv-js/sdk` transport: attach/start daemon, typed operations, capture files and capture-scoped state. |
| `src/transport/sdk-format.mjs` | Pure planners/mappers: argument parsing, coordinates, pixel comparison, repeat guard. |
| `src/auv.mjs` | AUV binary lookup, error types, permission hints. No CLI invocation. |
| `tools/check-tools.mjs` | Offline self-check (`node tools/check-tools.mjs`, no daemon needed). |
| `dist/index.mjs` | Built bundle. Not committed; built by `pnpm build` and by GitHub Actions. |
| `notes/` | Historical SDK/API research and per-feature verification logs. |

The runtime artifact is one ESM bundle built with [tsdown](https://tsdown.dev). It includes the SDK
transport, tool definitions and `es-toolkit` helpers; Node builtins stay external. There are no
runtime npm dependencies.

## Daemon lifecycle

The transport is a `globalThis` singleton so a plugin reload can reuse the connection instead of
leaking daemons.

1. On the first tool call it tries `connect({ discover: true })` for about two seconds.
2. If no discoverable daemon exists, it starts a private daemon with `startAuv()`: private socket,
   launcher token, no discovery registration, and it exits when the plugin/Harness exits. Only this
   path needs the `auv` executable.
3. Later calls reuse the connection. A transport failure forgets the client so the next call can
   re-attach or start again.
4. On unload it closes the connection. A daemon started by the plugin is stopped; a daemon the user
   started is left running.
5. `auv_doctor` calls `runner.macos.permissions.probe()` and `health.check()` and reports the
   attached/owned mode, endpoint and daemon id.

There is no `auv` CLI process for tool calls, so tool results have `run_id: null`.

## Capture pipeline and files

- Captures use `CaptureResolution.LOGICAL` (one pixel per logical point).
- Images are encoded as WEBP, capped at 2048×2048, written to `$AUV_DSH_CAPTURE_DIR`
  (default `$DSH_HOME/auv/sdk-captures`). The file path is returned for DSH's `read_image`.
- Capture files are temporary. After every new capture the plugin deletes `.webp` files older than
  `AUV_DSH_CAPTURE_RETENTION_MS` (default one hour) and anything beyond the newest
  `AUV_DSH_CAPTURE_MAX_FILES` (default 200). The same cleanup runs when the transport starts.
- `auv_capture_state` keeps a downscaled RGBA copy (320 px max) in memory, in a 20-entry LRU with a
  five-minute TTL. It never writes to disk. The state token is used by `auv_wait_for_change` to
  compare pixels and report `changed_ratio`.

## Input, verification and known limits

- Mutating tools (`auv_click`, `auv_type`, `auv_keys`, `auv_scroll`, `auv_drag`) share a repeat
  guard: the third identical call within 30 seconds returns `no_effect_repeat` unless
  `allow_repeat: true` is set.
- Input results are delivery evidence, not proof of an effect. The intended flow is
  `auv_capture_state` → action → `auv_wait_for_change({ state_token })`.
- `auv_wait_for_change` compares downscaled RGBA frames. `pixel_threshold` (default 24) ignores
  per-channel noise; `min_changed_ratio` (default 0.01) ignores cursor/button flicker. For very
  small UI changes capture the affected region or lower `min_changed_ratio`.
- `auv_keys` with a target and `foreground-preferred` focuses the target and sends a real foreground
  key event instead of a window-targeted event. On some Unity/Canvas games (confirmed with
  Stacklands) AUV key injection is still ignored; external CGEvent injection works, so this is an
  AUV driver limitation, not a plugin parameter.
- Window-targeted clicks are unreliable in Unity/Canvas apps. `auv_click` accepts
  `space: "screen"`; screen-coordinate clicks were verified in Stacklands.
- Template matching and colour recognition are not implemented. They are not part of the SDK.
- `auv_drag` builds the same straight-line cubic Bézier path as the AUV CLI
  (`curve.start`, one segment, `mapping {1,1}`, 60 Hz, 0.5 point tolerance). Omitting
  `curve.start`/`mapping` is rejected by the Runner.

## SDK coverage

The current surface is 12 tools:

`auv_doctor`, `auv_screenshot`, `auv_ocr`, `auv_click`, `auv_type`, `auv_keys`, `auv_scroll`,
`auv_drag`, `auv_capture_state`, `auv_wait_for_change`, `auv_windows`, `auv_activate`.

The SDK exposes more that is not wrapped yet (double-click/modifier clicks, type submit, held keys,
scroll-until, smooth/live scroll, window focus/frame/state, display list, full-image OCR via
`recognizeText`, overlays, macOS media). `notes/sdk-api-map.md` has the full mapping of AUV commands
to SDK calls.

Tool schema size on 0.1.2: 12 tools, 21,603 bytes (~5.4k tokens). The AUV MCP bridge schema was
measured at 181,539 bytes pretty / 117,422 bytes compact (~29k tokens) on AUV 0.0.43, so the typed
tool surface is about 5.4 times smaller and needs no MCP process or handshake.

## Build, check and release

```sh
pnpm install
pnpm build     # write dist/index.mjs
pnpm check     # 19 offline checks; uses fake transport dependencies, no daemon needed
```

Bundle sizes on 0.1.2: about 1.51 MB raw / 322 KB gzip; release tarball about 340 KB.

The release tarball contains only runtime files: `dist/index.mjs`, `package.json`,
`cordis.patch.yml`, `locale/`, `icon.svg`, `README*.md`, `LICENSE`. `dist/` is gitignored and built
by CI.

To release: bump `version` in `package.json`, commit, and push a matching tag (`vX.Y.Z`).
`.github/workflows/release.yml` installs dependencies, builds, runs checks, packs the plugin and
uploads `dsh-plugin-auv-X.Y.Z.tgz` and `dsh-plugin-auv.tgz` to the release.

For local development:

```sh
git clone https://github.com/liliumneko/dsh-plugin-auv.git
cd dsh-plugin-auv
pnpm install
pnpm build
plugin_manager action=install_bundle target=/absolute/path/to/dsh-plugin-auv
```

A local directory install is linked. Rebuild with `pnpm build` and restart Harness after code
changes. A package install needs a restart to load a fresh JavaScript module generation; replacing
files at the same path can stay cached.

## Verification

- Read-only calls in both daemon modes: `auv_doctor`, `auv_windows`, screenshot → `read_image`,
  OCR, capture-state and wait-for-change timeout.
- Stacklands: `auv_drag` moved a card onto a bush (task started, berries produced);
  `auv_capture_state` + `auv_wait_for_change` with `state_token` reported
  `changed_ratio ≈ 0.036` / `0.050` above the 0.01/0.02 thresholds, while a static cutscene frame
  stayed at `changed_ratio = 0` and returned `timeout`. Screen-coordinate clicks worked for menu,
  confirmation, start and booster-pack interactions.
- Keyboard test page: `auv_keys` sent `a` and `b`; the page logged `KeyDown`/`KeyUp`, highlighted
  the key and raised APM. A whole-window wait missed the change at the default 1% threshold
  (`changed_ratio ≈ 0.0015`), the same action measured on the log region returned `changed`
  (`changed_ratio ≈ 0.027`, threshold 0.0005).
- Offline self-check: 19 checks, including drag request serialization through the real SDK with a
  mock transport, pixel diff/store/TTL, click spaces, capture cleanup and the repeat guard.

Detailed per-feature logs: `notes/feature-verification.md`, `notes/fix-round2.md`.
Historical SDK research: `notes/sdk-api-map.md`, `notes/sdk-transport.md`, `notes/auv-cli-contract.md`.
