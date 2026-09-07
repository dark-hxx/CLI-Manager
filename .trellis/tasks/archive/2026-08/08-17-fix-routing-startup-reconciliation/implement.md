# 实施计划：应用启动路由运行态协调

## 1. 建立协调决策与回归测试

- 在 `src-tauri/src/commands/routing.rs` 抽取内部幂等协调判定/核心入口。
- 覆盖 persisted disabled、enabled+running、enabled+stopped 以及恢复失败不改意图。
- 覆盖启动 frame 携带完整 local/WSL listener 地址和端口信息。

验证：

```powershell
cd src-tauri
cargo test commands::routing
```

## 2. 复用安全启停逻辑

- 将 `routing_set_service_enabled` 的重复状态检查、frame 构造、实际端口保存和失败回滚整理为可由命令与启动协调共同调用的内部函数。
- 保持 Tauri command 签名与返回 DTO 不变。
- 手动启用和冷启动恢复均使用 `persisted_listener_addresses`。

验证：

```powershell
cd src-tauri
cargo fmt -- --check
cargo test routing
```

## 3. 接入 daemon-ready 启动边界

- 在 `src-tauri/src/lib.rs` 的 `connect_or_spawn` 成功分支调用后端协调。
- 协调失败记录脱敏 warning，但仍执行 `DaemonBridge.set(client)`。
- 不在 `daemon/client.rs` 引入 provider DB 依赖，不把协调职责下沉到 transport 层。

验证场景：

- 既有 daemon 已 running：无重启/重绑。
- 新 daemon stopped + persisted enabled：自动 start。
- persisted disabled：保持 stopped。
- start 失败：bridge 可用且状态不伪装。

## 4. 产品与契约同步

- 更新 `.trellis/spec/backend/ccs-provider-domain-contracts.md`，明确 app startup/daemon-ready 自动恢复契约。
- 更新 `CHANGELOG.md` 的 `TEMP` 路由章节和 `docs/功能清单.md` 对应条目。
- 不新增用户可见文案，因此无需新增 i18n key。

## 5. 全量质量门

```powershell
cd src-tauri
cargo fmt -- --check
cargo check
cargo test
cd ..
npx tsc --noEmit
git diff --check
```

- 运行 `gitnexus_detect_changes(scope: "unstaged")`，确认只影响启动与 routing 控制链。
- 手工验证一次“开启路由 -> 退出应用/确保 daemon 停止 -> 重启 -> 无需开关即可请求”的真实链路；若当前环境无法执行，明确报告未验证风险。

## 回滚点

- 若启动协调影响 daemon 连接稳定性，移除 `lib.rs` 调用并保留内部重构/测试前先重新评估，不在前端复制恢复逻辑。
- 若 WSL gateway 解析失败，保持既有安全错误，不扩大为自动修改 takeover 地址。
