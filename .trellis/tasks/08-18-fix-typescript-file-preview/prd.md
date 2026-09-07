# 修复 TypeScript 文件预览误判

## 目标

让本地项目和 SSH 项目中的 TypeScript `.ts` 文件按文本文件读取并预览，不再被错误提示为视频文件。

## 背景与已确认事实

- 用户确认：项目源码中的 `.ts` 不是视频，应作为 TypeScript 文本处理。
- 前端 `src/stores/fileExplorerStore.ts:432-437`、本地 Rust `src-tauri/src/commands/fs.rs:1124-1151`、SSH Agent `src-tauri/ssh-agent/src/files.rs:805-832` 都把扩展名 `ts` 列为视频。
- 文件选择后，前端的 `loadProjectFile` 会先执行 `previewGuardError`；通过后才调用本地 `file_read_project_text` 或 SSH `sshRemoteReadFile`。两条后端路径又各自执行视频扩展名判断，因此只改一处不能修复全部场景。
- 现有本地和 SSH 测试均已覆盖 `.mp4` 在读取前被拒绝，但没有覆盖 TypeScript `.ts`。
- 用户指定交付记录版本：`V1.3.7`。

## 范围

### 包含

- 从前端、本地 Rust、SSH Agent 三处视频扩展名集合中移除 `ts`。
- 为本地与 SSH 读取链路添加 TypeScript `.ts` 可读的回归测试，同时保持 `.mp4` 的拒绝测试。
- 在 `CHANGELOG.md` 的 `V1.3.7` 和 `docs/功能清单.md` 的“文件浏览器搜索与菜单”板块记录修复。

### 不包含

- 不新增 MIME、文件头或媒体内容探测。
- 不变更 IPC 命令、文件大小上限、文本编码策略、i18n 文案或项目文件访问权限。
- 不承诺将真正的 MPEG-TS 媒体文件作为可预览对象；其二进制/解码保护维持现有行为。

## 需求

- 本地项目中的 `src/main.ts` 必须进入 `file_read_project_text` 文本读取链路。
- SSH 项目中的 `src/main.ts` 必须进入 SSH Agent 的文本读取链路。
- `.mp4` 等现有视频扩展名仍必须在读取文件内容前返回 `video_preview_unsupported`。
- 三层对 `.ts` 的分类必须一致，避免前端放行后被任一后端路径再次拒绝。

## 验收标准

- [x] 本地 Rust 回归测试证明 `.ts` 可读取、`.mp4` 仍被拒绝。
- [x] SSH Agent 回归测试证明 `.ts` 返回文本内容、`.mp4` 仍被拒绝。
- [x] `npx tsc --noEmit` 通过。
- [x] `cargo test`（本地后端与 SSH Agent 的相关测试）和 `cargo check` 通过。
- [x] `CHANGELOG.md` 和 `docs/功能清单.md` 均记录 `V1.3.7` 的本次修复。

## 已解决的决策

- `.ts` 在本产品的文件预览中优先表示 TypeScript 源码；不按 MPEG-TS 视频扩展名提前拦截。
- 采用最小修复：删除三个重复拦截点中的 `ts`，不引入内容探测或新依赖。
