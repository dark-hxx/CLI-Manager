# 技术设计：应用启动路由运行态协调

## 设计目标

在 daemon client 变为可用的后端边界执行一次幂等协调，让持久化期望状态驱动真实 listener，而不依赖任一前端页面挂载。

## 当前数据流

```text
provider DB initialize
  -> background connect_or_spawn daemon
  -> DaemonBridge.set(client)
  -> frontend routing_get_state
  -> persisted enabled + daemon stopped
  -> 仅设置页 Hook 会补调用 routing_set_service_enabled(true)
```

缺口是 `connect_or_spawn` 成功与 `DaemonBridge.set` 之间没有恢复步骤。

## 方案比较

### 方案 A：侧边栏也复制设置页恢复逻辑

- 优点：改动前端局部。
- 缺点：仍依赖 UI 打开时机；设置页、侧边栏继续重复副作用；后台路由无法在无 UI 访问时恢复。
- 结论：不采用。

### 方案 B：让 `routing_get_state` 每次读取时隐式启动

- 优点：任意读取者可触发恢复。
- 缺点：读命令变为有副作用；并发读取可能重复协调；仍依赖某个前端先读取。
- 结论：不采用。

### 方案 C：daemon-ready 后端协调（采用）

- 在 `commands::routing` 内新增可从启动线程调用的内部协调函数。
- 函数读取 `RoutingPersistedState` 和 daemon `RoutingStatus`：意图关闭或已运行则幂等返回；意图开启且 stopped 时发送 `RoutingStart`。
- `RoutingStart` 使用 `persisted_listener_addresses`、`preferred_port` 与 `actual_port`，成功后只保存返回的实际端口。
- `lib.rs` 在 `connect_or_spawn` 成功后调用协调；无论协调成功或失败都把有效 client 写入 `DaemonBridge`，失败只记录脱敏 warning。
- 手动 `routing_set_service_enabled` 复用相同的 start/stop 核心，避免冷启动与按钮行为分叉。

## 边界与顺序

1. provider DB 初始化完成。
2. 后台线程连接/拉起 daemon。
3. 对 client 校验 routing capability并读取 runtime status。
4. 根据 persisted intent 幂等协调。
5. 成功或失败后均设置 bridge；前端随后读取真实运行态。

协调失败时不把 `service_enabled` 改为 false，因为它表示用户期望；daemon status 继续表示真实 stopped/unavailable。

## WSL listener 恢复

- 复用 `persisted_listener_addresses`，确保 local 地址与所有 WSL takeover 地址一次性传入 `RoutingStart`。
- mirrored 模式补充 loopback；NAT 模式重新解析 gateway 并校验与持久化 advertised host 一致。
- gateway 变化时拒绝静默绑定新地址，保留既有 `routing_wsl_gateway_changed` 安全语义。

## 错误与回滚

- capability 不支持、状态请求失败、地址解析失败或 listener 启动失败：返回错误，启动线程记录 warning，bridge 仍接入。
- listener 启动成功但保存 `actual_port` 失败：沿用手动启用路径的 rollback，停止刚启动的 listener，避免运行态与持久化端口分叉。
- daemon 已运行时不 reload，不改变地址或端口；运行中的 daemon 是当前运行真相。

## 测试设计

- 抽取纯协调决策，覆盖 persisted disabled、enabled+running、enabled+stopped、unsupported/unavailable。
- 测试启动 frame 使用完整 listener 地址、preferred/last actual port。
- 保留 daemon server 的 start/stop/port fallback 测试。
- 对 startup 调用位置做源级或可注入边界测试，证明 client ready 后执行协调且失败仍设置 bridge。

## ADR-lite

**Context**：路由恢复是持久化意图与 daemon 运行态的生命周期协调，不能由某个前端消费者拥有。

**Decision**：在 daemon client ready 后由 Rust 主进程执行一次幂等协调，复用命令层的安全启停核心。

**Consequences**：应用重启后路由无需 UI 触发即可恢复；不改变 IPC/数据库协议。启动线程会多一次低频状态请求和必要时一次 listener start。
