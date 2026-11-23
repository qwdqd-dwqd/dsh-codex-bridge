# DSH Codex Bridge 0.2.6

在 DSH 里读写本机 Codex 会话：侧栏列出、查看、续问，手机也能用。

在 DSH sidebar read, continue, and browse your local Codex sessions — including from a phone.

**[English](#english) · [中文](#中文)**

<a id="english"></a>
## English

### What it does

- **List** your local Codex / ChatGPT sessions, grouped by project. Reads `~/.codex/thread_history_1.sqlite` (or `$CODEX_HOME`).
- **Read** any session's messages inside DSH.
- **Continue** a session by sending a task. The host runs `codex exec resume <thread>` in the background — the task keeps running after you leave the panel, and you can come back to check elapsed time and the latest reply.
- **Panel works on mobile.** The sidebar panel rides the existing DSH login connection, so a paired phone can browse and dispatch tasks. Sending a task does not call a DeepSeek model — it spends your Codex plan.
- **Restart helper.** If Codex holds the session write lock, the panel's "Restart Codex" button quits and reopens the desktop app; DSH and mobile access keep running.

### Requirements

- DeepSeek Harness with `node:sqlite` support and Web client extensions (verified on DSH 0.2.5-rc.5 interfaces).
- Codex CLI, found via `CODEX_CLI_PATH` (env, or `CODEX_CLI_PATH = "..."` in `~/.codex/config.toml`), `PATH`, or the Codex/ChatGPT app bundle. On macOS with only the ChatGPT app installed, the plugin finds `ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` automatically.
- A logged-in Codex desktop session, with at least one session in its history.

### Install

Download the build for your OS from [Releases](https://github.com/qwdqd-dwqd/dsh-codex-bridge/releases):

| OS | File |
|---|---|
| macOS | `dsh-codex-bridge-0.2.6-macos.tgz` |
| Windows | `dsh-codex-bridge-0.2.6-windows.tgz` |

Then install it from DeepSeek Harness → Plugins → install from local file, and reopen DeepSeek Harness. Expand the right sidebar (`Ctrl + Alt + B`) and pick "Codex 会话".

Both files are packed from the same source and run on either OS; the split is only a convenience so you grab the right one. The macOS build is the one this release was verified on: the `scutil` proxy probe (see below) is included, which upstream 0.2.5 lacked. The Windows build ships the same code — its PowerShell proxy path is upstream's and unchanged, but this release was not re-tested on Windows hardware.

### Proxy behaviour

The Codex CLI's Responses WebSocket does not pick up the macOS system proxy, so without one it spends roughly 100 seconds retrying (`Reconnecting 1..5/5`) before falling back to HTTPS. This plugin reads the proxy and passes it to the child process:

- **If `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` already exist**, they are used as-is and nothing is probed.
- **macOS**, otherwise: `scutil --proxy` is consulted, and the enabled HTTPS/HTTP/SOCKS proxy becomes `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, with `NO_PROXY` defaulting to `localhost,127.0.0.1,::1`.
- **Windows**, otherwise: the system proxy is read via PowerShell.

Measured on macOS with a local proxy: ~115 s → ~7–16 s per task.

This only affects the Codex CLI that DSH launches. Tasks still continue the existing session.

### Notes

- The sidebar shows history from the DSH host you are connected to.
- Plugin needs `node:sqlite` and Web client extensions; older DSH builds will not load it.

<a id="中文"></a>
## 中文

### 功能

- **列表**：按项目分组列出本机 Codex / ChatGPT 会话，读取 `~/.codex/thread_history_1.sqlite`（或 `$CODEX_HOME`）。
- **阅读**：在 DSH 内查看任意会话的消息。
- **续问**：输入内容点「发送任务」，宿主用 `codex exec resume <thread>` 在后台继续该会话。离开详情页后任务仍会执行，再打开同一会话可查看已等待时间和最近回复。
- **手机可用**：侧栏面板使用当前 DSH 登录连接，已配对的手机可以浏览并派发任务。发送任务不调用 DeepSeek 模型，消耗的是 Codex 自身额度。
- **重启辅助**：提示会话写锁被占用时，点侧栏顶部「重启 Codex」并确认。DSH 宿主会正常退出并重新打开 Codex 桌面端，重启期间 DSH 和手机访问继续运行。桥接任务进行中不能重启；如果桌面端拒绝退出，请先处理其退出提示。发送失败的文字会回到侧栏输入框，重启后可以手动重发。

### 安装

1. 按系统下载对应安装包（[Releases](https://github.com/qwdqd-dwqd/dsh-codex-bridge/releases) 页面）：
   - macOS：`dsh-codex-bridge-0.2.6-macos.tgz`
   - Windows：`dsh-codex-bridge-0.2.6-windows.tgz`

   然后在 DeepSeek Harness 的「插件」管理中从本地安装，重新打开 DeepSeek Harness。

   两个包内容完全相同，按系统下载哪个都能装。差别只在验证范围：本次发布在 macOS 上实测（含下面说的 `scutil` 代理探测，上游 0.2.5 没有），Windows 包沿用上游的 PowerShell 代理逻辑、本次未在 Windows 机器上复测。
2. 打开 ChatGPT / Codex 桌面端登录一次，并确认这台电脑上已有 Codex 会话。桥接插件默认读取本机 `~/.codex`（Windows 为 `%USERPROFILE%\.codex`），使用自定义数据目录时应让 DSH 进程使用同一个 `CODEX_HOME`。
3. 在任意 DSH 会话中按 `Ctrl + Alt + B` 展开右侧栏，再点「Codex 会话」。要用手机访问，请先在该电脑上完成 DSH 手机连接配对。

在手机上：打开已配对的 DSH 手机网页，进入任意会话，点右上角侧边栏按钮，在「开始」页里选「Codex 会话」。如果侧边栏已打开其他标签，点标签栏的「+」打开「开始」页。列表按项目显示，点一条会话会跳到最新消息，向上滚动可查看历史，点「返回」回到列表。

CLI 会从 Codex 或 ChatGPT 应用包、`PATH` 和常见安装目录中查找，也可在宿主环境设置 `CODEX_CLI_PATH` 指向实际的 CLI 文件。

### 代理行为

Codex CLI 的 Responses WebSocket 不读 macOS 系统代理，没有代理时每轮会先空转约 100 秒重连（`Reconnecting 1..5/5`）才回落到 HTTPS。本插件把代理读出来传给子进程：

- **已有 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`** 时沿用，不做探测；
- **macOS** 其余情况读 `scutil --proxy`，把启用的 HTTPS/HTTP/SOCKS 代理转成 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，`NO_PROXY` 默认 `localhost,127.0.0.1,::1`；
- **Windows** 其余情况通过 PowerShell 读系统代理。

macOS 上实测：单次任务约 115 秒 → 约 7–16 秒。

此行为只影响 DSH 启动的 Codex CLI，发送任务仍继续现有会话。

### 兼容性

插件需要支持 `node:sqlite` 及 Web 客户端扩展的 DSH 版本，当前在 DSH 0.2.5-rc.5 的接口上验证。侧栏显示的是所连接 DSH 宿主上的历史。

## License

MIT © qwdqd-dwqd
