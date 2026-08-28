# 实施计划

## 改动

- [x] 后端新增 `ssh_agent_available_release`，复用 `fetch_verified_release` + `install_action`。
- [x] 注册 Tauri command。
- [x] 前端类型、纯函数、CLI 集成自动检查与更新按钮。
- [x] i18n zh-CN / en-US。
- [x] 更新 ssh-agent 契约、CHANGELOG（TEMP）、功能清单。
- [x] Rust helper 测试与 Node 测试覆盖版本比较与升级提示。
- [x] 按审查修复：卸载后隐藏 CTA、检查开始时清掉过期结果、检查错误单独展示、preview 使用同一当前版本。

## 验证

- [x] `node --test scripts/sshAgentRelease.test.mjs`（6 passing）
- [x] `cargo check --manifest-path src-tauri/Cargo.toml --lib`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib`（1064 passed）
- [x] `cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml`（103 passed）
- [x] 真实应用：打开 CLI 集成不自动 Probe；已安装 0.1.0 时展示可用 0.1.9 与 Update；按下 Update 走预览 SSH 并显示真实连接错误

## 回滚点

- 删除 `ssh_agent_available_release` 及相关 UI/文案即可。
