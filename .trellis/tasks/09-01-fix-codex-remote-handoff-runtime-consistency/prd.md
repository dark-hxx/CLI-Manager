# Fix Codex remote handoff runtime consistency

## Goal

修复本地 Codex 会话托管后可恢复目标 `cliSessionId`、但消息在 `turn/start` 后长期无回复的问题。远程平台只承担消息入口和结果出口；托管期间由 cc-connect 启动的 Codex app-server 必须使用与本地会话相同来源的 CLI、`CODEX_HOME`、Provider profile、模型和运行配置，不能维护一套容易漂移的 Provider 参数子集。

## Requirements

- 不修改 cc-connect 源码或用户全局安装。
- 不把完整对话上下文发送到聊天平台；继续由 Codex `thread/resume` 从本地 rollout 恢复上下文。
- 托管前必须先完成无副作用预检，随后由现有 PTY 关闭确认作为 Agent 进程所有权交接边界。
- 本地 Codex 项目登记的 CLI 可执行文件和安全启动参数继续作为 app-server 的真实 launcher；持久化的 `resume`/Session 参数不得进入 app-server launcher。
- 项目登记 Provider 必须使用 Native Provider 域生成的同一完整 Codex profile，不再由远程链路单独挑选快速模式、压缩或其他业务配置。
- app-server 仍使用显式 Provider/模型/模型目录覆盖锁定项目登记值，防止 cc-connect 配置或会话状态漂移。
- 开启 cc-connect 日志时，提供不含密钥和用户消息正文的 app-server 阶段诊断；关闭日志时不得增加可见日志噪声。
- Telegram、飞书、微信和企业微信共享同一修复，不增加平台专有分支。
- SSH Codex 托管、Claude/Pi/OpenCode 托管行为保持兼容，不把本地 Provider profile 注入 SSH。
- 取消托管仍先释放 cc-connect 所有权，再通过 CLI-Manager 当前 Provider 解析恢复本地会话。

## Acceptance Criteria

- [x] 本地 Codex Provider profile 中除连接地址/密钥/模型以外的有效配置，也会被托管 app-server 加载。
- [x] app-server 将完整 Provider profile 结构化展开为 `-c` 覆盖，并在其后保留显式 Provider/模型锁定参数；普通 Codex 运行命令仍使用 `--profile`。
- [x] 未登记 Provider 的本地 Codex 托管继续使用用户当前 `CODEX_HOME/config.toml`，不注入虚假 profile。
- [x] launcher、Provider profile 和 app-server 参数的单元测试覆盖含空格 Windows 路径、无 Provider、有 Provider和普通透传命令。
- [x] 开启日志时可区分 initialize、thread/resume、turn/start、turn started/completed/error 阶段；日志不包含 prompt、文件内容、Token 或密钥。
- [x] `cargo test` 相关测试、`cargo check`、`npx tsc --noEmit` 通过。
- [x] `CHANGELOG.md` 的 `TEMP` 版本和 `docs/功能清单.md` 对应远程托管板块已更新。

## Notes

- 当前阶段不实现“保留原 PTY、直接向唯一 Agent 进程转发消息”的第二阶段架构重构。
- 当前分支相对上游领先 41、落后 0；本任务不自动同步远程。
