# 优化 CLI Home WSL 运行环境识别流程

## Changelog Target

`[TEMP]`

## Goal

优化“设置 → CLI Home → 运行环境”切换到 WSL 时的响应体验：环境切换只更新待编辑状态，不在切换瞬间触发耗时的 WSL Home 探测；用户明确点击刷新按钮后才执行识别并更新当前 Home/环境诊断结果，同时自动列出本机已安装的 WSL 发行版供选择。

## What I already know

- 运行环境选择位于 `src/components/settings/providers/NativeProviderHomeSection.tsx`。
- 状态与 IPC 编排位于 `src/components/settings/providers/useNativeProviderHome.ts`。
- `setEnvironmentKind` 会更新环境类型和环境 ID；`refreshHome` 依赖环境状态，当前环境切换会因 `useEffect` 依赖变化自动调用 `provider_home_get`。
- `homeDraftDirty` 的预览 effect 会调用 `provider_home_preview`；WSL 自动 Home 解析会通过 `wsl.exe` 探测 distro 与 `$HOME`，超时上限为 30 秒。
- 手动刷新按钮当前调用 `refreshHome`，并随后调用 `inspectEnvironment`；保存/重置流程也会刷新 Home 并执行诊断。
- 前端新增用户可见文案必须同时支持 `zh-CN` 与 `en-US`，优先使用现有 i18n。
- WSL 发行版列表可通过 `wsl.exe -l -q` 获取；项目已有统一的 `find_wsl_exe` 与超时子进程执行约定，可复用到新的轻量列表 IPC。

## Root-Cause Statement

根因在前端 Hook 的生命周期依赖：`refreshHome` 绑定当前环境选择并被 effect 自动触发，导致用户仅切换 WSL 时就跨 IPC 调用后端 WSL Home 探测；识别触发策略应收敛到显式刷新动作，避免在状态编辑阶段执行耗时 IO。

补充根因：设置页重新挂载时仍以 `local:host` 为初始状态调用
`provider_home_get`，没有读取后端已持久化的 active Home identity。保存动作实际已
写入偏好，但页面打开后的本地状态被默认值覆盖，因此表现为“关闭设置后没有保存”。

补充交互根因：CLI 类型 Tab 与 Home Hook 共用 `appType`，初始 active Home 加载
effect 将 `appType` 作为依赖，切换 Claude/Codex/Grok Build 时重复触发 WSL 发行版
列表和活动 Home 读取，造成明显卡顿；Home 派生路径卡片也没有使用当前 Tab 过滤。

补充环境隔离根因：运行环境选择只更新了 `environmentKind/environmentId`，没有同步
切换 `home` 结果对象；因此延迟识别期间仍把本机缓存路径显示在 WSL 下，或反向混用。

补充进入页面根因：初次加载活动 Home 后还同步等待 `provider_global_current` 和
WSL 发行版列表；其中全局当前状态会再次走 WSL Home 解析/校验，导致点击 CLI Home
时页面长时间处于加载状态。

## Discovery List

- [x] `NativeProviderHomeSection`：环境选择与刷新按钮入口。
- [x] `useNativeProviderHome`：环境状态、自动刷新 effect、Home 预览与诊断调用。
- [x] `nativeProviderTypes`：环境输入/输出类型，无需新增协议字段即可完成本次调整。
- [x] `src-tauri/src/commands/provider.rs`：Home/环境诊断 IPC command 入口，确认无需修改命令契约。
- [x] `src-tauri/src/provider/home.rs`：WSL 识别与 30 秒探测逻辑，作为当前耗时边界；本 MVP 不改变后端探测语义。
- [x] `src-tauri/src/wsl.rs` / `src-tauri/src/commands/provider.rs` / `src-tauri/src/lib.rs`：确认 WSL 可执行文件定位、Tauri command 注册和命令层位置；需要增加只读发行版列表 command。
- [x] `src/components/settings/providers/NativeProviderEnvironmentSection.tsx`：已有手动环境检查入口，需要保持可用。
- [x] `src/lib/i18n.ts`：如需新增发行版加载/空状态/失败辅助文案，必须同步中英文。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：行为和产品功能变更的交付记录。

