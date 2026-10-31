# ANSI checkpoint 实验（2026-10-30）

结论：**当前跨内核 checkpoint 草稿失败，不能作为跨壳 attach 协议**。失败不等于整个 M0 No-Go：尚未触发 IME / 8 分屏的硬门槛失败判定，需要先确定可保真的协议范围。

## 固定范围与复现

- `poc-checkpoint` 使用 alacritty_terminal 0.26.0；Node 使用仓库锁定的 `@xterm/headless 6.1.0-beta.288`、`@xterm/addon-serialize 0.15.0-beta.288`。
- 网格 40 列 × 8 行，fixtureVersion=1，diagnosticVersion=2，8 个用例；最新完整原始结果为本地 `spikes/gpui-poc/bench/results/checkpoint.json`，记录时间 `2026-10-30T14:12:37.703Z`，替代首轮诊断。
- `node spikes/gpui-poc/bench/Check-Checkpoint.mjs` 退出 **1**。脚本同时比较原始 ANSI 的两个内核快照、xterm 序列化后的 alacritty 快照、反向 ANSI 的 xterm 快照与后续写入。
- 当前比较主要覆盖 active viewport 的文本、宽度、部分 SGR、光标、模式及 OSC 8 的 ID/URI；不是全部终端状态的证明。xterm 光标隐藏读取 `_core.coreService.isCursorHidden`，链接读取 cell.extended 与 `_core._oscLinkService.getLinkData` 私有接口，仅用于锁定版本实验；接口缺失或链接无法解析时直接报错。

## 实测矩阵

| 用例 | 相同原始 ANSI 的快照 | xterm Serialize → alacritty | 草稿反向快照 | 后续写入等价 |
|---|---|---|---|---|
| sgr | 一致 | 一致 | 一致 | 一致 |
| unicode | 一致 | 一致 | 一致 | 一致 |
| alternate | 一致 | 一致 | 一致 | **失败** |
| scroll-region | 一致 | **光标不同** | 一致 | **失败** |
| hyperlink | **下划线不同，链接 ID/URI 一致** | **失败，链接丢失** | 一致，但上游链接已丢失 | **失败（现已比较链接）** |
| cursor-modes | 一致 | 一致 | 一致 | 一致 |
| wrapping | 一致 | 一致 | 一致 | 一致 |
| wrap-pending | **光标不同** | **光标不同** | 一致 | **失败** |

## 根因与发现清单

checkpoint 位于终端内核与 ANSI 序列化边界：仅重画当前可见网格不能恢复影响后续输入的隐藏状态，不能用“截图相同”替代状态等价。

- 已确认：alternate 退出备用屏后的 normal buffer 内容丢失；草稿没有编码 inactive buffer。
- 已确认：OSC 8 原始输入在 alacritty 中有 4 个链接单元格，SerializeAddon 路径为 0；新增 ID/URI 比较定位到 xterm 自身序列化即丢失链接。原始输入两内核的链接相同，差异为 xterm 单元格带下划线、alacritty 不带。反向编码器现在保留显式 ID 和 URI，直接 alacritty → xterm 路径的链接比较通过，但下划线差异仍存在；不会过滤属性来制造全快照通过。
- 已确认：scroll-region 原始光标两内核均为 `[5,5]`，序列化后两内核均为 `[0,0]`，故初始光标损失来自 xterm 序列化。继续输入用绝对定位重置光标后，两个解析路径均等价，只有反向网格编码器丢失滚动区导致续写不等价。
- 已确认：wrap-pending 原始输入的 xterm 光标为 `[40,0]`，alacritty 为 `[39,0]`，属于表示差异；原始及 xterm 序列化输入经过 alacritty 后续写均等价。失败来自反向编码器的光标定位清除了待换行状态，不能把光标表示不同直接判为解析器丢失状态。
- 草稿缺口：inactive buffer、scrollback/history、margins、wrap-pending、键盘协议标志及栈；不能据少数模式字段相同声称这些状态通过。
- 触点已核对：`bench/Check-Checkpoint.mjs` 生成与比较、`poc-checkpoint/src/main.rs` 解析及编码；生产 checkpoint、daemon 协议均未修改。

## 分阶段续写定位

第二版诊断分别测试 xterm 自序列化、原始 ANSI → alacritty、序列化 ANSI → alacritty，以及不经过 xterm 序列化的 alacritty 网格 → xterm。各路径先恢复再写同一后缀，避免把整条链上的失败归给错误的一层。

| 用例 | xterm 自序列化续写 | 原始 ANSI 解析续写 | 序列化 ANSI 解析续写 | 直接反向编码续写 |
|---|---|---|---|---|
| sgr / unicode / cursor-modes / wrapping | 通过 | 通过 | 通过 | 通过 |
| alternate | 通过 | 通过 | 通过 | 失败 |
| scroll-region | 通过（后缀重置光标） | 通过 | 通过 | 失败 |
| hyperlink | 失败 | 失败（下划线） | 失败（链接/下划线） | 失败（下划线，链接保留） |
| wrap-pending | 通过 | 通过 | 通过 | 失败 |

`poc-checkpoint` 定向 release 构建通过。诊断退出 1 是已复现的门禁失败，不能写成测试全通过；原始快照或任一分阶段比较失败都会保持非零退出。比较器的扩大覆盖修正了首轮 hyperlink “续写一致”的不完整结论。

场景包括主/备用屏、原始/序列化输入、恢复前后、显式链接 ID、SGR、宽字/组合字及延迟换行；此处为离线内核实验，窗口焦点、WSL、Worktree 和 Hook 不参与路径，不据结果验收这些场景。双缓冲、历史与模式栈仍未实现，不扩大协议适用范围。

## 对设计的修订

父设计的 `checkpoint_ansi_v1` 应保留未验证状态。后续需明确双缓冲区/历史/模式的完整状态契约，增加“恢复后继续运行 TUI”的用例，再决定扩展序列化、约束跨壳范围或要求新开会话。当前不允许静默丢弃链接或备用屏后声称无损恢复。
