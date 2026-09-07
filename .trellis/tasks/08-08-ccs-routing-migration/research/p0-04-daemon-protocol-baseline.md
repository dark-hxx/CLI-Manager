# P0-04 Daemon 路由协议基线与 Review 记录

## 1. 实现边界

- 本 Case 只建立 daemon capability、最小控制帧、稳定错误 DTO、transport 门禁和协议回归测试。
- 未实现 routing listener、HTTP forwarder、provider snapshot、takeover writer、Tauri routing commands 或前端入口。
- `local_routing_v1` 在本阶段表示“daemon 已理解路由控制协议”；控制帧在 runtime 尚未接入时返回 `routing_service_unavailable`，不能据此宣称本地路由已可用。
- `CONTROL_PROTOCOL_VERSION` 保持 `3`，旧 daemon 通过 capability 缺失被识别，不依赖协议版本硬切换。

## 2. Capability 与 Frame 合同

| 项目 | 合同 |
| --- | --- |
| Capability | `local_routing_v1` |
| Client frames | `routing_reload { id }`、`routing_status { id }`、`routing_start { id }`、`routing_stop { id }`、`routing_reset_circuit { id, app_type, provider_id }` |
| Daemon frame | `routing_event { event: { requestId?, kind, error? } }` |
| Error DTO | `{ code, params, hint }`；`params` 仅允许白名单脱敏值 |
| Frame limit | 沿用 `MAX_FRAME_BYTES = 8 MiB`，超限在反序列化前拒绝 |
| Unknown fields | 忽略；附带的 `api_key`、`proxy_password` 或完整 provider 字段不会进入重编码帧 |
| Unknown type | parser 保留前向兼容分类，server/client 日志和返回值不得回显原始 type |

## 3. Transport 与主进程边界

| 入口 | Routing control 行为 | 原因 |
| --- | --- | --- |
| Tauri 主进程持有的 NDJSON `DaemonClient` | 允许发送；P0 runtime 未实现时返回脱敏 `routing_service_unavailable` | 后续 Tauri routing commands 完成 DB 校验和用户确认后复用此控制面 |
| WebView WebSocket `/pty` | 返回 `routing_protocol_unsupported` | 防止 WebView 绕过 Tauri command 直接 start/stop/reload/reset |
| `pty_legacy_request` | 在主进程转发前返回稳定错误码 `routing_protocol_unsupported` | 兼容 PTY relay 只服务终端控制，不升级为路由控制入口 |
| 旧 daemon 缺少 capability | 调用方使用 `ensure_local_routing_capability` 返回 `routing_feature_not_supported`，不得发 frame | 不强杀仍有 PTY 的旧 daemon |

Secret、proxy password、API key 和完整 provider document 均不属于 routing frame。`routing_reset_circuit` 只携带 app/provider identity；服务端错误不得回显这些未信任字段。

## 4. 稳定错误与双语映射

本 Case 只冻结 code/params/hint；用户可见文案在 P1 routing UI 接线时进入 `zh-CN`/`en-US` i18n。

| Code | Params / Hint | `zh-CN` | `en-US` |
| --- | --- | --- | --- |
| `routing_feature_not_supported` | `feature=local_routing_v1`；`restart_daemon` | 当前后台守护进程不支持本地路由，请重启 CLI-Manager 以升级守护进程。 | The current background daemon does not support local routing. Restart CLI-Manager to upgrade it. |
| `routing_protocol_unsupported` | `transport=websocket\|pty_legacy_request\|unknown`；`use_routing_tauri_command` | 此入口不支持路由控制，请通过“设置 -> 供应商 -> 路由”操作。 | This transport does not support routing controls. Use Settings -> Providers -> Routing. |
| `routing_service_unavailable` | 无参数；`retry_or_restart_daemon` | 本地路由服务尚不可用，请稍后重试或重启后台守护进程。 | The local routing service is unavailable. Retry later or restart the background daemon. |

## 5. GitNexus 影响基线

