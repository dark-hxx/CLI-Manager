# Git Diff 搜索、复制与 AI 上下文研究

## 1. 结论

后续能力应继续建立在共享 `GitDiffViewer` 上，拆成三个纯前端垂直切片：当前文件搜索、Patch/路径复制、AI 上下文复制。搜索状态属于单个 Viewer 实例；复制格式由纯函数从原始 Diff 与解析模型生成；剪贴板只负责写入。不得新增 Tauri/SSH RPC、依赖、全局 Store 或直接发送 Agent 的入口。

## 2. 调研证据

| 触点 | 现状 | 结论 |
|---|---|---|
| `diff/useGitDiffController.ts` | 已拥有加载、解析结果、选择和回滚编排，当前 227 行 | 不继续塞入搜索 UI 和复制格式；只暴露不可变 revision/model |
| `diff/GitDiffHunkList.tsx` | 已按 Hunk 虚拟化并支持跨 Hunk 聚焦 | 搜索定位复用 `hunkIndex + changeKey`，不得按 DOM 序号定位 |
| `diff/GitDiffToolbar.tsx` | 已统一弹窗和固定页工具栏 | 搜索入口与复制菜单在此组合，不另建第二套工具栏 |
| `diff/gitDiffSelection.ts` | 已维护稳定变更行 key、old/new side 和 Hunk 序号 | 选中行复制复用选择模型，不从 DOM selection 反推 |
| `src/lib/aiClipboard.ts` | 直接调用浏览器剪贴板，失败文案硬编码中文 | 后续先改为复用系统剪贴板适配器，并由调用者传入双语文案 |
| `src/lib/systemClipboard.ts` | 已封装 Tauri、浏览器和 textarea 降级 | 作为唯一底层写入边界，不新增后端复制命令 |
| `src/lib/aiPathFormatter.ts` | 已统一 `/` 路径、AI 路径和行锚点语义 | 复用路径规范；Diff 专属元数据放在独立格式器 |
| `files/FileEditorPane.tsx` | Monaco 自带查找，并提供复制 AI 路径/上下文行为 | 复用快捷键和反馈语义，不耦合 Monaco editor/model 状态 |
| Desktop/WSL/SSH transport | 负责取得 Diff 与执行变更 | 纯搜索和复制确认无关，不增加 capability 或 wire 字段 |

GitNexus 索引已刷新，但本机 FTS 扩展不可用，`query/context` 无法解析相关 TypeScript 符号；按项目降级规则使用 fast-context 定位上述调用链，再以契约和 `rg` 精确核对。进入后续实施切片前，仍须对实际修改符号执行 upstream impact。

## 3. 发现清单

- [x] 共享 Viewer、弹窗与固定页：必须共用同一搜索/复制能力。
- [x] Hunk 虚拟列表：必须提供模型级定位，不能要求目标行已经挂载。
- [x] 选择模型：可提供选中变更行，确认与复制范围一致。
- [x] Worker/大 Diff 限制：搜索沿用 64 KiB Worker 阈值及 768 KiB/20000 行硬上限。
- [x] AI 路径与剪贴板：可复用，但失败国际化需先收敛。
- [x] GitTransport、Desktop、WSL、SSH Agent：确认与纯文本搜索/组装无关。
- [x] 历史/终端统计快照：只读但可搜索和复制可证明的原始内容。
- [x] Monaco fallback：只能使用其原生查找和原始文本复制，不能承诺生成可应用 Patch。

## 4. 搜索行为契约

### 输入与匹配

- 范围仅为当前文件、当前 Diff options 下已解析的 Hunk 行，包括变更行和上下文行；排除文件头和 Hunk header。
- 首期只支持最长 256 字符的纯文本、Unicode 大小写不敏感匹配；不支持正则、替换、整词或跨文件搜索。
- 匹配 ID 为 `revision + hunkIndex + changeIndex + side`；结果只保存 ID、Hunk 序号和字符范围，不保存第二份完整 Diff。
- Diff revision、target 或 options 变化时立即取消旧计算并清空匹配，避免跳转或复制旧内容。

### 交互

- `Ctrl/Cmd+F` 打开并聚焦搜索框；`Enter`/`Shift+Enter` 下一个/上一个；`Esc` 关闭并将焦点还给 Viewer。
- 结果不循环；到达边界时禁用相应动作并通过状态文本表达，不只依赖颜色。
- 空查询不执行扫描；零结果显示 `0/0`；解析失败时沿用 Monaco 原生查找，不维护两套自定义结果。
- 命中未挂载 Hunk 时先 `scrollToIndex`，挂载后再按 change key 聚焦和高亮。

