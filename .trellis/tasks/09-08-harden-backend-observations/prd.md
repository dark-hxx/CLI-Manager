# 实施后端可靠性与安全加固

## Goal

将注释扫描记录的超时、容量、事务、路径、脱敏、协议和测试覆盖建议转化为分阶段可验证的加固工作。

## Requirements

- **资源与生命周期边界**：限制 Codex proxy pending resume、Live Server 任务/通道、Git/SSH 候选集合和协议 undecided buffer；订阅替换时可靠停止旧线程；清理 detach 后遗留流控状态。
- **阻塞与超时边界**：为 WSL stdin、Command output、daemon writer/queue、WebSocket 首帧、SSH pipe/join、Hook stdin/listener、建议列表和文件读取建立可测试的期限或取消路径；期限必须覆盖写入阶段而非只覆盖响应等待。
- **读取与响应容量**：消除 metadata-before-read 的增长竞态；限制首行 JSON、profile/capability 文件、HTTP 非流式错误体、dev-server probe 和外部命令输出；SSE 正确处理 CRLF 与长期不决缓冲。
- **原子性与恢复**：snapshot/outbox 使用临时文件原子替换；provider batch/global apply/import/issue resolution 明确部分提交语义或提供补偿；数据库备份检查 WAL checkpoint busy 结果并避免名称碰撞；恢复前验证备份指纹。
- **路径与文件安全**：显式路径验证处理 canonical/link 语义和配置根绑定；SSH 下载写入前复验；背景图目标类型、扩展名与 symlink 清理边界明确；文件 copy/move 保留 symlink 身份且防 TOCTOU。
- **脱敏与日志安全**：crash JSON 按敏感键脱敏；Hook 完整 payload、WSL stderr、HTTP provider 错误和建议错误在日志/返回前统一净化；验证不会记录真实凭据。
- **配置完整性**：补齐 JSON/TOML 数组、inline table 和 table array 的 secret preservation；区分外层 JSON 合法与运行就绪；CLI capability fingerprint 包含 Skill 文档；frontmatter 必须闭合。
- **协议与身份一致性**：Origin 使用 URL 解析精确校验；SSH bridge identity 纳入 `config_file`，claim release 包含 `host_id`；readonly 通道权限语义与写操作分离；shutdown ACK 反映活跃会话状态。
- **平台与命令一致性**：Windows/macOS/Linux 文件定位语义一致；Git/WSL/外部终端超时一致；同步 remote dir、backup filename 与 URL decoding 规则形成严格输入契约。
- **测试真实性**：修正或加强只验证测试局部实现、未创建 symlink、未比较源数据库、使用 unknown event、可能触达真实 WSL/控制目录/信任库的测试；危险测试默认隔离或显式 opt-in。
- **可观测语义**：区分配置“可解析”“已启用”“运行就绪”，区分 proxy 响应与 API 成功，区分 rollover threshold 与硬上限，并确保注释、返回字段和 UI 消费方不误解。
- 对每个加固点先记录威胁/故障模型、现状证据、兼容影响与验证方法；无法安全自动验证的平台项允许形成独立后续项，但不得静默标记完成。

## Acceptance Criteria

- [ ] `observations.md` 中所有非确认缺陷观察均映射到上述工作流及逐项处置台账。
- [ ] 所有不可信读取、响应和缓冲都有明确上限，或有书面且经评审的豁免理由。
- [ ] 所有可能阻塞的子进程/管道/网络阶段都有覆盖完整阶段的 deadline/cancel 行为和测试。
- [ ] 持久化写入与恢复在失败注入下不会静默丢失旧数据或报告虚假 committed 状态。
- [ ] 路径、链接、身份与权限检查在本地/WSL/SSH/Worktree 场景下遵循同一明确契约。
- [ ] 日志、crash context 和外部错误不会泄漏测试用敏感标记。
- [ ] 危险平台测试不会默认访问真实用户数据或环境，测试名称与实际断言一致。
- [ ] 每批改动通过对应定向测试、crate 编译、格式化和严格架构检查。

## Scenario Matrix

- Runtime：Windows 本地、WSL、Unix、SSH remote。
- Workspace：主仓库、linked worktree（`.git` 为文件）、目标/链接缺失。
- Process：正常完成、写入阻塞、无响应、超大输出、子孙进程持有 pipe。
- Persistence：单写入、多目标部分失败、WAL busy、崩溃重启、备份损坏。
- Hooks/providers：各 Hook 安装组合、通知共享、启用但无有效 key、错误响应包含敏感标记。

## Out of Scope

- 修改公开 IPC/持久化格式，除非后续设计证明兼容方案并单独评审。
- 用无限重试、吞错或默认成功掩盖边界失败。