- `decode_daemon_frame` upstream impact：**CRITICAL**。
- 影响总数：73；direct 3；1 个执行流；6 个模块。
- 深度：d1 3、d2 53、d3 17。
- 直接风险集中在 daemon 握手、reader 分发和协议测试；因此修改后必须同时验证 protocol/server/client/discovery/terminal。
- 本 Case 不修改 listener/runtime、Tauri command 注册或 provider writer，避免把 CRITICAL blast radius 扩展到 P1 实现。
- 提交前 `detect_changes(scope=staged)`：10 个预期文件、50 个变更 symbol、0 个额外受影响 execution flow，汇总风险 low；图谱将大段 enum/test hunk 中的相邻既有 symbol 标记为 touched，已用 staged diff 与 914 个 Rust lib tests 复核为非语义修改。

## 6. 验证结果

| 命令 / 检查 | 结果 |
| --- | --- |
| `rtk cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | pass |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib daemon::protocol::tests` | 12 passed |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib daemon::server::tests` | 16 passed |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib daemon::client::tests` | 1 passed |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib daemon::discovery::tests` | 6 passed |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib commands::terminal::tests` | 3 passed |
| `rtk cargo check --manifest-path src-tauri/Cargo.toml` | pass |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib provider` | 123 passed |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml --lib` | 914 passed、1 ignored |
| `rtk npx tsc --noEmit` | pass |
| `rtk git diff --check` | pass |
| Remote baseline | branch ahead 3、behind 0 |

## 7. Review 记录

### R1 — 正确性、信任边界与回归覆盖

发现并修复：

1. 缺少旧 daemon capability 缺失用例，补 `routing_feature_not_supported` 断言。
2. WebSocket 尚可解析 routing frame，补 transport 门禁与 `routing_protocol_unsupported` 用例。
3. runtime 未实现时缺少稳定响应，补 direct dispatch 的脱敏 `routing_service_unavailable` 用例。
4. `pty_legacy_request` 缺少 routing 拒绝回归，补稳定错误码测试。
5. unknown/malformed type 可能进入 server/client 日志或错误，改为固定脱敏消息。

修复后连续零发现计数重置。

### R2 — 恢复编译与 NDJSON 安全复核

发现并修复：

1. `server.rs` 新测试缺少 `decode_daemon_frame` 和 routing error 常量导入，补齐后恢复编译。
2. WebSocket 已有未知 type 脱敏测试，但主进程 NDJSON transport 缺少同边界回归；新增真实 TCP 握手和未知 type 脱敏测试。

复验：Rustfmt 通过；server 16 tests passed。连续零发现计数再次重置。

### R3 — 控制面、安全与数据流复核

- 五组定向测试全部通过。
- WebSocket 与 legacy relay 均不能发送 routing control frame。
- routing frame 不含 key/password/provider document；unknown/malformed 生产分支不再引用攻击者 type/reason。
- 未注册 routing Tauri command、HTTP listener 或新依赖。
- 未解决发现：0；连续零发现 1/2。

### R4 — PRD/设计、回归与交付范围复核

- capability、五种控制帧、event shape、8 MiB 上限和三个稳定错误码与 PRD/design 一致。
- `CONTROL_PROTOCOL_VERSION` 仍为 3；旧 daemon 通过 feature gate 兼容。
- `cargo check`、914 Rust lib tests（1 ignored）、123 provider focused tests、TypeScript、Rustfmt 和 diff whitespace 检查通过。
- 本 Case 无用户可见 UI、平台分支、a11y、许可复制或真实 route runtime，因此不提前修改 CHANGELOG、功能清单、i18n 文件或 NOTICE。
- 远端已刷新，当前分支 ahead 3、behind 0；`AGENTS.md`、`CLAUDE.md` 为无关未提交修改，不纳入本 Case。
- 未解决发现：0；连续零发现 2/2。

R3、R4 满足连续两轮零未解决发现门槛。

## 8. 回滚与下一步

- 回滚本 Case 只需撤销 capability、routing frame/DTO、transport 门禁和对应测试；旧 daemon 继续保留原 PTY 能力。
- 本 Case 没有数据库或 Live 文件写入，无数据回滚 generation。
- 下一 Case 为 P1-01：建立 routing domain、持久化读取和 Tauri commands；用户要求本次提交 P0-04 后暂停，不进入 P1 代码实现。
