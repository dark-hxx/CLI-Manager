# PRD：OSC 52 本机剪贴板（#211）

## 根因陈述

缺陷位于 CLI-Manager 宿主终端的 OSC / 鼠标边界，而不是远端有没有 GUI。Grok 等全屏 TUI 已通过 PTY 发出 OSC 52；前端 `useTerminalOsc` 只处理颜色查询，不消费 52，也不写入 Tauri 剪贴板。CLI-Manager 自建 SSH 插不进 `grok wrap`。同时 `mouseEventsRequireAlt: false` 把拖选交给 TUI，松手重绘清掉 xterm 选区；`Ctrl+Shift+C` 被 Chromium 当成检查元素。

## 场景矩阵

| 维度 | 覆盖 |
|---|---|
| 会话类型 | 本地 / WSL / SSH |
| 输出种类 | live / replay / reset |
| 序列 | BEL、ST、tmux DCS、query、clear、非法 Base64、分帧、中文 |
| 设置 | 分别验证写入开关与默认关闭的读取开关 |
| 窗口焦点 | 当前终端 / 其它页；开关关闭时仍剥离 |
| 鼠标 | 普通拖选选终端；Alt 交给 TUI |
| 快捷键 | `Ctrl+Shift+C` 复制；F12 仍开调试工具 |

## 验收

1. 远程 Grok 复制进入本机剪贴板。
2. 用户明确开启读取开关后，查询 `52;c;?` 才回应当前剪贴板；异步读取后若授权已撤销、回复超过 2,000,000 个 Base64 字符或队列已满则不回应，默认不回应。
3. 写剪贴板与查询回答可独立关闭，读取授权不参与备份/同步。
4. `Ctrl+Shift+C` 不打开 DevTools，有选区则复制。
5. 普通拖选松手后选区仍在，除非按住 Alt。
