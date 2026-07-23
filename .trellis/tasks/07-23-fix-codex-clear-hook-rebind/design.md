# 技术设计

## 根因

CLI-Manager 依赖 Codex Hook 回传 `session_id` 维护 PTY Tab 与 CLI 会话的绑定。`/clear` 创建新会话后，如果 Codex 因 Hook 信任状态变化或 bridge 上报失败而未送达 `SessionStart`，前端只能保留旧 ID。当前安装状态没有校验 Codex 的 `trusted_hash` 是否与当前 Hook 命令一致，Hook 客户端也静默吞掉所有失败。

## 方案

1. 在 `hook_settings.rs` 中按 Codex 0.145 的规范化规则计算 CLI-Manager Hook 的当前哈希，并与 `config.toml` 对应 `[hooks.state.*].trusted_hash` 比较。
2. 任一必需 Codex Hook 未信任、被禁用或哈希过期时，将整体安装状态降为 `partialInstalled`，避免误报“已安装”。不自动写入信任哈希，保留 Codex 的安全边界。
3. 在 `hook_client.rs` 中将静默 `Option` 链改为结构化失败原因，并仅把脱敏错误追加到 CLI-Manager 日志目录。未在 CLI-Manager PTY 中运行时不记录。
4. 保留现有 `handleCliHookEvent` 的新 ID 覆盖语义，只补回归测试，不引入按项目猜测会话的兜底。

## 兼容性

- 只校验 CLI-Manager 自己写入的 Codex Hook 条目。
- 不修改 Claude/Pi Hook 状态语义。
- WSL 使用目标配置目录和现有命令路径规则计算 key/hash。
- 不自动信任 Hook；用户仍通过 Codex 的 Hook 信任流程授权。

## 风险控制

- Codex 哈希算法属于外部契约，封装为独立纯函数并使用固定样例测试。
- 失败日志不包含 token、stdin、prompt、命令全文和完整 payload。
- 日志仅在检测到 `CLI_MANAGER_TAB_ID` 后写入，并限制文件大小。
