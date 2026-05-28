# WebDAV 自动同步、设备名称与手动同步对比弹框

## Goal

为现有 WebDAV 云同步补齐自动同步、设备名称隔离和更安全的手动同步体验：用户可以在设置中开启/关闭应用打开、关闭时的自动上传/下载；手动同步前展示云端内容与本地内容，允许用户按数据域选择覆盖部分或全部；多设备使用时可按设备名称同步/恢复，避免不同设备项目路径互相覆盖。

## What I already know

* 用户要求：WebDAV 同步增加自动同步设置；每次打开/关闭时可以自动上传/下载；开关可手动调整。
* 用户要求：WebDAV 手动同步时需要弹框展示云端内容、本地内容，可选择覆盖部分/所有。
* 用户已确认：“覆盖部分”按数据域粒度处理，即项目、分组、命令模板这类大类选择，不做单条记录级选择。
* 用户新增要求：WebDAV 同步增加设备名称，按照设备名称进行同步/恢复；原因是多设备使用时项目路径可能不同。
* 现有 `src/stores/syncStore.ts` 已有 `syncMode: "cloud" | "local"`、WebDAV 配置、`upload()`、`download(force?)`、冲突状态和 `resolveConflict(keepLocal)`。
* 现有同步数据包含 `projects`、`groups`、`command_templates`、空 `settings`，版本为 `SYNC_DATA_VERSION = 1`。
* 现有下载冲突只在 `local.last_modified > remote.last_modified && local.device_id != remote_data.device_id` 时触发，并只支持“保留本地/使用远程”。
* 现有 `SyncSettingsPage` 已有 WebDAV 手动“上传到云端 / 从云端下载”按钮、下载确认框和冲突 Banner。
* `App.tsx` 启动时已并行加载 settings、sync config、session；关闭时已有 `onCloseRequested` 拦截，支持最小化/退出/询问。

## Assumptions (temporary)

* 自动同步只在 `syncMode === "cloud"` 且 WebDAV 连接信息有效时执行。
* “打开/关闭时可以自动上传/下载”需要拆成可配置动作，而不是硬编码。
* 手动同步弹框做摘要级对比：更新时间、设备名称、项目/分组/模板数量与列表预览。
* “部分覆盖”固定为按数据域选择：项目、分组、命令模板。
* 设备名称需要用户可编辑，并持久化到同步配置中。
* 为避免多设备路径互相覆盖，设备名称应参与云端数据组织或恢复选择，而不只是显示字段。

## Open Questions

* None.

## Requirements

* 在同步设置页增加 WebDAV 自动同步配置。
* 应用启动时、关闭/退出时分别可选自动动作：关闭、上传、下载。
* 支持应用启动时按配置执行自动同步动作。
* 支持应用关闭/退出时按配置执行自动同步动作。
* 自动下载遇到本地与云端同设备快照都更新时，不自动覆盖本地，改为提示用户进入同步页手动处理。
* 增加可编辑设备名称，默认使用系统计算机名，并在 WebDAV 同步数据中记录设备名称。
* WebDAV 云端按设备名称保存每台设备的独立快照。
* 当前设备默认同步/恢复自己的快照，手动恢复时可选择其他设备快照。
* WebDAV 手动同步前展示本地与云端内容对比弹框。
* 手动同步允许按数据域选择覆盖：项目、分组、命令模板。
* WebDAV 同步/恢复需要支持按设备名称区分数据，避免不同设备的项目路径互相污染。

## Acceptance Criteria (evolving)

* [ ] 用户能在“设置-同步-WebDAV”中开启/关闭自动同步。
* [ ] 用户能分别配置应用打开时、关闭时的自动同步行为。
* [ ] 用户能设置当前设备名称，默认值来自系统计算机名，重启应用后保持。
* [ ] 开启启动自动同步后，应用初始化加载同步配置后触发对应同步。
* [ ] 开启关闭自动同步后，应用退出路径在销毁窗口前触发对应同步。
* [ ] 手动同步会先展示本地与云端摘要，不再直接覆盖。
* [ ] 手动同步弹框展示本地设备名称和云端设备名称/快照来源。
* [ ] 用户可以选择覆盖全部或按项目、分组、命令模板部分覆盖。
* [ ] 多设备恢复时不会默认用另一台设备的项目路径覆盖当前设备路径。
* [ ] 网络失败或未配置密码时不会阻塞应用启动/关闭，只提示失败。

## Definition of Done (team quality bar)

* Tests added/updated where practical.
* Typecheck passes: `npx tsc --noEmit`.
* Rust check passes if backend changed: `cd src-tauri && cargo check`.
* UI verified manually in dev app if implementation happens.
* Docs/spec updated if a reusable sync convention emerges.

## Decision (ADR-lite)

### 部分覆盖粒度

**Context**: 手动同步“部分覆盖”可能做成逐条记录选择，但 UI 与合并逻辑复杂，且当前需求主要是降低误覆盖风险。

**Decision**: MVP 采用按数据域覆盖：项目、分组、命令模板。

**Consequences**: 实现简单、可测试；暂不支持单个项目/模板逐条挑选，后续可扩展。

### 设备名称同步模型

**Context**: 多设备使用时，项目路径可能不同；单个共享快照会导致一台设备的路径覆盖另一台设备。

**Decision**: 云端按设备名称保存每台设备的独立快照。当前设备默认同步/恢复自己的快照，手动恢复时可选择其他设备快照。

**Consequences**: 更符合多设备路径差异；需要云端支持设备快照列表、设备快照选择和按设备名称读写。

### 自动同步动作模型

**Context**: 固定“启动下载、退出上传”简单，但用户希望更灵活地控制不同场景。

**Decision**: 应用启动时和关闭/退出时分别提供动作选择：关闭、上传、下载。

**Consequences**: 设置项更多，但可以覆盖备份型、恢复型、多设备迁移型用法。

### 自动下载冲突策略

**Context**: 自动下载如果直接覆盖本地，可能误删用户刚改的项目、分组或模板。

**Decision**: 自动下载检测到本地与云端同设备快照都更新时，暂停自动覆盖并提示用户进入同步页手动处理。

**Consequences**: 安全优先；用户需要一次手动决策，但不会静默丢数据。

### 设备名称默认值

**Context**: 设备名称用于区分多设备快照；要求用户手动填写会阻塞首次同步，随机名又不直观。

**Decision**: 默认使用系统计算机名，并允许用户在同步设置页手动修改。

**Consequences**: 多设备识别直观；需要 Rust/Tauri 侧提供读取系统计算机名的能力，读取失败时可回退到当前 deviceId 的短标识。

## Out of Scope (explicit)

* 暂不引入新同步服务或新依赖。
* 暂不做单条项目/模板级别选择。
* 暂不做复杂三方合并或字段级冲突解决。

## Technical Notes

* Likely frontend files: `src/stores/syncStore.ts`, `src/components/settings/pages/SyncSettingsPage.tsx`, `src/App.tsx`.
* Likely backend files: `src-tauri/src/commands/sync.rs`, `src-tauri/src/sync/*` if preview-only download, device snapshot listing, or partial upload/apply requires Rust support.
* Current close interception in `App.tsx` has multiple exit paths: tray quit, closeBehavior=exit, close confirm exit.
* Need avoid silently turning close into long blocking operation; likely use bounded async flow plus toast.
* Existing sync payload version may need bump if adding `device_name` or multi-device snapshot layout changes.
