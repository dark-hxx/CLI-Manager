# Bug Analysis: Codex 终端换行快捷键失配

## 1. Root Cause Category

- **Category**: E - Implicit Assumption；D - Test Coverage Gap
- **Specific Cause**: 旧修复正确确定了 Codex 需要 `ESC + CR`，但默认 CLI 类型能由项目、Tab 标题或启动命令静态识别；右上角新建普通 Tab 会省略本地 `projectId`，手动执行 `codex` 也不会更新这些字段。项目直启路径同时遗漏了已固化的 `TerminalSession.cliTool`。

## 2. Why Fixes Failed

1. 2026-06-04 修复：只修正“识别为 Codex 后发送什么”，没有验证“所有创建/运行路径都能识别为 Codex”。
2. 验证只覆盖静态项目会话和 Claude 不回归，没有覆盖普通 Shell 手动启动、右上角新建 Tab、退出 TUI 及 Hook 未安装。
3. 首轮本任务修复：错误假设手动 Codex 默认使用 alternate buffer，测试夹具也默认构造 alternate buffer，导致 normal-buffer 用户现场仍失败。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | CLI 专用输入统一读取固化 `session.cliTool`，手动启动按当前 viewport 实时识别且不依赖 buffer 类型 | DONE |
| P0 | Test Coverage | 增加项目元数据、normal/alternate 手动 Codex、普通 Shell、Claude、off-viewport 回归测试 | DONE |
| P1 | Documentation | 将静态元数据 + 有界运行态识别契约写入前端组件规约 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: IME 诊断、TUI 背景修正等复用 `isCodexSession` 的路径也会受益；不能各自复制 CLI 判断。
- **Design Improvement**: 区分不可变的会话意图与短生命周期的运行态证据，禁止把 viewport 猜测永久写入 Store。
- **Process Improvement**: CLI 行为回归测试必须按“项目直启 / 普通终端手动启动 / 退出 / Hook 有无 / 本地与 WSL”枚举。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/frontend/component-guidelines.md`。
- [x] 增加 `scripts/terminalNewlineShortcut.test.mjs`。
- [ ] 同步生成模板：仓库不存在 `src/templates/markdown/spec/` 或其他 spec 模板目录，无可同步目标。
- [ ] 提交规约：按项目用户指令不擅自执行 Git 提交。

# Bug Analysis: Codex 恢复仍回退 `--last`

## 1. Root Cause Category

- **Category**: B - Cross-Layer Contract；D - Test Coverage Gap；E - Implicit Assumption
- **Specific Cause**: 首轮修复把 Zustand 运行态 ID 的 `changed` 当成持久化成功证明，没有对账 `sessionStore.sessions`。HMR、旧 Hook 事件或异步保存失败后可能出现运行态已有 ID、磁盘仍为空；后续相同 ID 的 Hook 因 `changed=false` 永远不再保存。

## 2. Why Fixes Failed

1. 首轮定位正确发现本地 Hook 缺少立即保存，但保存条件仍建立在运行态，而恢复消费的是另一份持久化状态。
2. 回归测试只做源码接线断言，没有构造“运行态 ID 已存在、持久化 ID 缺失”的跨 Store 分叉。
3. 实机开发环境 `sessions.dev.json` 明确显示 Codex 会话 ID 为空，证明类型检查和单 Store 单元测试不足以验证持久化闭环。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | Hook 保存条件对账 `sessionStore.sessions`，持久化 ID 缺失或不同时自愈保存 | DONE |
| P0 | Test Coverage | 增加运行态相同、持久化缺失 ID 的回归用例及 Store 接线断言 | DONE |
| P1 | Documentation | 在工作区恢复契约中区分运行态状态与持久化事实 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: 所有“先更新 Zustand、再异步写 tauri-plugin-store”的流程都不能用运行态相等推断磁盘已落盘。
- **Design Improvement**: 需要持久化自愈的事件处理器，应比较消费者真正读取的持久化 Store，而不是比较生产者刚更新的内存对象。
- **Process Improvement**: 持久化缺陷的测试必须覆盖 `runtime == incoming && persisted != incoming`，不能只测 `runtime != incoming`。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/frontend/workspace-session-restore-contracts.md`。
- [x] 更新 `scripts/terminalCliSession.test.mjs`。
- [ ] 同步生成模板：仓库不存在 `src/templates/markdown/spec/` 或其他项目 spec 模板目录，无可同步目标。
- [ ] 提交规约：等待用户实机验证，且不擅自执行 Git 提交。

# Bug Analysis: 历史继续对话 Tab 重启后串到最近会话

## 1. Root Cause Category

- **Category**: B - Cross-Layer Contract；C - Change Propagation Failure；D - Test Coverage Gap
- **Specific Cause**: 历史继续对话的本地/WSL 分支只把目标 Session ID 写进首次启动的 resume 命令，没有同步传给 `createSession(..., cliSessionId)`。首次打开能进入正确历史会话，但工作区快照缺少 Tab 身份；重启恢复只能生成 `--last`，于是与同项目的新会话合并。

## 2. Why Fixes Failed

1. 第一轮把问题限定在 Hook 后置持久化，未检查 Tab 创建时是否已经拥有身份；历史继续对话可能在 Hook 上报前关闭，因此不能依赖后置补齐。
2. 第二轮补上持久化 Store 对账，只解决“运行态已有 ID、磁盘缺失”的分叉，仍无法修复从创建起运行态和磁盘都没有 ID 的 Tab。
3. 之前的测试从 Hook → 快照 → 恢复命令单向验证，没有构造“历史会话 A + 新会话 B + 重启”的双 Tab 身份隔离场景。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | 历史继续对话创建终端时把用于 resume 命令的同一 Session ID 直接写入 `TerminalSession.cliSessionId` | DONE |
| P0 | Test Coverage | 增加 `HistoryWorkspace.resumeSession` 本地/WSL 创建参数回归断言，并保留明确 ID 恢复测试 | DONE |
| P1 | Documentation | 在工作区恢复契约中明确“创建时身份”和“Hook 后置身份”是两条入口 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: 任何通过明确外部会话 ID 创建内部 Tab 的入口都必须同时设置启动命令和结构化身份字段；SSH 分支已满足，历史本地/WSL 分支现已补齐。
- **Design Improvement**: `startupCmd` 是一次性执行指令，不是可持久化身份来源；恢复、统计、Hook 绑定必须读取结构化 `cliSessionId`。
- **Process Improvement**: 会话恢复测试必须至少覆盖同项目、同 cwd、不同 Session ID 的多 Tab 场景，不能只测单 Tab。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/frontend/workspace-session-restore-contracts.md`。
- [x] 更新 `scripts/historyResumeProject.test.mjs`。
- [ ] 同步生成模板：仓库不存在 `src/templates/markdown/spec/` 或其他项目 spec 模板目录，无可同步目标。
- [ ] 提交规约：等待用户实机验证，且不擅自执行 Git 提交。
