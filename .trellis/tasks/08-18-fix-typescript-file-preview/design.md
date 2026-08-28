# 技术设计

## 根因陈述

文件预览的前端、本地 Rust 后端和 SSH Agent 各自按扩展名把 `ts` 判为视频，导致 TypeScript 文件在进入既有文本解码器之前被拒绝；修复必须同时落在三处分类源头以保持本地与 SSH 行为一致。

## 数据流

```text
文件树选择 .ts
  → loadProjectFile / previewGuardError（前端）
  → 本地 file_read_project_text / SSH sshRemoteReadFile
  → is_video_path / is_video（Rust）
  → 既有文本解码或二进制拒绝
  → FileEditorContent 文本预览
```

移除三个集合中的 `ts` 后，TypeScript 文件会到达现有文本解码器；图片、大小和编码限制不变。

## 改动边界

- `src/stores/fileExplorerStore.ts`：从 `VIDEO_EXTENSIONS` 移除 `"ts"`，保留前端 1 MiB/图片大小预检查。
- `src-tauri/src/commands/fs.rs`：从 `is_video_path` 的匹配列表移除 `"ts"`，使 `file_read_project_text` 可读取 TypeScript 内容。
- `src-tauri/ssh-agent/src/files.rs`：从 `is_video` 的匹配列表移除 `"ts"`，使 SSH 文件读取返回文本。
- 仅扩展同文件的既有单元测试；不新增测试框架或依赖。
- 不变更 Tauri command 签名、前端类型、错误码或 i18n。

## 兼容性与风险

- `.mp4`、`.mkv` 等其他视频扩展名仍按原规则拒绝。
- 真正使用 `.ts` 扩展名的 MPEG-TS 文件不再享有扩展名预拦截；本任务不新增媒体探测，现有二进制/文本解码保护仍是最后防线。
- 回退点明确：恢复三处列表中的 `ts` 及两个回归断言即可，无数据迁移。

## 发现清单

- [x] `src/stores/fileExplorerStore.ts`：根因所在的前端预检查与本地/SSH 分支；需要修改。
- [x] `src-tauri/src/commands/fs.rs`：本地 `file_read_project_text` 的视频分类；需要修改并补充测试。
- [x] `src-tauri/ssh-agent/src/files.rs`：SSH `read` 的视频分类；需要修改并补充测试。
- [x] `src/components/files/FileEditorContent.tsx`：仅渲染 unsupported 状态；确认不修改。
- [x] `src/lib/i18n.ts`：仅提供现有错误文案；确认不修改。
- [x] `.trellis/spec/backend/project-file-command-contracts.md`：补充前端、本地与 SSH 视频分类一致性和 `.ts` 回归要求。
- [x] `.trellis/spec/guides/cross-layer-thinking-guide.md`：补充跨层重复文件类型分类的检查项。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：仓库交付记录；需要修改。

## 影响分析

- GitNexus 索引停在提交 `7e03d95`，当前为 `8fa77b2`，MCP 无法解析三个当前符号，影响分析结果为 `UNKNOWN`。
- 未重建索引：分析工具会生成/更新当前已脏的 `AGENTS.md` 与 `CLAUDE.md`，不应覆盖用户未提交内容。
- 已按分诊规范降级为契约与源码发现清单；实际影响面限定为一个前端预检查、本地读取命令和 SSH Agent 读取命令，风险评估为中等，需以本地与 SSH 回归测试覆盖。