## Scenario Matrix

- 窗口：当前窗口正常聚焦；切换到其他窗口后返回；窗口最小化/恢复。
- 分屏/多会话：CLI Home 页面单实例；不同 CLI Home 卡片或 provider 详情切换后状态不串用。
- 运行环境：local → WSL、WSL → local、WSL distro A → distro B；首次识别与已识别环境再次切换；发行版列表加载成功/为空/失败。
- 模式：auto 与 manual；切换环境后编辑路径、保存、重置。
- 操作时序：快速连续切换环境；切换后立即保存；切换后点击刷新；刷新失败后再次刷新。
- 诊断：环境切换后不自动诊断；点击刷新后 Home 与环境诊断结果同步更新。

## Requirements

1. 环境类型或 WSL distro ID 切换时，不自动调用 `provider_home_get`，也不自动调用环境诊断；页面保留当前已加载的 Home/诊断结果，不显示“待刷新”标记，切换后的内容作为待编辑状态。
2. 点击 Home 区域刷新按钮时，使用当前待编辑的环境输入执行 Home 识别，并在成功后执行环境诊断；刷新期间按钮和相关控件保持现有 busy/loading 约束。
3. 切换环境后，不因 Home 草稿预览机制触发耗时 WSL 自动探测；预览只在不会触发 WSL 识别的场景执行，或改为刷新后再展示，以确保“切换不识别”的约束成立。
4. 进入或切换到 WSL 运行环境时，自动获取并列出所有已安装的 WSL 发行版，发行版选择控件替代自由文本输入；列表加载不执行 Home 识别。
5. 保存、重置、应用供应商等既有显式动作继续按当前流程工作，不降低其完成后的 Home 与诊断一致性。
6. 保持 local、WSL、auto、manual 的现有输入校验和错误提示；不修改后端 WSL Home 探测超时、路径校验和既有 Home IPC 契约；新增发行版列表 IPC 只读、失败可重试。
7. 如新增发行版加载/空状态/失败辅助文案，必须补齐 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [x] 从 local 切换到 WSL 时，在点击刷新前不产生 `provider_home_get`、WSL Home 自动探测或 `provider_environment_inspect` 调用。
- [x] 从 WSL 切换回 local，以及 WSL distro 之间切换时，同样不自动识别。
- [x] 切换到 WSL 后能列出所有已安装发行版并可选择；列表请求不触发 Home 识别。
- [x] 点击刷新后按当前选择识别 Home，并在 Home 成功后更新环境诊断；失败时显示现有错误状态且可再次刷新。
- [x] auto/manual 路径编辑、保存、重置行为不回归。
- [x] 页面初次打开仍能加载已持久化的当前 Home；provider 切换后已有状态刷新行为不回归。
- [x] 保存 WSL 手动 Home 后关闭并重新打开设置，恢复 WSL 发行版、manual 模式和原始路径，不被 local `host` 覆盖。
- [x] Claude/Codex/Grok Build Tab 切换不再触发 Home/WSL 刷新；Home 路径和环境诊断内容按当前 Tab 过滤。
- [x] 本机与 WSL 切换时只恢复对应环境的缓存结果；缓存不存在时清空旧环境显示，不混用路径，保存/刷新仍可显式建立新环境结果。
- [x] 点击进入 CLI Home 时先显示活动 Home 缓存，不等待全局当前状态或 WSL 识别；发行版列表作为后台辅助请求，不阻塞 Home 编辑。
- [x] 保存/恢复 Home 只完成当前环境校验与持久化，不自动刷新当前供应商或环境诊断；WSL 手动 Home 的目录、读权限、写权限校验合并为一次 WSL 调用。
- [x] WSL 未安装、发行版列表为空或列表命令失败时，页面保持可操作并展示双语错误/空状态，不阻塞 local 环境。
- [x] `npx tsc --noEmit`、`cargo fmt --all -- --check` 与 `cargo check` 通过；Home focused tests 15/15 通过。
- [x] `CHANGELOG.md` 使用 `[TEMP]` 记录行为变更，`docs/功能清单.md` 按项目交付规则同步。

