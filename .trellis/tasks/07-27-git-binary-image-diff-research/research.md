# 图片与二进制 Diff 研究

## 1. 结论

结论为 **No-Go**。CLI-Manager 的 Git Diff 继续只支持现有文本 unified diff 与只读 raw fallback，不新增图片、SVG、PDF、Office、压缩包、视频、音频、3D 或通用二进制比较。现有文件图片预览不升级为 Git revision 比较器。

## 2. 证据

| 触点 | 当前行为 | 结论 |
|---|---|---|
| `src-tauri/src/commands/git_diff.rs` | payload 只有文本 `content`、回滚标志、字节数和行数 | 保持文本契约，不引入 `text/image/binary` 判别联合 |
| `git_diff_display.rs` | CLI 输出检测 `Binary files ` 并禁用局部回滚；native 仍输出 Git 的文本标记 | 二进制没有 old/new 内容或逐行模型 |
| `ssh-agent/src/git_diff.rs` | tracked 二进制返回 Git 文本标记；untracked NUL 内容生成 `Binary files ... differ` | 不传输二进制字节，不增加 Agent capability |
| Desktop/WSL untracked | 使用文本解码；二进制返回现有 `binary_file` 错误 | 保留现有错误语义 |
| `diff/GitDiffContent.tsx` | 只渲染解析 Hunk或 Monaco raw 文本 fallback | 不新增图片/二进制 Viewer 分支 |
| `files/FileEditorContent.tsx` | 图片预览只展示当前工作区文件的 base64/data URL | 不是 Git HEAD/index/worktree 双侧对象接口 |
| `ssh-agent/src/files.rs` | 图片预览按路径读取当前文件，并有既有大小/像素限制 | 不能证明或读取任意 Git revision blob |
| `git-diff-viewer-contracts.md` | 大 Diff 契约明确禁止增加 image/office/archive/audio/video 支持 | No-Go 与已落地系统边界一致 |

GitNexus 的 TypeScript FTS 在本机不可用；按项目降级规则使用 fast-context 找到 Git Diff、文件预览和 Agent 触点，并通过契约与 `rg` 核对具体行为。本任务不修改符号，无 impact 目标。

## 3. 当前行为矩阵

| 文件/来源 | Desktop native | WSL | SSH | 前端结果 |
|---|---|---|---|---|
| UTF-8/可解码文本 | unified diff | Git CLI unified diff | Git CLI unified diff | 共享 Diff Viewer |
| 非 UTF-8 可识别文本 | 转码展示，只读局部操作 | 转码展示，只读局部操作 | 解码展示，只读局部操作 | 文本 Diff/raw fallback |
| tracked 二进制 | Git 文本标记，无可解析 Hunk | `Binary files ... differ` | `Binary files ... differ` | 只读文本/空 Hunk，不展示二进制内容 |
| untracked 二进制 | `binary_file` | 同 Desktop untracked 路径 | 合成 `Binary files ... differ` | 错误或只读标记 |
| 图片/SVG/PDF/Office/压缩包/音视频 | 按二进制处理 | 按二进制处理 | 按二进制处理 | 无专用 Diff |
| 历史/终端快照 | 只消费已有文本 | 不区分环境 | 不区分环境 | 文本 snapshot 或 raw fallback |
| 超过 768 KiB/20000 行文本 | `git_diff_too_large` | 同左 | 同左 | 双语超限错误，无局部回滚 |

本任务不统一 Desktop 与 SSH 的二进制提示差异，因为那会改变产品行为；差异只作为现状记录。所有环境都不返回二进制正文，因此不存在误解为已支持图片比较的情况。

## 4. 为什么不复用图片预览

1. 文件预览只有当前工作区路径；Git Diff 需要 HEAD/index/worktree 两侧和缺失侧。
2. 文件预览的 data URL/base64 契约会把双侧大对象放大并复制到 JSON、JS 字符串和 WebView 内存。
3. SSH 文件读取能力验证项目相对路径，不是受限的 Git object/revision 读取能力。
4. 当前图片预览包含 SVG 候选，而 Git Diff 若渲染不可信历史 SVG，需要独立脚本、外链和资源攻击模型。
5. 图片缩放 UI 可复用的只是视觉布局，不足以抵消后端对象、传输、缓存和生命周期成本。

## 5. 被拒绝的契约扩展

本轮明确不增加以下类型或接口：

```ts
// Rejected in this scope.
type GitDiffContent = TextDiff | ImageDiff | BinaryDiff;
interface GitImageSide { contentId: string; width: number; height: number }
```

同时拒绝：

- 在 `content: string` 中放 base64/data URL。
- 增加 old/new blob 内容句柄或任意 revision 参数。
- 增加 SSH `imageDiff`/`binaryDiff` capability。
- 在前端按扩展名或单个 NUL 自行判断 MIME。
- 内联 SVG、通用 hex viewer 或二进制 Patch。
- 为上述能力新增 Rust/前端依赖。

## 6. 场景矩阵

| 维度 | 决策 |
|---|---|
| Windows / Linux / macOS | 继续走现有 Desktop 文本 Diff |
| WSL / SSH | 继续走现有 Git CLI 文本输出和 Agent 限制 |
| 根仓库 / 嵌套仓库 / Worktree | 路径边界不变，无二进制读取入口 |
| HEAD / index / worktree | 不增加双侧 blob 读取 |
| 新增 / 删除 / 修改 / 重命名 / 冲突 | 二进制均只保留现有错误或文本标记 |
| 弹窗 / 固定页 / snapshot | 不增加专用渲染组件 |
| 损坏文件 / SVG 外链 / 解码炸弹 / 动图 | 不读取、不解码、不渲染，风险自然隔离 |
| 旧 SSH Agent / 断线 | 无新 request kind，兼容性不变 |

## 7. No-Go 的系统收益

- 保持 `GitTransport`、Desktop 和 Agent wire shape 不变。
- 不扩大远程攻击面、WebView 内存峰值和缓存生命周期。
- 不把文件预览状态耦合进共享 Diff Viewer。
- 不新增低频但高维护成本的专有格式矩阵。
- P0/P1 已交付的文本审阅能力可独立验收，不被新文件类型拖累。

## 8. 未来重新评估条件

本父任务下不创建后续实施切片。只有同时满足以下条件，才允许另开独立父任务重新研究：

1. 用户明确重新排序并确认至少一种具体格式，而不是泛化为“所有二进制”。
2. 明确 HEAD/index/worktree 对象读取和路径/revision 防越权契约。
3. 明确 encoded bytes、decoded pixels、总内存、动画、SVG 和缓存硬限制。
4. 本地、WSL、SSH 有统一的有界二进制通道和 capability 迁移方案。
5. 单独评估收益，禁止顺带扩展 Office、PDF、音视频或 hex editor。

在条件满足前，正确行为是保持现状，而不是预埋未使用的类型、接口或依赖。
