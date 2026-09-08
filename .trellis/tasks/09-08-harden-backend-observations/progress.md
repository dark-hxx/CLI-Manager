# Progress

## 根因归类

- 集合遍历误用短路谓词，造成后续元素未处理。
- timeout 只包围 wait，未覆盖 stdin/write/pipe drain；读取上限在 metadata 检查后仍有 TOCTOU。
- 文件恢复和多 Home 切换缺少“先验证、后写入、终态清理”的事务边界。
- 协议解析以字符串前缀、lossy chunk 或 UTF-8 字节切片替代结构化/字节安全处理。
- 测试名称、夹具与实际路径不一致，导致容量/隔离保证被高估。

## 已实施

- 完成 `ledger.md` 的逐项映射；桌宠问题按用户指示明确排除。
- 完成脱敏、备份恢复、路径/symlink、Provider global、同步输出、WSL deadline、daemon HTTP/SSE、Hook、Capability、Codex proxy、建议服务和脚本边界等高置信修复。
- 对需要公开 IPC/持久化协议、真实 Unix/WSL/SSH 环境或跨存储事务设计的项目保留独立后续状态。

## 验证记录

- Provider global 26 项、Hook settings 38 项、OpenCode 12 项、command suggestion 13 项、agent-capabilities-core 13 项通过。
- daemon server 25 项及各新增定向回归测试通过；`cargo check --lib` 与 SSH agent check 通过。
- 改动 Rust 文件经 `rustfmt --check` 通过，Rust library 全部测试目标成功编译；普通与 strict 架构检查均为 946 个源文件、0 个超限、0 个新违规，`git diff --check` 通过。
- 全仓 `cargo fmt --all -- --check` 会报告基线已有格式差异，因此未执行会改写大量无关文件的全量格式化；改为只格式化并复检本次 Rust 改动文件。
- GitNexus `detect_changes` 识别 38 个代码文件、175 个变更符号，风险为 medium；列出的 5 条受影响流程来自 `pending_journal` 的跨社区模糊映射。实际 diff 不包含 desktop-pet 文件。
