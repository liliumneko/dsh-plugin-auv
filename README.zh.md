<p align="right"><img src="icon.svg" width="72" alt="AUV 桌面自动化"></p>

# dsh-auv — DeepSeek Harness 的 AUV 桌面自动化插件

[English](./README.md) | **简体中文**

把 [AUV](https://github.com/moeru-ai/auv) 的操作系统自动化能力接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 11 个原生模型工具：截图、Vision OCR、点击、输入、按键、滚动、窗口列表、应用激活、通用命令入口、就绪检查与命令帮助。8 个 typed 工具有两条传输通道：默认走 AUV 官方 [`@auv-js/sdk`](https://www.npmjs.com/package/@auv-js/sdk)（插件自己启动一个 AUV daemon），并保留 `auv invoke` CLI 作为 fallback。

> [!WARNING]
> **只安装这个插件是没用的。** 它只是 DSH ↔ AUV 的桥；真正干活的是外部的 **AUV CLI**，而且必须把 macOS 权限授予 **DeepSeek Harness**。请先完成[前置工作](#前置工作)，否则工具虽然会出现，但每次调用只会返回安装/授权指引（`auv_doctor` 会告诉你缺什么）。

## 前置工作

三件事缺一不可，这也是“插件装了但没反应”的最常见原因：

1. **安装 AUV CLI 并确保在 `PATH` 里**，用 `auv --version` 确认。

   | 平台 | 安装方式 |
   | --- | --- |
   | macOS | `brew install moeru-ai/tap/auv` |
   | macOS / Linux | `curl -fsSL https://auv.moeru.ai/install.sh \| sh` |
   | Windows | `scoop bucket add auv https://github.com/moeru-ai/auv` 然后 `scoop install auv/auv` |
   | proto | `proto plugin add auv "https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml" --to global` 然后 `proto install auv latest --config-mode global --pin global` |

   如果 AUV 不在 `PATH`，启动 Harness 前把 `AUV_BIN` 设为 auv 可执行文件的绝对路径。

2. **把 macOS 权限授予 DeepSeek Harness**（不是授予 `auv`，也不是授予终端）：
   - **辅助功能（Accessibility）**：点击、输入、按键、滚动、激活应用。
   - **屏幕录制（Screen Recording）**：截图与 OCR。
   - macOS 27+ 已把这些权限合并到 **系统设置 → 隐私与安全性 → 设备控制与数据访问**；旧版 macOS 是分开的「辅助功能」「屏幕录制」两行。在其中启用 `DeepSeek Harness.app`（没有就用 `+` 添加）。
   - **完全退出并重新打开 DeepSeek Harness**：权限只在进程启动时读取。

3. **安装并启用本插件**（见[安装](#安装)），然后运行 `auv_doctor`；就绪时应为 `all_ok: true`。

## AUV 是什么

**AUV** = *Application Use Via ...*，定位是「可编程的 computer use，更像操作系统版的 Playwright」。

- 它**不是 Agent**：提供 CLI、stdio MCP server、本地 daemon、类型化命令契约（Protobuf/gRPC）以及 TypeScript/Rust SDK，由 Agent 来调用。
- 把重复的 GUI 操作沉淀成**可复用、可检查的命令**（`auv invoke <command-id>`），记录 Run 与 artifact，避免“截图→点击→验证”的 token 消耗循环；流程定型后重复执行几乎不消耗推理 token。
- 支持 macOS / Linux / Windows；AUV 0.0.43 提供 43 个核心命令，覆盖 display、window、input、accessibility、media、scan。

导航：[前置工作](#前置工作) · [安装](#安装) · [macOS 权限](#macos-权限) · [工具](#工具) · [配置](#配置) · [排障](#排障) · [为什么不用 MCP](#为什么不用-mcp-桥) · [开发](#开发)

AUV 相关链接：

- 仓库：<https://github.com/moeru-ai/auv>
- 文档 / 安装：<https://auv.moeru.ai>
- 术语与概念：<https://github.com/moeru-ai/auv/blob/main/docs/TERMS_AND_CONCEPTS.md>
- 支持的应用与扩展：<https://github.com/moeru-ai/auv/tree/main/supported>

## 安装

本仓库本身就是插件包目录。运行时产物是已构建好的单文件 `dist/index.mjs`（用 [tsdown](https://tsdown.dev) 打包，无运行时 npm 依赖），已提交到仓库，clone 后安装无需构建。

```sh
git clone https://github.com/liliumneko/dsh-plugin-auv.git
```

然后在 DSH 会话中安装到当前 profile（把路径换成你的 clone 路径）：

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-auv
```

或在 **设置 → 插件 → 添加插件 → 从目录安装**，然后启用「AUV 桌面自动化」这一项。安装后 11 个 `auv_*` 工具在下一步模型调用时出现；建议先跑 `auv_doctor`。

插件以本地链接目录方式安装：`git pull` 后重启 Harness 即生效。禁用：`plugin_manager action=set_plugin target=dsh-auv enabled=false`。

## macOS 权限

1. 打开 **系统设置 → 隐私与安全性**；macOS 27+ 进入 **设备控制与数据访问**，旧版 macOS 分别进入**辅助功能**与**屏幕录制**。
2. 启用 **DeepSeek Harness**（macOS 27+ 列表里每个 App 一个开关；找不到就点 `+` 选 `/Applications/DeepSeek Harness.app`，或先触发一次输入命令并在弹窗中允许）。
3. **退出并重新启动 DeepSeek Harness**。
4. 运行 `auv_doctor` 确认 `all_ok: true`，或运行 `auv_invoke permission.probe` 确认 `accessibility` / `screen_recording` 均为 `granted`。

## 工具

| 工具 | 作用 | 对应 AUV 命令 |
| --- | --- | --- |
| `auv_doctor` | 权限/就绪诊断；AUV 未安装时返回安装命令 | `auv doctor --json` |
| `auv_screenshot` | 截全屏/窗口/应用/显示器/区域，返回 `artifact_path` 供 `read_image` 查看 | `display.capture` 等 |
| `auv_ocr` | OCR 找文字；`wait: true` 可轮询等待 | `display.findText` 等 |
| `auv_click` | 点击 OCR 文字或坐标（可带按钮/围栏/目标） | `display.clickText` / `input.clickPoint` |
| `auv_type` | 输入或粘贴文本 | `input.typeText` / `input.pasteText` |
| `auv_keys` | 按一个组合键（可重复） | `input.pressKeys` |
| `auv_scroll` | 在窗口内滚动（Linux/Windows 才支持屏幕点滚动） | `window.scroll` / `input.scrollPoint` |
| `auv_windows` | 列出窗口 id、应用 id、标题、位置、状态 | `window.list` |
| `auv_activate` | 把应用带到前台 | `application.activate` |
| `auv_invoke` | 任意 AUV 命令的通用入口 | 任意 |
| `auv_help` | 列出全部命令或某命令的参数/示例 | 无（仅本地目录） |

`auv_screenshot` 的 `.webp` 结果需要再调用 DSH 的 `read_image` 查看图像；工具本身不返回图片字节。

## 配置

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `AUV_DSH_TRANSPORT` | `auto` | 传输选择：`auto`（优先 SDK，daemon 启动失败则永久回退 CLI）、`sdk`（强制 SDK，失败即报错）、`cli`（完全不启动 SDK daemon） |
| `AUV_DSH_SDK_STORE_ROOT` | `$DSH_HOME/auv/sdk`（通常 `~/.dsh/auv/sdk`） | 插件自有 SDK daemon 的 store 根与 socket 状态 |
| `AUV_DSH_CAPTURE_DIR` | `$DSH_HOME/auv/sdk-captures`（通常 `~/.dsh/auv/sdk-captures`） | SDK 模式截图 `.webp` 的落盘目录，供 `read_image` 使用 |
| `AUV_BIN` | 依次从 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin` 查找 | `auv` 可执行文件绝对路径；无效时会直接报错并附安装指引 |
| `AUV_DSH_STORE_ROOT` | `$DSH_HOME/auv/runs`（通常 `~/.dsh/auv/runs`） | CLI 路径的 `--store-root`，保证 run 收据与 artifact 路径稳定 |
| `AUV_DSH_NO_DAEMON` | 未设置（使用本地 daemon） | CLI 路径每次调用加 `--no-daemon`（SDK 传输忽略此项） |
| `AUV_DSH_OVERLAY` | 未设置（默认关闭 overlay） | 设为 `1` 保留 AUV 可视化 overlay |

## 传输与 daemon 生命周期

插件有两条可互换的传输通道：

- **SDK（默认 `AUV_DSH_TRANSPORT=auto`）**：第一次 typed 工具调用时通过 `@auv-js/sdk` 懒启动一个
  **插件自有的 `auv serve` daemon**，然后用 typed gRPC 客户端调用。daemon 使用 `TMPDIR` 下的私有 unix
  socket、launcher-token 鉴权、`--no-register`（不会占用/替换用户自己的 `auv serve`），并带
  `--exit-on-stdin-close`（Harness 退出即退出）。插件卸载/重载时通过 `ctx.effect` 停止它，
  `globalThis` 单例避免重载泄漏。首次调用含 daemon 启动与 Runner 懒创建（约 1–5 秒），之后很快。
- **CLI（`AUV_DSH_TRANSPORT=cli` 或自动回退）**：历史上每次调用一个 `auv invoke` 子进程，行为、
  artifact 与 Run 记录语义保持不变。

`auto`（默认）在 SDK daemon 启动失败时打印**一次**警告，然后在当前进程内永久回退 CLI；`sdk` 模式则
直接暴露启动错误，便于排查。

`auv_doctor`、`auv_invoke`、`auv_help` 仍走 CLI/catalog（SDK 没有 doctor 报告，也不接受 CLI argv）。
SDK 模式下 `auv_doctor`/`auv_invoke` 会通过 `AUV_ENDPOINT` + `--credential-stdin` 复用已运行的 owned
daemon；`auv_doctor` 不会主动拉起 daemon。

| 方面 | SDK 传输 | CLI 传输 |
| --- | --- | --- |
| 截图 | `CaptureResolution.LOGICAL`（1 px/point），限制 2048²，插件写 `.webp` 到 `AUV_DSH_CAPTURE_DIR` | AUV 原生截图（Retina 上 2×），由 AUV 持久化到 `AUV_DSH_STORE_ROOT` |
| 工具结果里的 `run_id` | `null`（v1 不为每次调用创建 Run/trace） | AUV Run id + run/artifact 记录 |
| `window_id` 定位 | 精确 `WindowClient` 绑定（capture/findText/click/type/keys/scroll） | CLI 的 `window.capture`/`findText`/`clickText` 需要 `app:` + `--title`，插件先解析窗口 |
| `auv_ocr wait: true` | 客户端轮询 `findText`（每次新截图） | `display.waitForText`/`window.waitForText` |

## 示例

```
auv_doctor {}
auv_windows {}
auv_screenshot { "window_id": "<auv_windows 里的 id>" }   # 然后用 read_image 打开返回路径
auv_ocr { "text": "保存" }
auv_click { "text": "保存", "application_id": "com.apple.TextEdit" }
auv_type { "text": "hello", "mode": "paste" }
auv_keys { "keys": ["cmd", "t"], "repeat": 3, "interval_ms": 120 }
auv_scroll { "window_id": "<id>", "dy": 600 }
auv_invoke { "command_id": "display.list" }
auv_help { "command_id": "display.findText" }
```

## 为什么不用 MCP 桥

AUV 自带 `auv mcp serve`，用 `@deepseek-ai/dsh-mcp-client` 零代码就能接。但该路线会把 AUV 完整 MCP schema 每轮都塞进上下文：实测 AUV 0.0.43 为 181,539 B（compact 117,422 B，约 29k tokens），其中 74 KB 是单个 `invoke` 工具里内嵌的命令目录。

本插件 11 个工具的 schema 合计 **13,392 B（约 3.3k tokens）**，比 MCP 桥 compact 约小 **8.8 倍**，且无额外进程/握手。命令目录放在本地（43 条，由 AUV MCP 生成并与 `auv invoke <id> --help` 交叉校验），由 `auv_help` 按需展示；截图 artifact 交给 DSH 原生 `read_image`。

## 排障

- **SDK daemon 启动失败**：`auto` 模式会打印一次警告并永久回退 CLI，工具仍可用；可设
  `AUV_DSH_TRANSPORT=cli` 完全跳过 SDK 启动，或设 `sdk` 暴露启动错误。确认
  `AUV_DSH_SDK_STORE_ROOT` 可写。owned daemon 使用 `--no-register`，不会和用户自己的 AUV daemon 冲突。

- **`AUV was not found`**：AUV 没装或不在 `PATH`。错误信息里有完整安装命令和仓库链接；装好后重启 Harness，再跑 `auv_doctor`。
- **插件装了但没反应**：按顺序检查三项前置（AUV 已装、DeepSeek Harness 已获辅助功能与屏幕录制、授权后已重启），`auv_doctor` 会指出缺失项。
- **daemon / socket 错误**：默认使用本地 daemon；如果 Host 连不上，设置 `AUV_DSH_NO_DAEMON=1` 后重启 Harness。
- **OCR 报 `vision OCR failed …`**：缺屏幕录制；授权并重启后重试。若权限显示已给仍报错，通常是进程还是旧权限状态，重启即可。
- **`wait: true` 超时**：AUV 0.0.43 的 `display.waitForText` / `window.waitForText` 有已知上游问题（CLI 同样复现），建议先用不带 `wait` 的 `auv_ocr` 重试。
- **截图路径读不到**：把返回的绝对路径原样传给 `read_image`。

## 开发

源码是 `index.js` + `src/` 的纯 ESM；运行时产物是**单个自包含文件 `dist/index.mjs`**，由
[tsdown](https://tsdown.dev)（Rolldown）打包：11 个工具定义、AUV 命令目录和 es-toolkit 辅助函数全部内联，
Node 内建模块保持 external；SDK 及其 gRPC/protobuf 客户端也内联。无运行时 npm 依赖，bundle 约
1.58 MB raw / 338 KB gzip，`dist/` 已提交，目录安装无需构建。

```sh
pnpm install                        # 仅维护者：安装 tsdown / es-toolkit
pnpm build                          # tsdown -> dist/index.mjs（记得提交产物）
pnpm check                          # 离线自检：源码、manifest、目录镜像、bundle
node notes/catalog-selfcheck.mjs    # 命令目录 argv 自检（43 条）
```

AUV 升级后刷新目录：

```sh
node tools/generate-catalog.mjs     # 重新生成 src/catalog.json（MCP + CLI 交叉校验）
node tools/sync-catalog-data.mjs    # 镜像为 src/catalog-data.mjs（运行时内联的数据模块）
pnpm build                          # 重新打包单文件
```

## 状态

已在 macOS 27.2 + AUV 0.0.43 + DeepSeek Harness 上完成端到端验证：11 个工具、真实输入投递（`auv_click → auv_type → auv_keys` 在 Harness 输入框里打字并发送消息）、截图→`read_image`、OCR、窗口/显示器定位与负向用例。SDK 传输也在真实 DSH Host 内验证：插件自有 daemon 以 `--no-register` 启动，typed `window.list`/`capture`/`recognizeText` 正常，截图写入 `~/.dsh/auv/sdk-captures` 并可被 `read_image` 显示，`auv_invoke` 能复用 owned daemon，进程列表中可见 `auv serve … --local-socket … --no-register`。证据见 [`notes/verification-report.md`](notes/verification-report.md)、[`notes/sdk-transport.md`](notes/sdk-transport.md)、[`notes/sdk-api-map.md`](notes/sdk-api-map.md)。

## 版权与许可

插件图标使用 AUV 官方 logo（AUV 仓库 `docs/assets/logo-light.svg`）加白色圆角背景；AUV 及其 logo © moeru-ai contributors，Apache-2.0 许可。其余内容为本集成项目的一部分，采用 [Apache-2.0](LICENSE) 许可。
