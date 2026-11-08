<img src="icon.svg" width="72" alt="AUV 桌面自动化"/>

# dsh-auv — DeepSeek Harness 的 AUV 桌面自动化插件

[English](./README.md) | **简体中文**

将 [AUV](https://github.com/moeru-ai/auv) 的操作系统自动化能力集成到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的原生模型工具。


> [!WARNING]
> **还请务必在此之前安装AUV** 系统若为 macOS 则须授予 **DeepSeek Harness** 权限 。安装与配置参考[前置工作](#前置工作)。
 

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

导航：[前置工作](#前置工作) · [安装](#安装) · [macOS 权限](#macos-权限) · [工具](#工具) · [配置](#配置) · [daemon](#daemon-连接方式) · [排障](#排障) · [状态](#状态)

AUV 相关链接：

- 仓库：<https://github.com/moeru-ai/auv>
- 文档 / 安装：<https://auv.moeru.ai>
- 术语与概念：<https://github.com/moeru-ai/auv/blob/main/docs/TERMS_AND_CONCEPTS.md>
- 支持的应用与扩展：<https://github.com/moeru-ai/auv/tree/main/supported>

## 安装

插件是构建好的。

在 **设置 → 插件 → 添加插件** 的输入框里填最新 release 的 tarball：

```
https://github.com/liliumneko/dsh-plugin-auv/releases/latest/download/dsh-plugin-auv.tgz
```

点安装，然后启用「AUV 桌面自动化」。安装后 12 个 `auv_*` 工具会在下一步模型调用时出现；建议先跑 `auv_doctor`。

同一个输入框也接受 npm 包名和本地目录。仓库里不放构建产物，正常安装请用 release tarball；开发构建和发版流程见 [docs/implementation.md](https://github.com/liliumneko/dsh-plugin-auv/blob/main/docs/implementation.md)。

在会话里也可以用命令，`target` 填同一个链接：

```
plugin_manager action=install_bundle target=https://github.com/liliumneko/dsh-plugin-auv/releases/latest/download/dsh-plugin-auv.tgz
```

禁用插件：
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
| `auv_screenshot` | 截全屏、窗口、应用、显示器或屏幕区域，返回 `.webp` 路径供 `read_image` 查看，同时带回 capture 的 bounds、缩放和像素信息 |
| `auv_ocr` | 在屏幕或窗口里找文字；`wait: true` 会轮询等待。匹配结果带屏幕坐标、窗口坐标和图片像素坐标 |
| `auv_click` | 点击 OCR 找到的文字，或点击指定坐标；可指定鼠标键、目标和点击区域，`space: "screen"` 对 Unity/Canvas 更可靠 |
| `auv_type` | 向当前焦点控件输入或粘贴文字 |
| `auv_keys` | 按一个组合键，可重复；`policy` 和 `focus` 控制投递方式 |
| `auv_scroll` | 在窗口内滚动，按窗口内坐标 |
| `auv_drag` | 从一点拖到另一点，支持屏幕、窗口、显示器坐标，可设鼠标键、时长，并在拖动前聚焦目标 |
| `auv_capture_state` | 给窗口或区域拍一张内存快照，返回 `state_token`；在操作前调用 |
| `auv_wait_for_change` | 观察窗口或区域并比较前后画面，返回 `changed` / `no_effect` / `timeout` 和 `changed_ratio`；传 `auv_capture_state` 拿到的 `state_token` 最可靠 |
| `auv_windows` | 列出窗口的 id、应用 id、标题、位置和状态 |
| `auv_activate` | 把应用带到前台 |

`auv_screenshot` 的 `.webp` 结果需要再调用 DSH 的 `read_image` 查看图像；工具本身不返回图片字节。

## 配置

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `AUV_BIN` | 依次从 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin` 查找 | `auv` 可执行文件绝对路径；只有插件需要自己启动 daemon 时用得到。无效时会报错并附安装指引 |
| `AUV_DSH_SDK_STORE_ROOT` | `$DSH_HOME/auv/sdk`（通常 `~/.dsh/auv/sdk`） | 插件自己启动的 daemon 的 store 目录 |
| `AUV_DSH_CAPTURE_DIR` | `$DSH_HOME/auv/sdk-captures`（通常 `~/.dsh/auv/sdk-captures`） | 截图 `.webp` 的保存目录，供 `read_image` 使用 |
| `AUV_DSH_CAPTURE_RETENTION_MS` | `3600000`（1 小时） | 每次新截图后，删除超过这个时长的 `.webp`；设为 `0` 表示永久保留 |
| `AUV_DSH_CAPTURE_MAX_FILES` | `200` | 最多保留多少个截图文件（保留最新的）；设为 `0` 表示不按数量清理 |

查找可连接的 daemon 时会遵循 AUV 自己的 `AUV_ENDPOINT` / `AUV_DISCOVERY_FILE`；`DSH_HOME` 可以改上面的默认数据目录。

## daemon 连接方式

如果已经有 AUV daemon 在跑，插件直接连上，不会替换它；没有时插件才启动一个自己的 daemon，
并在 Harness 卸载或重载时停掉。`auv_doctor` 会显示当前是哪种模式、监听在哪里。

## 坐标与验证输入是否生效

工具返回的点都是逻辑屏幕坐标。输入工具接受屏幕、窗口或显示器坐标，具体看每个工具的说明。

结果里带了 capture 信息时，用下面的公式换算：

```
image_pixel  = (screen_point - bounds.origin) * pixel_ratio
window_point = screen_point - window.frame.origin
screen_point = window_point + window.frame.origin
```

`image_pixel` 属于产生这个结果的这次 capture，不一定等于你之前自己截的那张图；`pixel_ratio`
是 `pixel_size.width / bounds.width`。截图结果带 `bounds`、`origin`、`scale_factor`、
`pixel_size`、`coordinate_note`；OCR 匹配结果在 `bounds` 之外还有 `screen_point`、
`image_pixel`、`window_point`、`pixel_ratio`。

输入工具返回的是“投递证据”，不代表应用真的响应了。验证一次输入：

1. 操作前先调 `auv_capture_state` 给目标窗口或区域拍快照；
2. 执行 `auv_click` / `auv_drag` / `auv_type` / `auv_keys` / `auv_scroll`；
3. 用返回的 `state_token` 调 `auv_wait_for_change`。它会比较缩小的 RGBA 画面并返回
   `changed_ratio`，`min_changed_ratio` 和 `pixel_threshold` 可以过滤鼠标或按钮闪烁。

`baseline_hash` 仍可用，但只做 ThumbHash 粗比较；可靠的做法是 `state_token`。默认
`min_changed_ratio` 是 0.01，用来忽略鼠标和按钮闪烁；如果是很小的变化（一行日志、一个勾选框），
可以只截那块区域，或者把 `min_changed_ratio` 调低（例如 0.0005）。`changed: false` 只表示画面
变化不够大，不代表按键没送达。同一组参数的修改类调用连续第 3 次会被插件拦下，返回
`no_effect_repeat`；重新截图确认后可以传 `allow_repeat: true` 再发一次。

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
auv_drag { "from": { "x": 300, "y": 500 }, "to": { "x": 600, "y": 500 }, "duration_ms": 400 }
auv_capture_state { "window_id": "<id>" }        # 返回 state_token
auv_drag { "from": { "x": 300, "y": 500 }, "to": { "x": 600, "y": 500 } }
auv_wait_for_change { "state_token": "<state_token>", "timeout_ms": 3000 }
```

## 排障

- **`AUV was not found`**：AUV 没装或不在 `PATH`。错误信息里有安装命令和仓库链接；装好后重启 Harness，再跑 `auv_doctor`。已有 daemon 在跑时，插件不装 AUV 也能连上。
- **插件装了但没反应**：先跑 `auv_doctor`。它会说明 AUV 是否找到、能不能连上 daemon、缺哪个 macOS 权限。
- **连不上 daemon**：看 `auv_doctor` 里的 endpoint 和错误。插件需要在没有可连接 daemon 时自己启动一个的话，确认 `AUV_DSH_SDK_STORE_ROOT` 可写。插件不会替换或停止你自己启动的 daemon。
- **权限错误**：按 [macOS 权限](#macos-权限) 授权，重启 Harness 后再跑 `auv_doctor`。
- **OCR 报 `vision OCR failed …`**：缺屏幕录制，或授权还没生效；授权并重启后重试。这期间可以先用 `auv_screenshot` + `read_image`。
- **`wait: true` 超时**：文字还在加载时，用更短的 `timeout_ms` 重试，比一次等很久更有效。
- **截图路径读不到**：把返回的绝对路径原样传给 `read_image`。截图是临时文件：每次新截图后会删掉超过 `AUV_DSH_CAPTURE_RETENTION_MS`（默认 1 小时）或超出 `AUV_DSH_CAPTURE_MAX_FILES`（默认 200）的旧图。需要在更长会话里保留截图，就把这两个值调大。

- **按键在 Unity/Canvas 游戏里没反应（Space、Return）**：AUV 会返回 `completed`，但游戏可能忽略这类注入事件（Stacklands 已复现）。改用屏幕坐标点击或 OCR 点击；`changed: false` 只表示画面没变，不代表按键没送达。这是 AUV 上游的驱动限制。

## 状态

已在 macOS 27.2 + AUV 0.0.43 + DeepSeek Harness 上验证。拖拽、屏幕坐标点击和画面变化检测在
Stacklands 实测可用；`auv_keys` 的按键注入仍无法推进那个 Unity 游戏，这是 AUV 上游驱动的问题。
构建、发版、设计和验证细节在 [docs/implementation.md](https://github.com/liliumneko/dsh-plugin-auv/blob/main/docs/implementation.md)。

## 版权与许可

插件图标使用 AUV 官方 logo（AUV 仓库 `docs/assets/logo-light.svg`）加白色圆角背景；AUV 及其 logo © moeru-ai contributors，Apache-2.0 许可。其余内容为本集成项目的一部分，采用 [Apache-2.0](LICENSE) 许可。
