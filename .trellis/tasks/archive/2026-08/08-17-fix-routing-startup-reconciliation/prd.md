# 修复应用重启后本地路由未恢复

## Goal

当用户已经启用本地路由并保留接管配置时，CLI-Manager 重新启动并连接或拉起 daemon 后，应自动恢复真实 listener，使持久化开关、daemon 运行态和实际可用性一致，不再要求用户手动关闭再开启。

## What I already know

- `routing.service.v1.service_enabled` 是持久化的期望状态，daemon listener 是进程内运行态。
- 应用启动时先初始化 provider DB，再在后台线程执行 `connect_or_spawn`；连接成功后当前只写入 `DaemonBridge`，没有恢复持久化路由意图。
- `routing_get_state` 仅合并持久化配置和 daemon 状态，不执行恢复。
- `useNativeProviderRouting.refresh()` 只在供应商设置页挂载时发现“期望开启、实际停止”并调用 `routing_set_service_enabled(true)`。
- 侧边栏 `useProviderQuickSwitch` 只读取路由状态，不执行恢复，因此未打开设置页时会一直处于假开启/实际关闭状态。
- daemon 如果 listener 已运行，会因 `routing_is_running()` 保持存活；问题主要发生在 daemon 新拉起、旧 daemon 退出或运行态丢失时。

## Root-Cause Statement

根因位于应用启动的 daemon 连接边界：持久化路由意图在 provider DB 初始化时已加载，但 daemon 客户端就绪后没有后端恢复步骤，恢复责任被错误地留给特定设置页前端 Hook，因此侧边栏或无设置页启动路径无法恢复真实 listener。

## Requirements

- daemon 连接或新拉起成功后，后端必须读取持久化路由状态并自动协调 listener 运行态。
- 持久化 `service_enabled=false` 时不启动 listener。
- 持久化 `service_enabled=true` 且 daemon 已运行时保持现状，不重复绑定或改写配置。
- 持久化 `service_enabled=true` 且 daemon 已停止时，使用当前持久化端口、上次实际端口和完整 listener 地址集合启动路由。
- WSL 接管存在时，恢复应复用既有 `persisted_listener_addresses` 规则，覆盖 mirrored loopback 与 NAT gateway 地址。
- 启动成功后保存 daemon 返回的 `actual_port`，但不得改变用户的 `service_enabled` 意图。
- 恢复失败不得阻止 daemon bridge 就绪或应用启动；必须保留 stopped/unavailable 运行真相并写入脱敏日志。
- 前端设置页的现有恢复逻辑可保留为连接丢失后的二次协调，不作为冷启动唯一恢复入口。
- 不新增 IPC、数据库字段或 daemon 协议。

## Acceptance Criteria

- [ ] 路由已启用、daemon 在应用退出后停止：重新启动应用后 listener 自动恢复，无需手动切换开关。
- [ ] 路由已启用、daemon 原本仍运行：重新连接后不重复启动，原实际端口保持稳定。
- [ ] 路由未启用：应用重启不会启动 listener。
- [ ] listener 自动恢复后，侧边栏和设置页均显示 daemon `running`，实际端点可接收请求。
- [ ] 本地 Home 和 WSL mirrored/NAT takeover 的 listener 地址按现有规则恢复。
- [ ] 端口占用时沿用既有候选端口策略并保存新的 `actual_port`。
- [ ] WSL gateway 变化、daemon 不支持 routing 或启动失败时，应用仍可用，bridge 仍连接，运行态不伪装为 running。
- [ ] Rust 定向测试、完整 `cargo test`、`cargo check` 和前端 `npx tsc --noEmit` 通过。
- [ ] `CHANGELOG.md` 的 `TEMP` 版本和 `docs/功能清单.md` 同步记录修复。

## Scenario Coverage

- daemon 来源：连接既有 daemon / 拉起全新 daemon / 旧 info 文件失效后重拉。
- 运行态：listener 已运行 / stopped / capability 不支持 / client 连接失败。
- 持久化意图：enabled / disabled；有 takeover / 无 takeover。
- Home 环境：Windows local / WSL mirrored / WSL NAT gateway；SSH 明确不属于本地路由接管。
- 地址与端口：上次端口可复用 / 被占用后 fallback / gateway 已变化。
- UI：设置页未打开 / 侧边栏先打开 / 设置页稍后打开；恢复不依赖任何前端挂载顺序。
- 窗口、分屏、Workspan、焦点和托盘状态：均共享后端 listener，不应影响恢复结果。

## Discovery List

- [x] `src-tauri/src/lib.rs`：daemon 后台连接成功边界；缺少持久化路由协调调用。
- [x] `src-tauri/src/commands/routing.rs`：service 启停、daemon 状态、持久化 listener 地址、保存实际端口与回滚逻辑；应抽取复用。
- [x] `src-tauri/src/provider/routing.rs`：持久化 service/takeover 真源；确认无需 schema 变更。
- [x] `src-tauri/src/daemon/client.rs`：`connect_or_spawn` 和 bridge 生命周期；确认连接流程本身无需承担 provider DB 语义。
- [x] `src-tauri/src/daemon/server.rs` / `daemon/routing.rs`：运行态与端口候选；确认已有 running 状态和绑定策略可复用。
- [x] `src/components/settings/providers/useNativeProviderRouting.ts`：设置页二次恢复；保留为运行期间协调。
- [x] `src/components/terminal/useProviderQuickSwitch.ts`：侧边栏只读消费者；确认不应在此补前端启动副作用。
- [x] daemon protocol：现有 `RoutingStatus` / `RoutingStart` 足够；确认不扩展控制帧。

## Definition of Done

- 冷启动协调位于后端 daemon-ready 边界并由测试覆盖。
- 现有手动启停与设置页恢复路径复用同一核心逻辑，避免行为分叉。
- 完整 Rust/前端质量门通过，GitNexus 仅命中预期启动和 routing 控制链。
- 产品记录与后端路由契约同步。

## Out of Scope

- 不改变 daemon 独立存活策略或退出条件。
- 不新增前端重试轮询、主动 routing event 或新 IPC 字段。
- 不自动修复已变化的 WSL NAT gateway；继续按既有安全错误处理要求用户刷新 Home。
- 不改变 takeover 文件投影、故障转移队列或供应商选择逻辑。

## Technical Notes

- GitNexus：`connect_or_spawn`、`routing_set_service_enabled` 与 `useProviderQuickSwitch` 影响均为 LOW；启动链会影响 `run` 过程，应重点验证 daemon 已运行和未运行两条分支。
- 当前工作区干净；`master` 相对 `origin/master` 领先 3 个本地提交。
- 版本未指定，产品记录使用 `TEMP`。
