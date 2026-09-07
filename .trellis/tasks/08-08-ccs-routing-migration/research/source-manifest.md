# CCS 路由迁移证据清单

## 1. 研究目标

本文件固定本任务使用的 CC Switch（下称 CCS）版本、截图、源码与许可边界，保证后续实现和验收不会把不同版本行为混在一起。

本任务只输出规划与审批材料，当前不启动 `task.py start`，不修改产品代码。

## 2. 固定版本

| 项目 | 固定值 |
| --- | --- |
| CCS 产品版本 | `3.19.2` |
| Git 标签 | `v3.19.2` |
| Git commit | `43eaf07355af145aebfee301801779e824d4c221` |
| 上游仓库 | `https://github.com/farion1231/cc-switch.git` |
| 本地只读研究副本 | `C:\Users\Admini\AppData\Local\Temp\cc-switch-3.19.2-routing` |
| 上游许可 | MIT License，Copyright (c) 2025 Jason Young |
| GitHub 访问代理 | `127.0.0.1:7897`，仅用于必要的源码拉取/核对 |

### 安装包指纹

| 项目 | 值 |
| --- | --- |
| 路径 | `src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.4_x64-ccs-setup.exe` |
| 大小 | `19,074,821` bytes |
| SHA-256 | `493939688BE236723343ABB7A884CF12AE04AE6DE2B0C1AE13835A636B50788D` |
| 本机文件时间 | `2026-08-08 14:53:28 +08:00` |

安装包用于固定本次人工观察对象；具体运行语义以同版本 `v3.19.2` 源码为主要证据，不从文件名推断行为。

## 3. UI 截图证据

| 截图 | 用途 |
| --- | --- |
| `docs/ccs/路由菜单主界面.png` | 四个路由模块、模块标题、描述、折叠布局与运行状态入口 |
| `docs/ccs/本地路由配置详情.png` | 首页快捷开关、服务总开关、逐应用接管、监听地址、用量记录、队列健康状态和运行统计 |
| `docs/ccs/自动故障转移配置详情.png` | 首页快捷开关、逐应用队列、自动故障转移、重试/超时/熔断参数、保存与重置 |
| `docs/ccs/全局出站代理配置详情.png` | URL、用户名、密码、扫描、测试、清空、保存及代理作用范围 |
| `docs/ccs/整流器配置详情.png` | 整流总开关、四个请求整流开关及三个 Bedrock 优化器开关 |

截图只能证明用户可见字段与当时显示值，不能单独证明默认值、持久化位置或错误处理；这些信息由源码和 schema seed 补足。

## 4. 主要源码证据

### 路由页面与前端状态

- `src/components/settings/ProxyTabContent.tsx`
- `src/components/proxy/ProxyPanel.tsx`
- `src/components/proxy/ProxyToggle.tsx`
- `src/components/proxy/FailoverToggle.tsx`
- `src/components/proxy/FailoverQueueManager.tsx`
- `src/components/proxy/AutoFailoverConfigPanel.tsx`
- `src/components/settings/GlobalProxySettings.tsx`
- `src/components/settings/RectifierConfigPanel.tsx`
- `src/hooks/useProxyStatus.ts`
- `src/hooks/useGlobalProxy.ts`

### 本地路由、接管与恢复

- `src-tauri/src/commands/proxy.rs`
- `src-tauri/src/services/proxy.rs`
- `src-tauri/src/proxy/server.rs`
- `src-tauri/src/proxy/handlers.rs`
- `src-tauri/src/proxy/handler_context.rs`
- `src-tauri/src/proxy/forwarder.rs`
- `src-tauri/src/proxy/response_processor.rs`
- `src-tauri/src/proxy/providers/*`
- `src-tauri/src/claude_config.rs`
- `src-tauri/src/codex_config.rs`
- `src-tauri/src/grok_config.rs`

### 故障转移与熔断

- `src-tauri/src/commands/failover.rs`
- `src-tauri/src/database/dao/failover.rs`
- `src-tauri/src/proxy/provider_router.rs`
- `src-tauri/src/proxy/circuit_breaker.rs`
- `src-tauri/src/proxy/failover_switch.rs`
- `src-tauri/src/proxy/error.rs`
- `src-tauri/src/proxy/error_mapper.rs`

### 全局出站代理

- `src-tauri/src/commands/global_proxy.rs`
- `src-tauri/src/proxy/http_client.rs`
- `src-tauri/src/proxy/hyper_client.rs`
- `src-tauri/src/database/dao/settings.rs`

### 整流与优化

- `src-tauri/src/proxy/types.rs`
- `src-tauri/src/proxy/thinking_rectifier.rs`
- `src-tauri/src/proxy/thinking_budget_rectifier.rs`
- `src-tauri/src/proxy/media_sanitizer.rs`
- `src-tauri/src/proxy/thinking_optimizer.rs`
- `src-tauri/src/proxy/cache_injector.rs`
- `src-tauri/src/proxy/tool_media.rs`

### Schema 与默认值

- `src-tauri/src/database/schema.rs`
- `src-tauri/src/database/dao/proxy.rs`
- `src-tauri/src/proxy/types.rs`

默认值以 schema seed 和 Rust `Default` 为准。本机 CCS 数据库中的当前值属于用户态数据，不作为产品默认值证据。

### 模型映射与最终请求体

