# 修复 SSH Agent 能力更新后远程文件删除误报

## Goal

修复远端 `cli-manager-ssh-agent` 原地升级后，Host SFTP 删除仍提示缺少
`fileDelete` 能力的问题，使当前操作使用重新协商后的 Agent 能力，同时不降低远程文件删除的路径安全边界。

## Background and confirmed facts

- 用户已在远端手动更新 Agent；设置页的一次性 `ssh_agent_probe` 显示 Agent `0.1.13`、协议 `1.14`。
- Host SFTP 删除通过 `ssh_remote_file_delete` → daemon `fileDelete` → SSH Agent Readonly/Primary bridge。
- Agent `0.1.13` 的 `hello` 能力列表和 daemon 请求白名单都已包含 `fileDelete`；远端删除实现也已存在。
- 设置页探测是一次性 SSH 进程，而 SFTP 请求会复用已建立的 daemon bridge。
- `bridge_identity` 只包含 Agent 路径和安装身份等连接字段，不包含远端二进制实际版本/摘要；原地替换同一路径的 Agent 不会使现有 bridge identity 变化。
- bridge 在握手时只保存一次 capabilities；当前 `handle_agent_request` 遇到缺少能力时仅向请求返回错误，不会关闭该旧 bridge。因此旧 bridge 会持续报告缺少 `fileDelete`。
- 本任务是跨层行为回归，修复位置应在 daemon bridge 生命周期/能力协商边界，而不是在删除按钮或错误文案处增加绕过。

## Root-cause statement

daemon bridge 生命周期边界未把“能力协商结果失效”视为可刷新状态，导致 Agent 原地升级后仍复用旧进程及旧 capabilities；修复必须在 bridge 请求调度层安全失效并重建旧 bridge，再由新握手决定能力。

## Discovery list

- [x] `src-tauri/src/daemon/ssh_agent_bridge.rs`：bridge identity、bridge entry 复用、能力门控、请求调度和 consumer 生命周期。
- [x] `src-tauri/src/commands/ssh_files.rs`：Host SFTP 删除 Tauri command 保持现有签名和输入校验。
- [x] `src/lib/sshRemoteFiles.ts`：远程删除 IPC 调用保持现有契约。
- [x] `src/components/settings/pages/SshHostAttachmentDialog.tsx`：删除确认和错误展示保持现有安全/本地化行为。
- [x] `src-tauri/ssh-agent/src/protocol.rs`：确认 Agent `fileDelete` capability 与实现已存在，本任务不重复修改协议。
- [x] `.trellis/spec/backend/ssh-agent-contracts.md`：遵守 protocol 1.14 能力协商、Host SFTP 删除和 bridge 生命周期契约。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：交付前记录 V1.3.9 的修复。
- [x] 已搜索相关旧任务/会话：先前 `ssh-agent-v0.1.13` 发布包含 `fileDelete`，本问题发生在 Agent 原地更新后的 bridge 状态同步。

## Requirements

### R1. 能力缺失触发一次安全刷新

当活动 bridge 在向 Agent 写入具体请求前，根据握手 capabilities 判定缺少所需能力时，daemon 必须让该 bridge 失效并重新建立一次连接/握手，然后重新调度原请求。

- 重试上限为每个请求一次，避免旧 Agent 永久不支持某能力时形成重连循环。
- 缺能力检查仍发生在写入 Agent frame 之前；首次失败不会执行远端操作，因此 `fileDelete` 重试不会重复删除。
- 若刷新后的 Agent 仍不支持能力，继续返回原有稳定错误 `ssh_agent_capability_missing:<capability>`。
- 刷新必须只失效产生该响应的 bridge entry，不误删同 Host 的其他 lane/其他连接；被替换的 bridge 仍按现有 shutdown/reap 规则结束。

### R2. 不改变既有边界

- `ssh_remote_file_delete` 的 Tauri command 签名、root/path 校验、确认 UI 和 i18n 文案保持不变。
- 不把删除降级为 shell/rm 或绕过 Agent capability；不修改 root 不能删除、symlink、路径穿越和非空目录保护。
- 上传、下载、列表、历史、Git 等其他请求沿用现有 lane 和能力门控，并共享同一刷新机制；无能力刷新时最终错误语义保持兼容。

### R3. 回归覆盖

增加 Rust 单元测试覆盖：能力缺失在 frame 写入前返回、bridge entry 能按请求所属 slot 精确失效、刷新只发生一次，以及刷新后仍缺能力时不循环。保留已有 `fileDelete` 能力映射/Agent 协议测试。

### R4. 交付记录

更新 `CHANGELOG.md` 的 `V1.3.9` 条目和 `docs/功能清单.md` 的 SSH/远程文件功能板块；不提交或推送 Git。

## Scenario matrix

| 场景维度 | 覆盖要求 |
|---|---|
| Agent 状态 | 未升级旧 Agent、原地升级后已有旧 bridge、原地升级后尚未建立 bridge、当前 Agent 已支持能力 |
| bridge lane | Primary 复用、Readonly 独立 bridge、Git lane 不被误失效 |
| 请求类型 | `fileDelete` 变更请求、`fileGet`/`filePut`/列表等只读或传输请求、能力仍缺失的请求 |
| 并发/生命周期 | 同 Host 多 consumer、刷新期间旧 bridge 被停止、请求队列关闭/连接失败、应用重启后新 bridge |
| 认证/传输 | SSH Config、Agent、identity file、credential reference、ProxyJump/ProxyCommand 的现有连接生成不变 |
| UI/环境 | Host-only SFTP、SSH 项目文件面板、终端附件相关请求；Local/WSL 不进入该 daemon bridge 路径 |
| 删除安全性 | 普通文件、空目录、root、路径穿越、symlink、非空目录；刷新不得放宽任何一项 |

## Acceptance Criteria

- [ ] 远端 Agent 原地升级为支持 `fileDelete` 后，在不重启桌面应用/不重新打开 SSH Host 的情况下，首次点击删除即可重新握手并成功删除合法目标。
- [ ] 远端 Agent 仍不支持 `fileDelete` 时，最多刷新一次后显示原有升级提示，不产生重连死循环，远端目标不变。
- [ ] 刷新只替换产生能力错误的 bridge；Primary/Readonly/Git 的隔离、consumer 生命周期和既有重连规则保持有效。
- [ ] 删除 root、穿越路径、symlink、非空目录仍被 Agent/daemon 拒绝，且刷新过程不执行任何未授权删除。
- [ ] 新增回归测试通过；`cargo check`、桌面端相关 Rust 测试、Agent 测试、`npx tsc --noEmit`、`git diff --check` 通过。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已按 `V1.3.9` 更新；不包含无关 `AGENTS.md`、`CLAUDE.md` 修改，不提交、不推送。

## Out of scope

- 不改 Agent 协议版本、Agent 二进制功能或发布 tag。
- 不新增 UI“重启 Agent”按钮，不要求用户手动重启桌面端。
- 不改变 Host SFTP 目录配置、上传/下载交互或文件浏览器视觉设计。
