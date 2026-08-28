# 桌面宠物远程托管多 Agent 适配 - Implementation Plan

用户已确认方案，任务已进入实施与验证阶段。

## Phase 1 - 契约与纯逻辑

- [x] 运行 GitNexus impact；若仍不可用，按已记录降级使用契约、`rg` 和源码调用点复核。
- [x] 在前端定义 `RemoteHandoffAgent`，用 `resolveAgentRuntimeKind()` 实现统一解析。
- [x] 扩展 request/info/eligibility 类型，替换 `codex_only`。
- [x] 增加纯逻辑测试：四类 Agent、Grok、普通终端、项目/命令冲突、WSL、SSH 非 Codex。
- [x] 保持桌宠现有平台 -> 会话流程，仅在候选卡补 Agent/能力信息。

验证：`node scripts/remoteHandoff.test.mjs`、`npx tsc --noEmit`。

## Phase 2 - cc-connect Agent 配置

- [x] 扩展 Rust `CcConnectAgent` 与表驱动 config type/mode/backend/RPC 映射。
- [x] 修正登记项目 `cli_tool` 解析，未支持类型不再默认 Claude。
- [x] 让 Pi 只在其配置序列化 `rpc=true`；OpenCode 使用原生 type/mode。
- [x] 增加配置快照测试，确认 Codex 现有字段不变且 Grok/普通项目不进入托管。

验证：相关 Rust 单测、`cargo fmt --check`、`cargo check`。

## Phase 3 - 托管记录、Session 与 Hook

- [x] 托管 IPC 和后端请求显式传 Agent，后端根据登记项目重新校验。
- [x] schema v2 增加 Agent/可选 Provider 快照所有权；v1 默认迁移 Codex。
- [x] Session 注入动态写 `claude/codex/pi/opencode` agent type。
- [x] Hook 归属按记录 Agent + tab/session ID 匹配。
- [x] 增加旧记录、未知版本、四 Agent 注入、跨 Agent Hook 拒绝测试。

验证：`cargo test cc_connect --lib` 中相关测试及专项测试。

## Phase 4 - Provider 与启动预检

- [x] Codex 继续走现有 `prepare_remote_codex_launch()`，先建立回归测试基线。
- [x] Claude 复用 provider scope，以结构化 `cmd` 注入 `--settings`，实现快照持有、GC 和失败释放。
- [x] Pi/OpenCode 明确跟随本地配置，禁止注入 Native Provider。
- [x] 实现 Agent 可执行文件预检；Pi 校验 RPC 配置。
- [x] 覆盖配置写入/cc-connect 启动失败的原子回滚和隐藏窗口行为。

验证：Provider 快照/命令 payload/回滚/进程启动专项 Rust 测试，检查日志不含密钥。

## Phase 5 - 取消与本地恢复

- [x] 统一安全 resume 命令构造，补 OpenCode 并复用 Pi 现有逻辑。
- [x] `resumeSessionFromRemoteHandoff()` 按记录 Agent 准备 Provider 与 PTY。
- [x] 新 PTY 成功后才清理锁与旧快照；失败保持 recovery lock。
- [x] 确认 Worktree、Shell、cwd、session ID 均来自记录/登记目标，不使用当前 UI 选中项猜测。
- [x] SSH Agent 非 Codex 继续拒绝，Codex SSH 回归不变。

验证：四 Agent 命令、Provider 分支、恢复失败、身份漂移测试。

## Phase 6 - UX、i18n 与文档

- [x] 桌宠候选/状态/蒙层显示 Agent 和 Provider/配置来源。
- [x] OpenCode 能力限制、unsupported/mismatch/unavailable 等错误覆盖 zh-CN/en-US。
- [x] 更新 `CHANGELOG.md` 的 `TEMP` 版本段和 `docs/功能清单.md` 桌宠远程托管板块。
- [x] 更新远程托管/Provider/Hook 相关契约，明确本地多 Agent 与 SSH Codex-only 边界。

验证：中英文手动切换，桌宠菜单/托管蒙层/错误提示检查，时间格式保持 24 小时制。

## Phase 7 - Quality gate and package

- [x] `node scripts/remoteHandoff.test.mjs`
- [x] `node scripts/resumeCliArgs.test.mjs`
- [x] `npx tsc --noEmit`
- [x] `cargo fmt --check`
- [x] 相关 Rust 专项测试
- [x] `cargo check`
- [x] `npm run build`
- [x] `git diff --check` 与 `git status --short`
- [x] 运行 `gitnexus_detect_changes()`；不可用时用 `git diff --stat`、符号 `rg` 和测试结果完成降级复核。
- [x] 只构建 NSIS，跳过 MSI 与更新签名，复用现有 npm/Cargo 缓存。
- [x] 报告安装包绝对路径、大小、构建结果与未执行的真实平台测试。

## Manual acceptance matrix

- [ ] Codex 本地托管/取消回归。
- [ ] Codex SSH 托管/取消回归。
- [ ] Claude 项目 Provider覆盖、全局 Provider、Worktree Provider覆盖。
- [ ] Pi RPC 默认审批/YOLO、消息、完成通知和取消恢复。
- [ ] OpenCode消息、能力限制提示、完成通知和取消恢复。
- [ ] Telegram、飞书、微信、企业微信至少验证配置生成；有凭据的平台做实际消息冒烟。
- [ ] Hook 已安装/缺失、运行中/完成/失败/未知状态。
- [ ] 多窗口、分屏、最小化/托盘与活动托管锁。
- [ ] Grok、普通终端、WSL、SSH Claude/Pi/OpenCode均保持拒绝。

## Suggested commit

```text
feat(remote-handoff): support Claude Pi and OpenCode sessions
```
