# Self Review

## Scope

- 任务仅产出研究、ADR 和后续切片，不修改产品代码、依赖、Transport 或协议。
- 研究覆盖搜索、路径/Hunk/选中行/文件 Patch、AI 上下文与剪贴板边界。

## Acceptance

- [x] 记录现有复用点、差距和不新增依赖依据。
- [x] 定义搜索输入、匹配、快捷键、虚拟定位、取消和超限行为。
- [x] 定义五类复制输出及其 capability 和禁用条件。
- [x] AI 上下文包含项目、仓库、路径、状态、scope、范围、Diff 和截断元数据。
- [x] 覆盖弹窗/固定页、本地/WSL/SSH、实时/快照、重命名/新增/删除/冲突/二进制/fallback/超限。
- [x] ADR 明确状态归属、数据权威、隐私边界和拒绝直接发送 Agent。
- [x] 拆分三个可独立验收的垂直切片，并给出文件职责和行数上限。

## Findings

1. 原研究建议把搜索状态直接加入 `useGitDiffController`，会让已达 227 行的 Hook 混入第二项职责。
   - 修正：搜索状态独立到 `useGitDiffSearch`，Controller 只提供 revision/model。
2. `copyAiText` 未使用现有系统剪贴板降级，失败文案还是硬编码中文。
   - 修正：ADR 要求后续先统一写入边界和调用方双语反馈。
3. 仅凭 `react-diff-view` 的 `FileData` 无法可靠保留 mode、rename、无尾换行等 Patch header。
   - 修正：原始 Diff 负责字节与 header，解析模型只负责范围，两者必须同 revision。
4. “复制选中行”若只拼接 `+/-` 文本并不是合法 Patch。
   - 修正：定义与后端反向回滚对称的正向算法，并要求真实 `git apply --check` fixture。

## Verification

- [x] GitNexus 索引刷新；本机 FTS 缺失导致 TypeScript `query/context` 无结果，已记录降级原因。
- [x] fast-context 找到 Viewer、Controller、虚拟列表、选择、剪贴板和 AI 路径触点。
- [x] 使用 `rg` 精确核对 `copyAiText`、`formatAi*`、`copyTextToClipboard` 和行级回滚 Patch 算法。
- [x] `git diff --check` 将在提交前执行。
- [x] 本任务没有 `src/`、`src-tauri/`、`package.json` 或锁文件变更，无运行测试要求。
