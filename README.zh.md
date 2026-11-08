<img src="icon.svg" width="72" alt="AUV 桌面自动化"/>

# dsh-auv — DeepSeek Harness 的 AUV 桌面自动化插件

[English](./README.md) | **简体中文**

将 [AUV](https://github.com/moeru-ai/auv) 的操作系统自动化能力集成到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的原生模型工具。

插件使用 AUV 官方 [`@auv-js/sdk`](https://www.npmjs.com/package/@auv-js/sdk)：优先连接你已经在运行的 AUV daemon；没有可连接的就自己启动一个私有 daemon。插件不调用 `auv` 命令行。

> [!WARNING]
> **务必在此之前安装AUV** 系统若为 macOS 则须授予 **DeepSeek Harness** 权限 。安装与配置参考[前置工作](#前置工作)。

## 前置工作

1. **安装 AUV CLI 并确保在 `PATH` 里**，用 `auv --version` 确认。

   | 平台 | 安装方式 |
   | --- | --- |
   | macOS | `brew install moeru-ai/tap/auv` |
   | macOS / Linux | `curl -fsSL https://auv.moeru.ai/install.sh \| sh` |
   | Windows | `scoop bucket add auv https://github.com/moeru-ai/auv` 然后 `scoop install auv/auv` |
   | proto | `proto plugin add auv "https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml" --to global` 然后 `proto install auv latest --config-mode global --pin global` |

   若 AUV 不在 `PATH`，则启动 Harness 前需将 `AUV_BIN` 设为 auv 可执行文件的绝对路径。

2. **安装并启用本插件**（见[安装](#安装)），然后运行 `auv_doctor`；就绪时应为 `all_ok: true`。

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

插件已经构建好，运行时产物就是仓库里的单文件 `dist/index.mjs`，没有运行时 npm 依赖，不需要 clone 或 build。

在 **设置 → 插件 → 添加插件** 的输入框里填这个仓库地址：

```
https://github.com/liliumneko/dsh-plugin-auv
```

点安装，然后启用「AUV 桌面自动化」。安装后 9 个 `auv_*` 工具会在下一步模型调用时出现；建议先跑 `auv_doctor`。

这个对话框也接受 npm 包名和本地目录，这里填 GitHub 仓库地址即可。从 GitHub 拉取慢的话，可以在对话框里换安装源。

在会话里也可以用命令，`target` 填同一个地址：

```
plugin_manager action=install_bundle target=https://github.com/liliumneko/dsh-plugin-auv
```

要改代码时才需要 clone：

```sh
git clone https://github.com/liliumneko/dsh-plugin-auv.git
plugin_manager action=install_bundle target=/absolute/path/to/dsh-plugin-auv
```

本地目录是链接安装，改完源码执行 `pnpm build`、重启 Harness 后生效。禁用：
`plugin_manager action=set_plugin target=dsh-auv enabled=false`。

## macOS 权限

1. 打开 **系统设置 → 隐私与安全性**；macOS 27+ 进入 **设备控制与数据访问**，旧版 macOS 分别进入**辅助功能**与**屏幕录制**。
2. 启用 **DeepSeek Harness**（列表若无则按 `+` 添加 `/Applications/DeepSeek Harness.app`，或先触发一次输入命令并在弹窗中允许）。
3. **退出并重新启动 DeepSeek Harness**。
4. 运行 `auv_doctor` 确认 `all_ok: true`；报告会列出缺失的权限。

## 工具

| 工具 | 作用 |
| --- | --- | --- |
| `auv_doctor` | 权限、daemon 状态与整体就绪情况的诊断；缺东西时给出安装/授权提示，不抛错 |
| `auv_screenshot` | 截全屏、窗口、应用、显示器或屏幕区域，返回 `.webp` 路径供 `read_image` 查看 |
| `auv_ocr` | 在屏幕或窗口里找文字；`wait: true` 会轮询等待 |
| `auv_click` | 点击 OCR 找到的文字，或点击指定坐标；可指定鼠标键、目标和点击区域 |
| `auv_type` | 向当前焦点控件输入或粘贴文字 |
| `auv_keys` | 按一个组合键，可重复 |
| `auv_scroll` | 在窗口内滚动，按窗口内坐标 |
| `auv_windows` | 列出窗口的 id、应用 id、标题、位置和状态 |
| `auv_activate` | 把应用带到前台 |

`auv_screenshot` 的 `.webp` 结果需要再调用 DSH 的 `read_image` 查看图像；工具本身不返回图片字节。

## 配置

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `AUV_BIN` | 依次从 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin` 查找 | `auv` 可执行文件绝对路径；只有插件需要自己启动 daemon 时用得到。无效时会报错并附安装指引 |
| `AUV_DSH_SDK_STORE_ROOT` | `$DSH_HOME/auv/sdk`（通常 `~/.dsh/auv/sdk`） | 插件自己启动的 daemon 的 store 目录 |
| `AUV_DSH_CAPTURE_DIR` | `$DSH_HOME/auv/sdk-captures`（通常 `~/.dsh/auv/sdk-captures`） | 截图 `.webp` 的保存目录，供 `read_image` 使用 |

查找可连接的 daemon 时会遵循 AUV 自己的 `AUV_ENDPOINT` / `AUV_DISCOVERY_FILE`；`DSH_HOME` 可以改上面的默认数据目录。

## daemon 连接方式

插件不会主动替换你已经启动的 daemon。

- **第一次调用**：先找正在运行的 AUV daemon 并连上去（最多约 2 秒）。找不到时，才自己启动一个私有 `auv serve`：使用自己的 socket 和 launcher token，不写 AUV 的发现文件，Harness 退出时它也跟着退出。只有这种情况才需要 `auv` 可执行文件。
- **后续调用**：复用同一个连接。daemon 不在了，下次调用会重新连接或重新启动。
- **卸载或重载插件**：关闭连接。插件自己启动的 daemon 会被停止；你自己启动的 daemon 不受影响。
- **`auv_doctor`**：会说明当前是连接了已有 daemon，还是用插件自己启动的 daemon，以及它监听的地址。

截图使用逻辑分辨率（1 像素/屏幕点），最大 2048×2048。SDK 不会为每次调用创建 AUV run，所以工具结果里的 `run_id` 是 `null`，这一点和旧版命令行实现不同。

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
```

## 为什么不用 MCP 桥

AUV 自带 `auv mcp serve`，用 `@deepseek-ai/dsh-mcp-client` 零代码就能接。但这条路线每轮都会把 AUV 完整的 MCP schema 放进上下文：实测 AUV 0.0.43 是 181,539 B（compact 117,422 B，约 29k tokens），其中大部分是单个 `invoke` 工具里内嵌的命令列表。

本插件 9 个工具的 schema 合计 **10,645 B（约 2.7k tokens）**，比 MCP 桥的 compact 版本小约 **11 倍**，而且没有额外的 MCP 进程和握手。完整 bundle 在磁盘上是 1.45 MB（315 kB gzip），因为带上了 SDK 和 gRPC 客户端；它只加载一次，不占模型上下文。

## 排障

- **`AUV was not found`**：AUV 没装或不在 `PATH`。错误信息里有安装命令和仓库链接；装好后重启 Harness，再跑 `auv_doctor`。已有 daemon 在跑时，插件不装 AUV 也能连上。
- **插件装了但没反应**：先跑 `auv_doctor`。它会说明 AUV 是否找到、能不能连上 daemon、缺哪个 macOS 权限。
- **连不上 daemon**：看 `auv_doctor` 里的 endpoint 和错误。插件需要在没有可连接 daemon 时自己启动一个的话，确认 `AUV_DSH_SDK_STORE_ROOT` 可写。插件不会替换或停止你自己启动的 daemon。
- **权限错误**：按 [macOS 权限](#macos-权限) 授权，重启 Harness 后再跑 `auv_doctor`。
- **OCR 报 `vision OCR failed …`**：缺屏幕录制，或授权还没生效；授权并重启后重试。这期间可以先用 `auv_screenshot` + `read_image`。
- **`wait: true` 超时**：SDK 版本是在客户端反复调用 `findText`。文字还在加载时，用更短的 `timeout_ms` 重试比长时间等待更有效。
- **截图路径读不到**：把返回的绝对路径原样传给 `read_image`。超过 7 天的截图会被清理。

## 开发

源码是 `index.js` + `src/` 的纯 ESM。运行时产物是单个文件 `dist/index.mjs`，用
[tsdown](https://tsdown.dev) 打包：9 个工具、SDK 连接和 es-toolkit 辅助函数都在里面，Node 内建模块保持
external。没有运行时 npm 依赖，`dist/` 已提交，目录安装不用构建。

```sh
pnpm install
pnpm build     # 生成 dist/index.mjs
pnpm check     # 离线自检：工具、manifest、SDK 参数映射、daemon 连接逻辑、bundle
```

当前 bundle 是 1,445,677 字节（315,032 字节 gzip）。daemon 的连接与归属逻辑由离线自检覆盖，用的是假的
transport 依赖，不需要真的起 daemon。

## 状态

已在 macOS 27.2 + AUV 0.0.43 + DeepSeek Harness 上验证。9 个工具用只读调用测过（doctor、windows、截图 → `read_image`、OCR），两种模式都跑过：连接已有 daemon，以及插件自己启动 daemon。插件自己启动的 daemon 在卸载时会停止；不是自己启动的保持运行。点击、输入、按键、滚动、激活这几个工具验证过参数检查，旧版命令行实现下做过真实输入测试；这一版没有再用真实输入重跑。

历史记录（旧的命令行实现、SDK API 调研）在 [`notes/`](notes/)。

## 版权与许可

插件图标使用 AUV 官方 logo（AUV 仓库 `docs/assets/logo-light.svg`）加白色圆角背景；AUV 及其 logo © moeru-ai contributors，Apache-2.0 许可。其余内容为本集成项目的一部分，采用 [Apache-2.0](LICENSE) 许可。