- `src-tauri/src/proxy/model_mapper.rs:119`：`apply_model_mapping` 从当前 provider 读取模型配置并改写请求体 `model`。
- `src-tauri/src/proxy/forwarder.rs:452`：每个 provider attempt 从原始客户端 body 重新 `clone`，避免前一个 provider 的优化字段泄漏。
- `src-tauri/src/proxy/forwarder.rs:1162`：当前 attempt 在转发函数内部重新执行模型映射。
- `src-tauri/src/proxy/forwarder.rs:1581`：协议处理后的 body 再应用 `local_proxy_request_overrides`。
- `src-tauri/src/proxy/forwarder.rs:3804`：上游测试明确断言 Body Override 可把 `model` 改为 override 值。

因此 CCS v3.19.2 的证据结论是“每个 attempt 从原始 body 重建并重新映射，但 Body Override 最后仍可覆盖模型”。CLI-Manager 按本任务产品要求有意增加两项约束：`source` 精确且大小写敏感、重复 `source` 保存时拒绝；Body Override 后重新执行 final model pin，使 `a -> b` 的最终上游模型始终为 `b`。这两项属于 CLI-Manager 产品契约，不伪装成 CCS 原行为。

### 端口绑定与占用

- `src-tauri/src/proxy/server.rs:100`：CCS 直接用配置中的 `listen_address:listen_port` 构造唯一监听地址。
- `src-tauri/src/proxy/server.rs:112`：`TcpListener::bind` 失败直接返回 `BindFailed`；固定端口占用时不会继续扫描其他端口。
- `src-tauri/src/proxy/server.rs:115`：bind 成功后从 `local_addr()` 读取 actual port。
- `src-tauri/src/services/proxy.rs:584`：仅当配置端口为 `0` 时，才把 OS 分配的 actual port 持久化。

因此 `last actual -> preferred -> 15721-15799` 的候选回退、完整 listener set bind 和提交前 socket lease 都是 CLI-Manager 的增强设计，不是 CCS v3.19.2 已有逻辑。

### WSL 官方网络依据

- Microsoft Learn：`https://learn.microsoft.com/en-us/windows/wsl/networking`（复核日期：`2026-08-08`）。
- 官方文档说明 WSL 默认网络模式为 NAT；mirrored 模式下 Windows host 与 WSL2 可使用 `localhost`/`127.0.0.1` 互通。
- 官方文档同时说明 mirrored 模式从 Linux 访问 Windows 服务可使用 `127.0.0.1`，但不支持该方向的 IPv6 loopback `::1`。

CLI-Manager 据此采用“mirrored 先探测 `127.0.0.1`；NAT 再解析并校验精确 Windows host-gateway；主动 probe 成功才写 Live”的边界。禁止 wildcard、自动防火墙修改和 `netsh portproxy` 是本任务的安全收敛，不是 Microsoft 文档要求。

### 多密钥扩展证据

- `src-tauri/src/provider/database.rs:55`：现有 `provider_api_keys` 已保存 `enabled`、`sort_index`、`is_active`，partial unique index 保证一个 provider/type 最多一个 active key。
- `src-tauri/src/provider/runtime.rs:44`、`src-tauri/src/provider/scope.rs:141`：当前 direct/runtime/scope 默认只解析 enabled active key，不存在自动 key pool。
- `.trellis/tasks/08-02-key/research/cc-switch-and-multikey.md`：已固定 CC Switch PR #4957 commit `843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86` 作为多 key 数据形态参考，并明确拒绝直接移植其 quota、balance、后台 probe 与完整 KeyRing。

A-03 是 CLI-Manager route-only 增强：复用现有 enabled/order rows，在 daemon 内增加 cursor/cooldown 和 key-attempt 层；不改变 direct/scope active-key 契约，也不声称 CCS v3.19.2 已提供相同行为。

## 5. 复核命令

```powershell
rtk git -C C:\Users\Admini\AppData\Local\Temp\cc-switch-3.19.2-routing rev-parse HEAD
rtk git -C C:\Users\Admini\AppData\Local\Temp\cc-switch-3.19.2-routing describe --tags --exact-match
rtk powershell "Get-FileHash -Algorithm SHA256 'D:\github\CLI-Manager\src-tauri\target\release\bundle\nsis\CLI-Manager_1.3.4_x64-ccs-setup.exe'"
```

预期分别得到 commit `43eaf07355af145aebfee301801779e824d4c221`、标签 `v3.19.2` 和上述 SHA-256。

## 6. 许可处理要求

本任务优先复用 CLI-Manager 已有 writer、provider runtime、daemon 和 HTTP 客户端构造逻辑。协议转换和 SSE 兼容代码复杂且已有大量上游回归测试；若实施阶段复制或实质改编 CCS 的 substantial code：

1. 在 `NOTICE` 中增加 CC Switch 来源、版本、commit 与 MIT 说明；
2. 新增 `third-party/cc-switch-LICENSE`，保留完整 MIT 文本；
3. 在任务交付记录中列出实际移植文件与对应上游路径；
4. 不复制与当前支持矩阵无关的 OAuth、Copilot、Gemini 应用、计费或市场模块；
5. 后续上游更新不得静默覆盖本任务固定版本，必须单独评审行为差异。

## 7. 证据限制

- 本任务未把 CCS 本机数据库值视为默认值。
- 本任务未承诺 CCS 的所有供应商/OAuth 特例；首版范围见 `prd.md`。
- 截图未覆盖所有错误态，错误与恢复语义来自源码。
- CLI-Manager 的最终 UI 会沿用当前设置页和侧边栏交互规范，不要求逐像素复制 CCS。
