# 文件预览多编码文本兼容实施计划

## Step 1：共享编码核心与依赖

- 在 `src-tauri/Cargo.toml` 增加 `encoding_rs 0.8.35`、`chardetng 1.0.0`，更新 lockfile。
- 新增 `src-tauri/src/text_encoding.rs` 并在 `src-tauri/src/lib.rs` 注册模块。
- 实现 BOM、严格 UTF-8、二进制检查、传统编码猜测、严格解码和严格回写。
- 单测覆盖 UTF-8/BOM、UTF-16 LE/BE BOM、GBK、二进制和不可映射字符。

## Step 2：文件预览、编辑与保存

- 新增 `ProjectTextFilePayload`，返回编码、BOM 和猜测标记。
- 新增 `file_read_project_text` / `file_write_project_text` 供用户项目编辑器使用。
- 保持原 `file_read_text` / `file_write_text` 严格 UTF-8 契约，继续服务内部 Replay/同步文件。
- `fileExplorerStore` 保存编码元数据，映射稳定错误码并国际化预览/保存 toast。
- `FileEditorPane` 捕获保存失败，保证 dirty 状态和关闭确认框不被错误清除。

## Step 3：文件内容搜索

- `collect_content_matches` 复用共享解码器。
- 无法识别、二进制或严格解码失败的单文件继续跳过。
- 增加 GBK 搜索命中测试，回归目录/大小/结果数量限制。

## Step 4：Git Diff 安全展示

- 未跟踪文件使用共享解码器生成全新增 Diff。
- 新增 UI 专用 Diff payload 和格式化函数。
- UTF-8 保持原 Patch 且允许局部回滚；非 UTF-8 只解码展示并标记不可局部回滚。
- `DiffViewerModal` 对非 UTF-8 隐藏行选择/Hunk 回滚，保留整文件丢弃。
- `FileEditorPane` 适配结构化 Diff 响应。
- `build_worktree_patch`、Snapshot/恢复/fork 保持原函数和数据流。

## Step 5：文案与变更记录

- 在 `src/lib/i18n.ts` 同步新增 zh-CN/en-US 文案。
- 在 `CHANGELOG.md` 的 `[TEMP]` 追加多编码文本兼容说明，保留已有未提交内容。

## Step 6：验证

- `npx tsc --noEmit`
- `cd src-tauri && cargo test text_encoding --lib`
- `cd src-tauri && cargo test commands::fs::tests --lib`
- `cd src-tauri && cargo test commands::git::tests --lib`
- `cd src-tauri && cargo check`
- `gitnexus_detect_changes(scope: all)`，核对只影响文件浏览、搜索和 UI Diff，Snapshot/恢复流程无意外变化。

## 预计修改文件

| 文件 | 修改内容 |
| --- | --- |
| `src-tauri/Cargo.toml` | 新增两个纯 Rust 编码依赖。 |
| `src-tauri/Cargo.lock` | 锁定依赖版本。 |
| `src-tauri/src/lib.rs` | 注册共享编码模块。 |
| `src-tauri/src/text_encoding.rs` | 新增编解码、检测和单测。 |
| `src-tauri/src/commands/fs.rs` | 预览、保存、内容搜索接入共享编码。 |
| `src-tauri/src/commands/git.rs` | 非 UTF-8 Diff 展示与 Snapshot Patch 隔离。 |
| `src/stores/fileExplorerStore.ts` | 保存编码元数据和错误提示。 |
| `src/components/files/FileEditorPane.tsx` | 适配 Diff payload，保存失败不继续关闭。 |
| `src/components/git/DiffViewerModal.tsx` | 适配 Diff payload并禁用不安全的局部回滚。 |
| `src/lib/i18n.ts` | 中英文文案。 |
| `CHANGELOG.md` | `[TEMP]` 变更记录。 |

## 验收重点

- `.cs` 等非 UTF-8 源码能打开、编辑、搜索和查看 Diff。
- 保存后编码/BOM 不变。
- 输入原编码无法表示的字符时保存失败，磁盘文件不变，编辑器仍为未保存状态。
- 非 UTF-8 Diff 可读，但局部 Patch 操作不可用；整文件 Git 操作正常。
- Snapshot/恢复不消费转码后的 UI Diff。
