# 技术设计

## 数据流

```text
打开 CLI 集成 / Manifest URL / allowHttp / 当前 Agent 版本变化
  → invoke ssh_agent_available_release
      → bundled_agent_release_dir + fetch_verified_release（无 SSH）
      → install_action(current, incoming)
  → UI：可用版本；仅 action=upgrade 显示更新条
  → 按下「更新」
      → 现有 ssh_agent_install_preview（需要 SSH）
      → 确认后 ssh_agent_install
```

## 边界

- 新 IPC 只解析签名发布，不接收 SSH spec，不探测远端环境。
- 比较源：`probeResult.agentVersion` 优先，否则 `installation.agent_version`。
- 真正升级仍必须走现有 preview/install；UI 不得直接调用 install。
- 复用 `fetch_verified_release` 与 `install_action`，不复制验签或版本比较。
- GitNexus 不可用：触点来自 ssh-agent-contracts + grep。

## 发现清单

- [x] `src-tauri/src/commands/ssh.rs`：新增 `ssh_agent_available_release`，复用 supply chain。
- [x] `src-tauri/src/lib.rs`：注册 command。
- [x] `src-tauri/src/ssh_agent_supply_chain.rs`：确认不改 bundled-first / 验签。
- [x] `src/lib/types.ts`：新增 `SshAgentAvailableRelease`。
- [x] `src/lib/sshAgentRelease.ts`：升级提示纯函数。
- [x] `src/components/settings/pages/SshCliIntegrationDialog.tsx`：自动检查 UI 与更新按钮。
- [x] `src/lib/i18n.ts`：中英文案。
- [x] `.trellis/spec/backend/ssh-agent-contracts.md`：补 IPC 契约。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：TEMP 交付记录。
- [x] 确认不编辑 `ssh_agent_probe` / Hook 安装 / 桌面 updater。

## 风险与回退

- 开发态可能没有完整 bundled Agent：行为与安装预览相同，回退网络源；失败暴露真实错误。
- 自定义 Manifest 输入过程会触发检查：300ms debounce，取消过期请求。
- 回退：删除新 command 与对话框检查 effect，不影响既有探测/安装。
