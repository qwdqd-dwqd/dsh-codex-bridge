# 本地改动（相对上游 0.2.5，已并入 0.2.6）

上游 `dsh-codex-bridge@0.2.5` 只在 **Windows** 上自动探测系统代理
（`codexProxyEnvironment()` 里 `process.platform !== 'win32'` 直接返回 `{}`）。
macOS 上 Codex CLI 的 Responses WebSocket 不读系统代理设置，于是每次调用都要先
`Reconnecting... 2/5 … 5/5` 空转约 100 秒才回落到 HTTPS，实测单次 `codex exec`
耗时 115–125 秒。

本机改动：新增 `macProxyAddress()`，用 `/usr/sbin/scutil --proxy` 读取系统代理
（HTTPS/HTTP/SOCKS，取第一个启用的），在 `codexProxyEnvironment()` 里对
`darwin` 分支注入 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`。

实测效果（同一台机器、同一模型 gpt-6.2-sol）：

| 场景 | 单次耗时 |
|---|---|
| 改前（无代理环境变量） | 115.4 秒 / 119.2 秒 |
| 改后（注入系统代理） | 7.1 秒 / 15.7 秒 |

注意：
- 只有当系统代理开启（本机 Shadowrocket，`127.0.0.1:7897`）时才注入；关掉代理后
  `macProxyAddress()` 返回空字符串，行为回落到上游原样，不会报错。
- 若进程已带 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，上游逻辑优先，本次改动不介入。
- 从 0.2.6 起此改动**已并入发布内容**（`index.js` 内含 `macProxyAddress()`），
  不再因升级而丢失。若日后回滚到上游 0.2.5，需要重新应用本补丁或向上游提 PR。
- 本文件不随 npm 包分发（不在 `package.json` 的 `files` 里），仅作仓库内记录。
