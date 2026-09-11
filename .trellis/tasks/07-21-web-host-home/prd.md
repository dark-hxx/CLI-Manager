# brainstorm: Web 主机首页与工程入口

## Changelog Target

`[TEMP]`

## Goal

登录 Web 后先展示当前账户已连接的全部主机，主机卡片显示在线状态、最后一次心跳时间等连接信息；点击主机后进入该主机的工程页面。

## What I already know

* 当前 Web 入口在 `apps/web/src/App.tsx`，认证后直接渲染 `Workbench`。
* `apps/web/src/useAppModel.ts` 已通过 `webClient.devices()` 加载设备，并通过浏览器事件 `device.updated` 实时更新设备列表。
* `apps/web/src/domain.ts` 的 `Device` 已包含 `id`、`name`、`platform`、`appVersion`、`status`、`lastSeenAt`、`pairedAt`、`capabilities`，其中 `lastSeenAt` 可作为最后一次心跳时间的现有数据来源。
* 当前 `Workbench` 在 `apps/web/src/views.tsx` 中同时承担设备选择、项目上下文、历史会话和对话工作台；主机点击后可复用已有选中设备与工程上下文逻辑。
* Web 契约要求设备离线时拒绝新操作，设备状态必须以服务端/桌面上报为准；前端不能推断成功状态。
* 当前工作区已有未提交 Web 相关修改，本任务应与已有修改共存，不覆盖用户工作。

## Assumptions (temporary)

* “心跳信息最后一次心跳时间”优先使用 `Device.lastSeenAt` 展示；若后端字段已有更明确的 heartbeat 字段，实施前按契约校准。

## Open Questions

* 无。

## Requirements (evolving)

* 登录成功后默认进入主机首页，而不是直接进入当前 Workbench。
* “主机”明确指已配对并通过心跳连接 Web 服务的 CLI-Manager 桌面设备，不是 SSH 配置中的远程主机。
* 首页列出所有已配对桌面设备，包括当前离线设备。
* 每台主机至少展示名称、在线/离线状态和最后一次心跳时间。
* 点击主机后进入该主机的工程页面；工程页面沿用现有历史、项目上下文和对话工作台能力。
* 点击主机后直接进入现有 Workbench，在左侧工程树选择工程，不新增独立工程列表页。
* Workbench 提供返回主机首页的明确入口。
* 无主机时展示空状态，并直接提供现有设备配对入口。
* `zh-CN` 与 `en-US` 文案同步，时间格式保持 24 小时制。
* 实时 `device.updated` 事件应更新首页主机状态和最后心跳时间。
* 主机首页使用响应式卡片网格，同一行根据可用宽度排列多张主机卡片。
* 桌面客户端需扩展设备 hello 上报，将用于识别的主机信息和系统壁纸缩略图传递到 Web 服务并展示在主机卡片中。
* 主机信息包括计算机名、操作系统版本、CPU 架构、CPU 型号、总内存和主显示器分辨率；不上传用户名和本地 IP。
* 系统壁纸上传默认启用，并允许桌面用户在 Web 设备设置中关闭。
* 支持 Windows、macOS 和 Linux；客户端启动或重新连接时读取一次系统壁纸，生成约 `480x270` 的压缩缩略图，不随心跳重复上传。
* 壁纸读取或转换失败时仍允许设备连接，且服务端保留此前成功上传的壁纸。

## Acceptance Criteria (evolving)

* [x] 登录后首屏是主机列表，不自动选中并进入工程工作台。
* [x] 主机列表展示在线状态与最后一次心跳时间，空值有明确文案。
* [x] 点击在线或离线主机均能进入对应主机工程页面；离线状态保留只读/草稿限制。
* [x] 从 Workbench 可返回主机首页并重新选择设备。
* [x] 无设备时可从主机首页打开配对流程，配对成功后新设备出现在列表中。
* [x] 主机状态沿用 `device.updated` 实时事件更新，不需要手动刷新。
* [x] 中英文切换覆盖新增界面文案。
* [ ] Web 主机卡片展示稳定主机信息，并以系统壁纸缩略图作为可识别背景。
* [ ] Windows、macOS、Linux 均有系统壁纸读取路径；不支持的桌面环境或格式失败时不阻断连接。
* [ ] 壁纸只在启动/重连 Hello 中上传，服务端校验并单独存储，不进入设备列表或浏览器事件的大 JSON 载荷。
* [ ] 旧客户端未提供主机信息或壁纸时仍能正常连接并显示基础卡片。

