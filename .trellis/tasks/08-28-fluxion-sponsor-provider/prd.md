# brainstorm: Fluxion AI token 中转站赞助商入口与默认供应商

## Goal

在 CLI-Manager 侧边栏提供一个带动画的 AI Token 中转站入口，点击后打开设置中的赞助商列表；首个合作商为 Fluxion AI，并在原生供应商目录中内置一个默认的 Fluxion 供应商（API Key 留空），帮助用户完成注册、复制注册链接并配置统一模型接入。

## What I already know

* 当前工作分支为 `master`，与 `origin/master` 同步；工作区已有用户提供的 `docs/img2` 图片变更，不能覆盖。
* 侧边栏底部由 `src/components/sidebar/SidebarFooter.tsx` 渲染统计、Hook、设置按钮；`Sidebar` 通过 `onOpenSettings(tab?: SettingsTab)` 打开设置。
* 设置页由 `src/components/SettingsModal.tsx` 管理 `SettingsTab`、标签顺序和内容映射；现有原生供应商页为 `NativeProviderSettingsPage`。
* 原生供应商数据存放在独立 `providers.db`，Rust 初始化见 `src-tauri/src/provider/database.rs`，目录 CRUD 见 `src-tauri/src/provider/repository/catalog.rs`；目前没有 Fluxion 默认供应商种子。
* 前端所有用户可见文案通过 `src/lib/i18n.ts` 同时提供 `zh-CN` 与 `en-US`（并自动支持繁体转换）。
* 用户已提供 `docs/img2/fluxion.png`（2400×720 横幅）、`fluxion-logo.png`、`fluxion-logo2.png`（均 1254×1254）作为合作商素材。
* 注册链接必须统一为 `https://fluxionai.space/register?source=github&campaign=climanager`。

## Assumptions (temporary)

* 赞助商列表作为设置中的独立一级标签，而不是混入“关于”或“供应商目录”。
* 入口在侧边栏展开/折叠两种状态都可见，并靠近现有统计/设置入口。
* Fluxion 合作商卡片使用本地图片素材，不依赖运行时网络图片加载。
* 注册链接使用系统外部浏览器打开，并在所有注册链接位置复用同一常量。

## Open Questions

* ~~Fluxion 默认供应商需要为哪些 `app_type` 建立（Claude、Codex、Grok Build，还是仅某一个）？~~ 已决定覆盖全部三类。
* ~~供应商默认配置应包含哪些 endpoint/model/API format 字段，还是只创建空壳供应商并保留 Key 为空？~~ 已决定按协议预填 URL、模型留空。
* ~~赞助商页首版是否只展示一个静态 Fluxion 卡片，还是需要为未来合作商保留可配置数据结构/排序？~~ 已决定首版直接实现单个 Fluxion 卡片。
* ~~动画入口是否允许在设置中关闭，还是固定展示？~~ 已决定固定动画，并在 `prefers-reduced-motion` 下自动停用。
* ~~Fluxion 注册 CTA 只放赞助商卡片还是也放供应商表单？~~ 已决定同时放在赞助商卡片和 Fluxion 供应商 API Key 区。
* ~~“默认供应商”是否意味着强制 `is_current`？~~ 已决定仅作为每类列表首项/默认选中，不标记已生效；不覆盖已有当前供应商。
* ~~MVP 是否处理链接失败、减少动效和离线展示？~~ 已决定全部纳入。
* ~~赞助商列表在设置中的位置？~~ 已决定新增独立一级标签，紧邻“供应商”。

## Requirements (evolving)

* 侧边栏新增 AI Token 中转站图标入口，并带持续但克制的动画效果；按钮具备中英文 title/aria-label。
* 动画不新增持久化设置；CSS/组件需尊重系统 `prefers-reduced-motion` 偏好。
* 点击入口打开设置并定位到赞助商列表；返回/关闭设置后保持现有设置行为不变。
* 赞助商列表展示 Fluxion 的品类、标题、简介、福利、Logo/横幅和注册按钮。
* 所有跳转链接均为指定 Fluxion 注册 URL。
* 原生供应商目录内置 Fluxion 默认项，API Key 初始为空，不能要求用户在首次启动时输入密钥。
* 供应商相关注册入口提供辅助说明，文案与截图示例的“先注册获取 Key、再回填配置”意图一致，并支持中英文。
* 赞助商卡片与 Fluxion 供应商 API Key 输入区域均显示“去注册/获取 API Key”链接和简短说明，链接值完全一致。
* 外部链接调用失败时显示本地化 toast；赞助商图片随应用打包，离线时仍可渲染；入口动画遵循 `prefers-reduced-motion`。
* 设置导航新增“赞助商”一级标签，紧邻“供应商”，侧边栏入口直接打开该标签。
* Fluxion 默认供应商在 Claude、Codex、Grok Build 三个 `app_type` 均幂等创建。
* 默认配置按协议预填：Claude 使用官网根地址与 Auth Token 字段，Codex 使用 `/v1` 地址；模型字段留空，Grok Build 不做未经确认的协议推断；API Key 数量保持为 0。
* Fluxion 默认项置于每个 `app_type` 的首位并作为无历史选择时的默认选中项，`is_current` 保持 false，不覆盖已有当前供应商。

## Acceptance Criteria (evolving)

* [ ] 展开与折叠侧边栏都能看到 AI Token 入口，动画不影响布局和键盘操作。
* [ ] 点击入口后设置弹层直接显示赞助商列表；键盘 Enter/Space 与鼠标行为一致。
* [ ] Fluxion 卡片在中英文下文案完整，Logo/横幅清晰，注册链接点击后为精确 URL。
* [ ] 新安装/空 providers.db 初始化后，目标 app 类型中存在 Fluxion 默认供应商，Key 数量为 0；重复初始化不会产生重复记录。
* [ ] 现有用户升级不会覆盖已有供应商、当前供应商或 Key；默认项仅在缺失时幂等补齐。
* [ ] `npx tsc --noEmit` 与 `cd src-tauri && cargo check` 通过；相关单元测试覆盖种子幂等与 UI 关键交互。
* [ ] `CHANGELOG.md`（版本 `TEMP`）与 `docs/功能清单.md` 更新。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* 中英文手动切换验证，新增用户可见文案无硬编码
* Docs/功能清单与 CHANGELOG 更新
* 评估已有脏文件与默认数据升级兼容性

## Out of Scope (explicit)

* 本次不实现在线动态拉取合作商目录或远程 CMS。
* 本次不改造现有供应商 CRUD、路由、故障转移等业务流程。
* 本次不新增新的第三方依赖。

## Technical Notes

* 需要先读取 `.trellis/spec/frontend/*` 与 `.trellis/spec/backend/*` 相关契约，再进入实现。
* 新增/修改函数前必须按 AGENTS.md 使用 GitNexus `gitnexus_impact` 做上游影响分析；提交前运行 `gitnexus_detect_changes()`。
* 新功能场景矩阵至少覆盖：窗口焦点/失焦、侧边栏展开/折叠、设置弹层已打开/关闭、键盘/鼠标、首次初始化/升级已有数据库、无网络打开注册链接、中文/英文语言。
