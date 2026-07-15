# 文件预览多编码文本兼容设计

## 根因陈述

问题位于“用户项目文件原始字节 → Rust 字符串 → 前端编辑状态”的跨 IPC 边界：后端所有相关入口默认原始字节必为 UTF-8，读取时拒绝或丢弃非 UTF-8 内容，保存时又固定写成 UTF-8，因此修复必须落在共享编解码层并把编码元数据贯穿读写链路，不能只在前端隐藏 `not_utf8`。

## 范围

覆盖：

- 文件预览、编辑和保存。
- 文件内容搜索。
- 用户项目文件 Git Diff 展示。

不覆盖：

- 历史 JSONL、Replay patch、Worktree Snapshot patch、CLI-Manager 配置等内部格式。
- 手动编码选择、重新打开编码、保存为编码和项目编码配置。
- 非 UTF-8 Diff 的行级/Hunk 级 Patch 回滚。

## 发现清单

| 触点 | 结论 |
| --- | --- |
| `src-tauri/src/commands/fs.rs::file_read_text` | 根因触点，同时被 Replay 内部 Patch 读取复用；保持严格 UTF-8，不直接放宽。 |
| `src-tauri/src/commands/fs.rs::file_write_text` | 根因触点，同时被 Replay/同步上下文内部文件复用；保持固定 UTF-8，不直接改签名。 |
| `src-tauri/src/commands/fs.rs::collect_content_matches` | 同类触点：非 UTF-8 文件被静默跳过。 |
| `src-tauri/src/commands/git.rs::git_get_file_diff` | 同类触点：未跟踪文件使用 `read_to_string`。 |
| `src-tauri/src/commands/git.rs::format_diff_to_text_allow_empty` | 高风险共享触点：同时服务 UI Diff 与 Worktree Snapshot/恢复，必须拆分展示与 Patch 语义。 |
| `src/stores/fileExplorerStore.ts::loadProjectFile/saveFile` | IPC 元数据承接与保存错误提示。 |
| `src/components/files/FileEditorPane.tsx` | 保存失败时必须保留脏状态和关闭确认框，避免失败后继续关闭。 |
| `src/components/git/DiffViewerModal.tsx::GitDiffViewer` | 消费结构化 Diff 响应；非 UTF-8 时禁用行级/Hunk 级回滚，整文件丢弃仍可用。 |
| `src/lib/i18n.ts` | 新增预览、保存、编码失败和 Diff 安全提示的中英文文案。 |
| 历史/Replay/配置读取 | 已确认无关：固定 UTF-8 内部契约，不改。 |
| Worktree Snapshot/恢复 | 已确认不扩展：保留原 Patch 生成与比较链路，不消费 UI 转码结果。 |

## 共享编解码模块

新增 `src-tauri/src/text_encoding.rs`，只负责用户项目文本：

- `DetectedText { content, encoding, has_bom, guessed }`。
- `decode_text(bytes)`：自动检测并严格解码。
- `encode_text(content, encoding, has_bom)`：按原编码严格回写。
- `decode_with_encoding(bytes, encoding)`：Git Diff 已确定编码后的分片解码。

稳定错误码：

- `binary_file`
- `text_encoding_unknown`
- `text_decode_failed`
- `text_encoding_unmappable`
- `unsupported_text_encoding`

## 检测顺序

1. UTF-8 BOM、UTF-16 LE BOM、UTF-16 BE BOM。
2. 严格 UTF-8；纯 ASCII 归为 UTF-8。
3. NUL 和异常控制字符检查，拒绝明显二进制。
4. `chardetng` 猜测传统编码。
5. `encoding_rs` 严格解码；解码后再次检查文本控制字符比例。

MVP 的 UTF-16 以 BOM 为确定依据，不猜测无 BOM UTF-16。无 BOM UTF-16 与二进制字节存在歧义，且本期没有手动编码覆盖入口。

## 保存保真