## Definition of Done

- 实现与现有 i18n、状态管理和 IPC 约定一致。
- 完成前端类型检查，并进行针对切换/刷新时序的代码审查或测试验证。
- 运行 GitNexus 变更检测，确认影响范围符合预期。
- 完成 Changelog 与功能清单更新。

## Out of Scope

- 不重写 Rust WSL Home 探测、缓存策略或既有超时机制；仅增加发行版枚举所需的只读探测。
- 不新增自动后台刷新、定时探测或跨页面全局缓存。
- 不改变供应商 Home 的持久化格式、环境身份格式或命令参数。

## Technical Notes

- 相关代码：`NativeProviderHomeSection.tsx`、`useNativeProviderHome.ts`、`NativeProviderEnvironmentSection.tsx`、`nativeProviderTypes.ts`、`src-tauri/src/provider/home.rs`。
- 当前实现中 `useEffect(() => void refreshHome(), [refreshHome])` 是环境切换触发识别的主要路径；`previewDraftHome` 是另一条潜在 WSL 探测路径。
- 发行版枚举建议使用 `wsl.exe -l -q`，复用 `shell_resolver::output_with_timeout`，解析 stdout 行并去重/过滤空行。
- 本任务按根因修复处理，需在编辑前对变更符号执行 GitNexus upstream impact analysis。
- 已完成实现：新增 `provider_wsl_list_distros` IPC；Hook 将 Home 初次加载 effect 与环境草稿解耦，WSL 草稿不触发 Home preview；UI 使用发行版 Select，右上角全量刷新同时重试发行版列表、Home 识别和环境诊断；新增 `provider_home_active_get`，页面初次挂载读取已持久化 active Home，避免保存后的 WSL 状态被 local `host` 覆盖；保存/恢复不再串联当前供应商与环境诊断，WSL 手动路径校验合并为单次 WSL 调用。
- 质量检查：`npx tsc --noEmit`、`cargo fmt --all -- --check`、`cargo check`、`cargo test provider::home::tests --lib` 均通过；真实 Tauri UI/WSL 运行时手测仍需人工完成。

## Decision (ADR-lite)

**Context**: WSL Home 自动探测最多等待 30 秒，环境选择变化触发自动识别会阻塞用户操作；同时用户需要从已安装发行版中选择稳定的环境 ID。

**Decision**: 环境切换只更新编辑状态并保留旧的 Home/诊断展示，不显示待刷新标记；Home 识别和诊断仅由显式刷新、保存、重置等动作触发。切换到 WSL 时单独请求已安装发行版列表，使用选择控件；列表结果优先保留当前 ID，若当前 ID 不存在则选择列表第一项。

**Consequences**: WSL 列表枚举仍会产生一次轻量 `wsl.exe -l -q` 请求，但不会触发 Home `$HOME` 探测或环境诊断；发行版列表失败时需要保持手动恢复/重试能力。

## Expansion Sweep

- 未来演进：可为发行版列表增加显式刷新，但本次先复用 CLI Home 刷新入口，避免引入额外状态。
- 相关场景：local 环境不请求发行版列表；WSL → local 后保留旧展示；provider/appType 切换不应覆盖当前环境编辑状态。
- 失败边界：`wsl.exe` 不存在、列表为空、命令超时、当前发行版已卸载、快速重复切换产生过期响应，都必须不阻塞 local 流程并避免旧请求覆盖新选择。

## Open Questions

- 无。上述范围已收敛为本次 MVP。