## Definition of Done

* 相关 TypeScript 类型检查通过。
* 关键桌面/移动视口完成页面检查。
* 变更范围经过 GitNexus 影响/变更检查。
* 行为变化记录到 `CHANGELOG.md` 的 `[TEMP]` 区域。

## Out of Scope

* 新增 SSH 主机管理模型或数据库迁移。
* 重做工程页内的文件、Git、Hook、历史等业务能力。
* 引入新 UI 框架或新的状态管理依赖。
* 主机搜索、分组、批量管理和自定义排序。

## Extension Decisions

* 用户明确要求读取系统壁纸，不截取当前桌面内容，也不手动选择识别图片。
* 客户端启动或重新连接时生成一次约 `480x270` 的压缩缩略图，不随心跳重复上传。
* 壁纸上传默认启用，可在桌面设置中关闭；只上传压缩缩略图，不上传原始壁纸文件。
* 壁纸读取覆盖 Windows、macOS、Linux；macOS 非通用图片格式通过系统工具转换，Linux 按桌面环境返回的壁纸 URI 解析。
* 主机信息采用稳定基础集合：计算机名、操作系统版本、CPU 架构、CPU 型号、总内存、主显示器分辨率；不上传登录用户名和本地 IP。

## Technical Notes

* GitNexus 查询确认主要触点为 `apps/web/src/App.tsx`、`apps/web/src/useAppModel.ts`、`apps/web/src/views.tsx`、`apps/web/src/domain.ts`、`apps/web/src/i18n.ts`。
* 需要在编辑具体符号前对 `App`、`useAppModel`、`Workbench` 等符号执行 GitNexus impact；当前仅完成查询，尚未修改代码。
* GitNexus impact：`Workbench` 为 LOW（无直接上游调用记录），`useAppModel` 为 LOW（直接上游仅 `App`）；`App` 同名符号存在歧义，但精确 context 已确认 Web `App` 只调用当前 Web 模型与翻译函数。
* UI/UX 检索结论：使用面向开发工具的克制型实时监控布局；主机项必须是语义化按钮，状态不能只靠颜色，空状态需提供明确操作，移动端不能产生横向滚动。

## Technical Approach

* 在 `App` 内增加轻量页面状态：认证并加载完成后默认显示主机首页；点击主机时调用现有 `selectDevice` 后切换到 `Workbench`，返回时只切换页面，不清空设备或草稿状态。
* 在 `views.tsx` 新增主机首页组件，复用现有主题、语言、退出、刷新和配对交互；主机按“在线优先、最后心跳时间倒序”展示。
* 主机卡片展示名称、平台、版本、在线文字状态与 24 小时制最后心跳时间；`lastSeenAt` 为空时显示“暂无心跳”。
* `Workbench` 增加返回主机首页按钮；现有设备下拉和工程树保留，避免重做工程页。
* 共享协议为 Hello 增加可选主机信息和壁纸字段，保持旧客户端兼容；设备列表只返回主机信息与壁纸修订值，不内嵌图片。
* 服务端新增设备身份迁移和认证壁纸读取接口；Hello 未携带壁纸时保留此前成功上传内容。
* 桌面端复用现有 Web 设备配置和两条 Hello 发送路径，统一调用跨平台采集模块。

## Decision (ADR-lite)

**Context**：现有 Web 登录后直接进入工作台并自动选中设备，无法先观察全部桌面设备的连接状态。

**Decision**：新增客户端主机首页作为认证后的默认页面，主机点击后直接进入现有 Workbench；不增加独立工程列表页或路由依赖。

**Consequences**：改动集中在 Web 展示与轻量导航状态，现有协议保持不变；浏览器刷新后回到主机首页，用户需重新选择主机。

## Verification

* `npm run web:typecheck`：通过。
* `git diff --check -- <本任务文件>`：通过，仅有仓库现存 LF/CRLF 提示。
* GitNexus `detect_changes`：整个未提交工作区为 MEDIUM，受已有 Rust Web daemon 并行改动影响；本任务单独执行的 `App`、`Workbench`、`useAppModel`、`selectDevice` impact 均为 LOW。
* 未执行 `web:build`、`web:dev` 或运行时 UI 检查：当前 Trellis 会话明确禁止在用户未要求时启动/构建服务；需人工检查 320/375/768/1024/1440 宽度及中英文切换。
