# Self Review

## Scope

- 任务：`治理大 Git Diff 性能与边界`
- 风险：CRITICAL。GitNexus 对 Worker/虚拟列表和 Rust payload 构造给出大范围传递风险；直接调用面集中在共享 Diff Controller、Desktop Git Diff 与 SSH Agent Git Diff，扩散图包含大量无关 import 流程，因此按高风险扩大到前端生产构建、全部 Git 回归、Desktop 库测试和 Agent 全量测试。
- 结论：解析、虚拟渲染、Transport 元数据和后端硬限制均按职责拆分；未新增依赖，未扩展图片、二进制、Office、音视频等文件类型支持。

## Scenario Matrix

- [x] Windows / Linux / macOS native：共享前端无平台分支；Desktop native/libgit2 在统一 payload builder 返回前执行相同字节和行数限制。
- [x] WSL：CLI Diff 生成继续复用现有 WSL 路由，最终进入与 native 相同的 payload builder；`/mnt/<drive>` 回退 native 的既有契约不变。
- [x] SSH：legacy `gitDiff` 与 capability-gated `gitDiffWithOptions` 均进入 Agent 的同一 payload builder；未增加 request kind 或 capability。
- [x] 旧 Agent：`byteLength` / `lineCount` 缺失时在 Transport 边界按 UTF-8 字节与 Rust 行语义补算，超限仍拒绝。
- [x] Snapshot / live / pinned：共享 Controller 统一限制 snapshot；live 与 pinned 从 Transport 接收归一化 payload；mutation capability 规则不变。
- [x] Split / Unified：按 Hunk 虚拟化，动态测量真实高度；分栏表格继续使用固定 table layout，选择状态由稳定 change key 驱动。
- [x] 文件切换 / options 切换 / Worker 失败：旧 generation 失效并终止；待聚焦记录绑定解析文件，不能落到新文件；失败回退关闭高亮。
- [x] 文件类型：只处理既有文本 Diff；二进制和不支持内容继续走原拒绝或只读 fallback，不新增预览或 Diff 类型。

## Findings And Fixes

1. Worker 初版只在 effect cleanup 时终止，成功解析后会空闲占用线程；错误回退也没有一次性 settle 门。
   - 修复：成功、失败回退和 cleanup 均终止 Worker；`settled + generation` 双门阻止重复结果或旧结果覆盖。
2. 虚拟列表初版只依赖 Hunk 数量触发主动滚动，相同 Hunk 数量的新文件可能保留旧滚动；待聚焦 key 也可能碰撞到新文件行号。
   - 修复：滚动依赖 Hunk identity；待聚焦状态绑定解析后的 `FileData` identity，不匹配时直接清理。
3. 旧 Agent 兼容测试只覆盖正常小 payload，没有证明缺元数据的超限内容会被前端拒绝。
   - 修复：增加缺元数据时超过 768 KiB 和 20000 行的双边界回归，并锁定 Worker fallback 禁用高亮。
4. Desktop、WSL 与 Agent 原先可能返回不同的大 Diff 错误语义。
   - 修复：所有最终 payload 路径统一返回 `git_diff_too_large`，不截断，不返回部分回滚入口。

## Verification

- [x] `npx tsc --noEmit`
- [x] `npm run build`；Vite 产出独立 `gitDiffParser.worker` chunk。
- [x] 10 个 Git Diff / Store / Transport 测试文件，共 48 项通过。
- [x] Desktop 定向 Git Diff 测试 5 项通过。
- [x] SSH Agent 定向 Git Diff 测试 4 项通过。
- [x] SSH Agent 全量：库测试 70 项、二进制测试 3 项通过。
- [x] `cargo check`：Desktop 与 SSH Agent 均通过。
- [x] `cargo fmt --check`：Desktop 与 SSH Agent 均通过。
- [x] `git diff --check` 通过。
- [x] Git Diff 职责文件均不超过 300 行；最大相关组件 `GitDiffEditorHost.tsx` 为 254 行，本任务新增文件最大 128 行。
- [x] 无直接 `console.log/info/warn`、类型抑制或新增依赖。

Desktop 全量库测试为 751 通过、3 失败、1 忽略。失败稳定复现于未修改的 `hook_settings::install_then_uninstall_pi_extension` 和 `history::request_logs` 两项夹具（后者两例读取到 12 条全局日志而期望 1 条），与本任务修改集无调用或文件交集；已作为父任务验收中的基线风险记录。

按项目规范未启动 Tauri 桌面应用。大 Diff 滚动、键盘跨虚拟 Hunk、IME、亮暗主题、125%/150%/200% 缩放、中英文和窄窗口视觉检查保留到父任务最终人工验收。
