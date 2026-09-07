# 实施计划：PR #224 Grok Hook 配置恢复

1. 在隔离的 PR #224 head 分支重跑 GitNexus `impact`（上游/下游）并读取 `hook_config.rs` 现有 Codex marker 与 Grok 测试，确认所有改动触点。
2. 在 `src-tauri/ssh-agent/src/hook_config.rs` 实现 Grok vendor 配置的受控安装/卸载辅助函数，接入 `plan_files` 的 `Source::Grok` 分支。
3. 添加单元测试，覆盖已有 true/false、缺失层级、混合 vendor、其他 installation、用户改写与注释保留；保留既有 JSON Hook 断言。
4. 在 PR 分支更新 `CHANGELOG.md` 和 `docs/功能清单.md` 的 `V1.3.8` 修复记录。
5. 运行 Rust 格式化、目标测试、SSH Agent crate 全量测试、diff 检查和必要的前端/后端检查；使用 GitNexus `detect_changes` 复核影响范围。
6. 提交仅属于本次修复的文件，推送 `agent/grok-ssh-hooks-history`，确认 PR head 更新后重新审核。

## 风险文件与验证

- `src-tauri/ssh-agent/src/hook_config.rs`：持久化所有权与 TOML 表清理；以完整 crate 测试和新状态矩阵测试验证。
- `CHANGELOG.md`、`docs/功能清单.md`：按项目交付记录规则检查格式与归属。
- 回滚点：若 marker 格式影响已有 Codex 解析，撤回对通用解析器的扩展，改为 Grok 专用且向后兼容的 marker 解析。
