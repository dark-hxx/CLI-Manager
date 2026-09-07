# 优化 WSL 供应商切换与本地路由耗时

## Changelog Target

`[TEMP]`

## Goal

降低终端侧边栏在 WSL Home 下执行供应商切换、开启本地路由/接管时的等待时间，避免重复启动 `wsl.exe`、重复校验 Home 和重复读写配置，同时保留现有安全校验、配置指纹保护、失败回滚与 mirrored/NAT gateway 兼容性。

## Requirements

- 供应商预览与应用在同一次切换链路中复用已解析的 WSL Home 和可复用的配置快照，避免对同一目标重复执行 Home 校验和无必要的 WSL 读取。
- WSL 本地路由接管减少重复的 Home 校验、网络模式探测、监听器重载和供应商配置投影；已确认的 distro/端口/endpoint 模式在安全有效期内可复用。
- 首次冷启动、WSL mirrored、WSL NAT gateway、daemon 已运行/未运行、Claude/Codex/Grok Build、配置文件不存在/已存在/不可写等场景保持正确。
- 任何探测或写入失败必须恢复监听器与原配置，不得为了提速跳过必要的身份校验、权限校验或指纹冲突检查。
- 前端继续显示可操作的忙碌/失败状态，不因优化引入同步阻塞侧边栏打开或切换 UI。
- 变更记录写入 `CHANGELOG.md` `[TEMP]`，产品功能清单同步更新。

## What I Already Know

- 侧边栏 Hook 位于 `src/components/terminal/useProviderQuickSwitch.ts`，全局切换调用 `provider_global_preview` 后再调用 `provider_global_apply`。
- WSL Home 解析位于 `src-tauri/src/provider/home.rs`；自动 Home 探测上限 30 秒，手动/自动 Home 校验使用 5 秒超时。
- WSL 全局配置计划在 `src-tauri/src/provider/global.rs::build_plan_with_mode` 中执行 `home::get`、每个目标的 `read_live`，应用阶段还会检查可写、写入、验证并可能回滚。
- WSL 接管位于 `src-tauri/src/commands/routing.rs::routing_set_takeover`：先校验 Home 和当前供应商，再重载监听器，探测 mirrored；失败后获取 NAT gateway、再次重载监听器并探测 gateway，随后重复调用全局 preview/apply 投影路由 endpoint。
- 当前 WSL 操作以多个独立 `wsl.exe` 命令串行完成，单命令上限约 15 秒；用户实测供应商切换和本地路由接管均约 6–7 秒。

## Open Questions

- 优化范围选择：采用哪种实现深度？

## Feasible Approaches

**A. 计划复用 + 短生命周期探测缓存（推荐）**

- 在 preview/apply/route takeover 内复用已解析 Home、目标快照和 endpoint 探测结果；缓存仅限当前操作或短 TTL，不改变持久化语义。
- 风险较低，容易保留现有指纹与回滚；对 WSL 进程启动次数的减少有限但可控。

**B. 后端批量 WSL 操作**

- 将同一 CLI 的 test/read/write/verify 合并到一次 `wsl.exe --exec sh` 脚本调用，并将 mirrored/gateway 探测合并为一次脚本。
- 性能收益最大，但脚本序列化、错误映射和回滚复杂度更高。

**C. A+B 全部实施**

- 同时复用计划/探测并批量执行 WSL 操作，最快但改动面和回归风险最高。

## Decision (ADR-lite)

**Context**: WSL 供应商切换和本地路由接管在同一条用户操作链路中重复解析 Home、启动多个 `wsl.exe`、探测网络并重复构建/应用供应商配置计划，导致热启动仍需 6–7 秒。

**Decision**: 采用方案 C。将 Home/endpoint/配置计划在当前操作内复用，并把同一目标的 WSL 检查、读取、写入和验证尽量合并为单次脚本调用；所有批量脚本仍返回结构化阶段结果，现有指纹冲突、权限验证、备份、回滚和 mirrored/gateway 降级路径保持有效。

**Consequences**: 性能收益最大，但需要补充脚本输入转义、阶段错误映射、超时与回滚测试；不引入长期缓存持久化，避免 Home、网络和配置外部变化被旧快照掩盖。

## Acceptance Criteria

- [ ] WSL 已热启动时，供应商切换和开启本地路由的等待时间明显低于当前 6–7 秒，且不再重复执行同一 Home/网络探测。
- [ ] WSL 冷启动时仍能正确探测并完成或明确失败，不把短超时误报为配置损坏。
- [ ] mirrored 与 NAT gateway 两种网络模式均可接管；gateway 探测失败时监听器和配置恢复到变更前状态。
- [ ] Claude、Codex、Grok Build 的目标文件数差异不会造成目标遗漏；不存在、已存在和不可写目标均保持既有错误与回滚语义。
- [ ] `npx tsc --noEmit` 与受影响 Rust 检查通过；不启动 Tauri 运行时进行自动 UI 验证。

## Definition of Done

- `CHANGELOG.md` `[TEMP]` 与 `docs/功能清单.md` 已更新。
- 变更范围通过 GitNexus impact/detect_changes 检查，相关 Rust 单测或 `cargo check` 通过。
- 手动验证清单覆盖 local/WSL、冷/热启动、mirrored/gateway、三种 CLI、失败回滚。

## Out of Scope

- 不改变路由算法、故障转移策略、Home 选择语义或 provider 数据模型。
- 不通过无限延长超时掩盖 WSL/daemon 故障。
- 不取消必要的权限、指纹、配置完整性和失败回滚保护。

## Technical Notes

- 关键前端触点：`src/components/terminal/useProviderQuickSwitch.ts`、`src/components/terminal/ProviderQuickSwitchPanel.tsx`。
- 关键后端触点：`src-tauri/src/commands/routing.rs`、`src-tauri/src/provider/routing.rs`、`src-tauri/src/provider/global.rs`、`src-tauri/src/provider/home.rs`。
- 需要重点避免将同步 `#[tauri::command]` 的 WSL 长操作继续放在 UI 阻塞路径中。
