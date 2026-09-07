# 实施计划

## 实施步骤

- [x] 在 `src/stores/fileExplorerStore.ts` 的 `VIDEO_EXTENSIONS` 中删除 `"ts"`。
- [x] 在 `src-tauri/src/commands/fs.rs` 的 `is_video_path` 中删除 `"ts"`，在现有视频限制测试中断言 `src/main.ts` 可读。
- [x] 在 `src-tauri/ssh-agent/src/files.rs` 的 `is_video` 中删除 `"ts"`，补充 SSH `read` 返回文本的回归断言。
- [x] 在 `CHANGELOG.md` 的 `V1.3.7` 下新增“文件预览”条目。
- [x] 在 `docs/功能清单.md` 的“文件浏览器搜索与菜单”中记录 TypeScript 预览修复。
- [x] 在项目文件命令契约和跨层检查清单记录该扩展名冲突的预防规则。

## 验证

- [x] `npx tsc --noEmit`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml preview_limits_reject_video_and_oversized_image_dimensions`
- [x] `cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml read_rejects_video_before_reading_content`
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`
- [x] `cargo check --manifest-path src-tauri/ssh-agent/Cargo.toml`
- [x] 两个 Rust package 的 `cargo fmt --check`
- [x] `gitnexus_detect_changes(scope: "all")`：索引过期但已识别两处测试模块、无受影响流程，风险为 LOW；另以 `git diff` 核对目标文件。
- [x] `git diff --check` 与三处视频列表的 `rg` 核查。

## 变更控制与回退

- 不触碰现有脏文件：`AGENTS.md`、`CLAUDE.md`、`.research-cherry*`、`.tmp-openai-codex`。
- 不重建 GitNexus 索引，避免自动生成过程覆盖上述用户文件。
- 若任何验证失败，停止扩展修改，保留失败输出并回到对应单一改动点。
- 回退只恢复三处 `ts` 视频分类及本次测试、文档记录；无配置或数据回滚。