### 性能

- 小于等于 64 KiB 同步扫描原始行文本；更大内容使用可取消 Worker，并复用 generation 规则。
- 连续输入只保留最后一次 generation；Worker 结果只返回轻量匹配描述。
- 不生成全量 lowercase 副本；使用转义后的 Unicode 不区分大小写 matcher。

## 5. 复制格式契约

所有输出统一 LF；Patch 类结果末尾恰好一个换行。输入必须来自同一 revision 的原始 Diff 与解析模型。

| 动作 | 输出 | 禁用条件 |
|---|---|---|
| 复制路径 | 普通文件为 `src/a.ts`；重命名为 `src/old.ts -> src/new.ts` | 无可信仓库相对路径 |
| 复制 Hunk | 原始文件 prelude 加目标完整 Hunk | 非标准 unified diff、Hunk 映射失败 |
| 复制选中变更 | 文件 prelude 加覆盖所选行的最小合法正向 Hunk，重算 old/new count | 无选择、解析失败、非 exact 视图或无法形成合法 Patch |
| 复制文件 Patch | 当前文件完整标准 unified diff | 二进制标记、fallback 文本或非标准 patch |
| 复制原始 Diff | 原始可见文本，不声明可应用 | 内容为空 |

Patch 必须从原始文本切片并保留 `diff --git`、mode、rename、`---/+++` 和 `\ No newline` 标记，不能从渲染 DOM 或仅凭 `FileData` 重建。选中行 Patch 的正向规则与现有后端反向回滚算法对称：未选中的删除行降为上下文，未选中的新增行省略，选中变更保留符号，并逐 Hunk 重算范围。后续单测必须用真实仓库执行 `git apply --check`。

## 6. AI 上下文格式

````text
project: CLI-Manager
repository: .
path: src/components/git/diff/GitDiffViewer.tsx
old_path: src/components/git/DiffViewerModal.tsx
status: R
scope: unstaged
range: old L10-L20; new L12-L24
truncated: false
diff:
```diff
@@ -10,11 +12,13 @@
 ...
```
````

- `old_path` 仅重命名时出现；`range` 由 Hunk 或选择模型生成，不能猜测。
- 默认 UTF-8 总上限 64 KiB，包含 metadata。截断只发生在完整行边界，并写入 `truncated: true` 与 `omitted_lines: N`。
- 截断后的内容是上下文片段，不得命名为 Patch 或声称可应用。
- 只写用户剪贴板；不读取剪贴板、不持久化 Diff、不记录正文日志、不自动发送 Claude/Codex/其他 Agent。

## 7. 场景矩阵

| 场景 | 搜索 | 文本复制 | 可应用 Patch |
|---|---|---|---|
| 弹窗 / 固定页 | 相同 | 相同 | 相同 capability |
| Split / Unified | 相同模型，分别定位 side | 相同 | 相同 |
| 本地 / WSL / SSH | 相同 | 相同 | 相同 |
| 实时 exact Diff | 支持 | 支持 | 支持标准文本 Diff |
| ignore whitespace | 支持 | 支持 | 禁用选中行可应用 Patch |
| 历史/终端快照 | 支持 | 支持原始内容 | 仅标准完整 Patch；不承诺当前工作区可应用 |
| 新增 / 删除 / 重命名 / 未跟踪 | 支持 | 保留完整 header | 标准 header 完整时支持 |
| 冲突 / 二进制 / fallback | fallback 自带查找或禁用 | 仅原始文本 | 禁用 |
| 超过硬限制 | 无内容，不搜索 | 无内容，不复制 | 禁用 |
| 内容刷新 / 快速切换 | 取消旧 generation | 绑定当前 revision | 禁止旧范围输出 |

## 8. 后续垂直切片

1. `D07-A 当前文件搜索`：依赖 foundation、navigation、large-performance；交付 `gitDiffSearch.ts`、`useGitDiffSearch.ts`、`GitDiffSearchBar.tsx`，以及虚拟定位、键盘和无障碍测试。
2. `D07-B Diff 复制`：依赖 interaction；交付 `gitDiffPatchFormatter.ts`、`GitDiffCopyMenu.tsx`，覆盖路径、Hunk、选中行、文件 Patch 与真实 `git apply --check` fixture。
3. `D07-C AI 上下文`：依赖 D07-B；交付 `gitDiffAiContextFormatter.ts` 和统一剪贴板反馈，覆盖 64 KiB 截断、双语提示与隐私边界。

每个文件只承担一种职责，目标不超过 200 行，达到 300 行必须继续拆分。三个切片均不得修改 Transport 或直接发送 Agent。
