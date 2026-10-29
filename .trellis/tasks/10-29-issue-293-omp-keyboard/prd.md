# 分析 Issue #293 OMP 键盘与回顶兼容方案（V1.4.5）

## Goal

为 https://github.com/dark-hxx/CLI-Manager/issues/293 提供有证据、可验收的
V1.4.5 解决方案，避免换行意图误发送，并补齐终端回顶导航。
用户已要求执行，并补充硬性验收条件：设置中的换行快捷键必须生效。
这取代先前的 TUI 所有权建议；用户已复核同意修订方案，进入实现。

## Background

- 报告环境：CLI-Manager V1.4.4、Windows 11、PowerShell，未提供 OMP 版本。
- 两个报告现象：已设置 Shift+Enter 换行但仍发送消息；Ctrl+Home 回到输入框而非顶部。
- 已确认边界：`src/features/terminal/browser/TerminalNewlineShortcut.ts:21` 与
  `src/features/terminal/hooks/useXTermController.ts:1323` 在原生编码前消费修饰 Enter；
  `src/shared/preferences/settingsStore.ts:330` 与 controller `:1392` 缺少回顶动作。
- 库级实验还发现键盘协商状态会在当前快照序列化中丢失。完整证据与根因限定见
  `research/findings.md`；尚未在真实 OMP/ConPTY 中复现，不能认定 LF 必然发送。

## Requirements

- R1：设置中的换行快捷键在 legacy 和增强键盘协议下均优先生效，不能因 TUI
  协商了增强协议就失效。分别设置 Shift+Enter、Ctrl+Enter、Alt+Enter 后，
  在 OMP 编辑器内按对应组合键只换行、不发送；普通 Enter 的提交只发生一次。
  未选中的组合键维持既有吞键/兼容例外规则，不新增隐式发送路径。
- R2：Ctrl+Home 默认回到 xterm 普通缓冲区保留历史的最顶部；可修改或禁用。
  不劫持备用屏应用的内部导航，也不承诺超出 scrollback 保留范围的无限历史。
- R3：在模式切换、断线重连、活跃会话重新附着和 Web/Tap 镜像加入后保持一致行为；
  不重复回复终端查询，不通过重启/终止用户会话规避错误。
- R4：保留 legacy CLI 换行、IME 候选确认、程序化模板提交、精确分屏会话身份，
  覆盖本地/WSL/SSH 与 Hook 开关无关场景。新提示与设置标签兼容 zh-CN/en-US。
- R5：交付根因陈述、触点清单、技术取舍、风险、回滚及逐项验证计划；
  明确区分源码确认、库级实验、上游参考和实机待验，避免提前声称已修复。

## Acceptance Criteria

- [x] AC1（R5）：证据与发现清单已写入 `research/findings.md`，根因和场景矩阵在 `design.md`。
- [x] AC2（R5）：技术设计、兼容性边界、替代方案及回滚边界已形成待审稿。
- [x] AC3（R1–R4）：`implement.md` 包含实现顺序、定向测试和实机验收清单；
  已实施并增加真实 xterm 协议、快照裁剪和输入生命周期回归，实机验收仍待完成。
- [x] AC4a（R1）：用户已明确应用换行设置优先，包含增强协议场景。
- [x] AC4b（R1）：用户已审阅同意按此要求修订后的语义映射方案。
- [x] AC5（R5）：修订方案确认后启动任务；实施后按 V1.4.5 更新两份代码变更记录。

## Confirmed Product Decision

2026-10-29 用户要求：最终效果是“在设置中设置的换行快捷键起作用”。
因此应用设置拥有物理快捷键的优先权，不能采用“增强 TUI 下应用设置不生效”的方案。
协议能力、回顶、镜像与快照修复方向保留；补充语义按键重映射及完整事件生命周期验证。
验收覆盖 OMP 受支持的编辑器换行语义，不承诺绕过任意第三方插件或自定义 TUI
把所有可用换行输入都重新绑定为发送的配置；遇到冲突须明确报告，不得假装修复成功。

## Out Of Scope

- 修订方案复核前不修改业务代码；本任务不升级依赖、不修改 PTY/IPC/数据库协议、不发布版本。
- 不新增 OMP 供应商/历史解析/Hook 等无关集成，不重构整个 settingsStore。
- 不提前将未实现修复写入 CHANGELOG.md 或 docs/功能清单.md；实施后按 V1.4.5
  更新对应终端/快捷键板块，版本号指定本身不等于授权全仓版本升级。

## Implementation Delivery

Reviewed settings-first implementation is complete. Verification details and
manual gaps are in `validation.md`. Automated tests do not establish reproduction
of the reporter's exact OMP version/environment; do not close #293 on that basis.