- 新增 `file_read_project_text`，返回 `content/sizeBytes/encoding/hasBom/guessed`。
- 前端把 `encoding/hasBom` 保存在每个打开文件自己的状态中，不做全局或项目级持久化。
- 新增 `file_write_project_text` 接收编码元数据，后端校验标签后编码。
- 原 `file_read_text` / `file_write_text` 的签名和 UTF-8 契约保持不变，避免把自动编码检测扩散到 Replay Snapshot、同步上下文等内部数据。
- UTF-8 和传统编码使用严格编码；UTF-16 使用标准库 `encode_utf16` 手动输出 LE/BE 字节。
- 原编码无法表示新字符时返回 `text_encoding_unmappable`，不替换成 `?`，不自动转 UTF-8。
- 保存失败不更新 `savedContent`，关闭流程不得继续关闭文件。

## 搜索复用

内容搜索继续保留现有目录、扩展名、文件大小和结果数量限制，只把 `String::from_utf8` 替换为共享严格解码。二进制、无法识别或无法严格解码的文件继续跳过，不把单个坏文件升级为整次搜索失败。

## Git Diff 与 Snapshot 隔离

`format_diff_to_text_allow_empty` 当前影响 12 个符号，并进入 `git_get_worktree_snapshot` 执行流程。该函数不直接改成“转码后字符串”。

新增独立 UI Diff 格式化路径：

1. 首次遍历 libgit2 Diff，收集正文原始字节并检测文件编码。
2. UTF-8 Diff 继续使用现有 Patch 字符串，允许行级/Hunk 级回滚。
3. 非 UTF-8 Diff 仅为 UI 解码正文，返回 `{ content, canRevertHunks: false }`。
4. Diff Viewer 仍允许整文件丢弃、暂存和取消暂存；隐藏行选择与 Hunk 回滚，并显示安全提示。
5. `build_worktree_patch`、Snapshot 比较、恢复和 fork 继续调用原有 Patch 格式化函数，不读取 UI Diff。

未跟踪文件直接用共享解码器读取并构造“全新增”展示 Diff；其状态本来就不支持行级/Hunk 级回滚。

## 前端类型策略

GitNexus 将 `src/lib/types.ts::ProjectTextFilePayload` 判为 CRITICAL（118 个影响符号），但直接源码检索确认该接口实际只在 `fileExplorerStore.ts` 使用；风险来自图谱把整个共享 `types.ts` 的 import 扩散到所有导入者。

为控制范围，本次不修改 `src/lib/types.ts`：

- 文件读取扩展响应在 `fileExplorerStore.ts` 定义局部交叉类型。
- Git Diff 响应在两个消费组件内定义同形局部类型。
- `ActiveProjectFile` 是 store 内部接口，新增编码字段的实际构造和消费均局限于该文件。

## 场景矩阵

| 维度 | 覆盖方式 |
| --- | --- |
| 编码 | UTF-8、UTF-8 BOM、UTF-16 LE/BE BOM、GBK、常见传统编码、未知编码、二进制。 |
| 保存 | 内容可映射、含不可映射字符、保留/不带 BOM、保存失败后继续保持 dirty。 |
| 文件入口 | 预览、外部刷新重读、内容搜索、Git Diff。 |
| Git 状态 | 未跟踪、新增、修改、删除；UTF-8 可局部回滚，非 UTF-8 仅安全展示与整文件操作。 |
| 项目位置 | 主仓库、Worktree、Windows 本地路径、WSL UNC；复用现有路径解析，只处理读取到的字节。 |
| Workspan/分屏 | 编码元数据跟随单个 `ActiveProjectFile`，不依赖当前终端、Workspan 或分屏焦点。 |
| 内部数据 | 历史、Replay、Snapshot、配置明确不进入自动检测。 |

## 依赖

- `encoding_rs = 0.8.35`
- `chardetng = 1.0.0`

不引入二进制检测依赖，少量检测规则放在共享模块内。

## 风险

- 传统编码检测是启发式，且用户已选择不提供手动纠正入口；错误检测只能通过严格解码和文本特征校验降低，不能完全消除。
- 非 UTF-8 Diff 展示文本不是可直接应用的原始 Patch，因此必须禁用局部 Patch 操作。
- 依赖变更会修改 `src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock`。
- 不启动 Tauri/dev/build，只执行类型检查、Rust 检查和单元测试。
