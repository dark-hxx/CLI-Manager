# Fluxion AI token 中转站入口与默认供应商设计

## 1. 设计目标与边界

本次改动在现有设置/供应商域上增加一个本地赞助商展示入口，并为现有
`providers.db` 增加幂等的 Fluxion 初始记录。不会新增 Tauri command、SQLite
表、第三方依赖或远程目录服务；注册链接由前端外部 opener 打开，展示素材
全部随前端构建产物打包。

## 2. 前端数据流与接口

```text
SidebarFooter
  └─ onOpenSettings("sponsors")
       └─ App.handleOpenSettings
            └─ SettingsModal(activeTab="sponsors")
                 └─ SponsorsSettingsPage (静态 Fluxion 卡片)

NativeProviderFormModal (provider.name === "Fluxion AI")
  └─ API Key description CTA
       └─ openUrl(FLUXION_REGISTER_URL) + localized toast on error
```

* `SettingsTab` 和 `settingsStore.lastSettingsTab` 增加 `sponsors`，标签顺序放在
  `native-providers` 后面；现有设置持久化/恢复逻辑保持不变。
* 新增 `src/lib/sponsors.ts` 作为前端唯一注册链接常量来源，并导出
  `FLUXION_REGISTER_URL`。赞助商页与供应商表单均从该模块引用，不复制 URL。
* `SponsorsSettingsPage` 直接使用 `docs/img2/fluxion.png`（横幅）与
  `docs/img2/fluxion-logo.png`（带品牌字标 Logo）静态导入；失败 toast 使用 `useI18n()`。
  页面至少包含语义化标题、品类、简介、福利兑换码和 CTA，图片提供本地化
  `alt` 文案，不依赖网络请求。
* 侧边栏入口使用现有 Lucide 图标体系（`Sparkles`/`Zap` 组合或等价图标）和
  新 CSS class。动画为低幅度 opacity/transform 或 box-shadow 呼吸效果；
  `@media (prefers-reduced-motion: reduce)` 将动画时长设为 0/animation none。
  展开与折叠 footer 都渲染同一按钮，保留 `ui-focus-ring`、`title`、`aria-label`
  和 Enter/Space 原生 button 行为。
* Fluxion Key 区在编辑已存在 Fluxion provider 时追加链接和简短说明；新建
  非 Fluxion provider 不显示该特例。已有 Key 提示仍保留，CTA 不改变密钥
  草稿/提交逻辑。打开链接失败通过 `toast.error(t(...))` 反馈，不展示原始异常。

## 3. Backend provider seed

在 `src-tauri/src/provider/database.rs` 的 `initialize()` 流程完成 schema/settings
初始化后调用 `ensure_builtin_fluxion_providers`。该函数在单独 SQLite transaction
中循环三个固定规格：

| app_type | stable id | settings_config | sort/current |
| --- | --- | --- | --- |
| `claude` | `builtin-fluxion-claude` | JSON `env.ANTHROPIC_BASE_URL=https://www.fluxionai.space`，`api_format=anthropic` | `MIN(sort_index)-1`, `is_current=0` |
| `codex` | `builtin-fluxion-codex` | JSON envelope，`base_url=https://www.fluxionai.space/v1`，`config` 为 Responses + `model_providers.custom.base_url` 的 TOML | `MIN(sort_index)-1`, `is_current=0` |
| `grokbuild` | `builtin-fluxion-grokbuild` | 空对象 `{}`，不推断 Grok 专用 endpoint/model | `MIN(sort_index)-1`, `is_current=0` |

每条记录设置 `name=Fluxion AI`、`website_url` 为同一注册 URL、启用状态为 true、
`commonConfigEnabled=true`，不插入 `provider_api_keys`。使用 `INSERT OR IGNORE`
按 `(id, app_type)` 幂等补齐；已存在的记录（包括用户改名、排序、Key 或
`is_current` 状态）完全跳过，不覆盖任何用户数据。初始最小排序值仅用于缺失
时把内置项放在列表首位；用户后续拖拽排序会正常覆盖它。

`is_current=0` 是刻意的：空 Key provider 只能作为默认选中/首项，不能伪装成已
应用且可运行的全局 provider。现有 `useNativeProviderCatalog.defaultProviderId`
会在无历史选择时优先 `is_current`，否则使用排序后的第一项，因此满足默认选中
语义并保留已有当前 provider。

种子失败应让 provider 初始化返回错误，由现有启动层按可选 provider 数据库失败
策略记录 warning；不新增 command 或改变其它启动链路。

## 4. i18n 与文案

在 `src/lib/i18n.ts` 的 zh/en 两组中新增：

* `settings.tabs.sponsors.{label,title,description}`
* `sidebar.tokenStation`、`sidebar.openTokenStation`
* `sponsors.fluxion.{name,category,title,description,benefitLabel,benefitDescription,register,openFailed,logoAlt,bannerAlt}`
* `providerCatalog.fluxion.{getApiKey,description,openFailed}`

繁体继续通过现有转换逻辑生成；不在 JSX 中硬编码新增可见中文/英文。英文
描述保留兑换码 `CLIMANAGER` 与品牌名 `Fluxion AI`。

## 5. Compatibility and safety

* 不修改既有 Tauri command 签名；`providers.db` schema version 保持 2，种子是
  可回滚的 INSERT-only 数据补齐，不触碰历史 `cli-manager.db` migrations。
* 外部 URL 仍经 `@tauri-apps/plugin-opener`，只使用固定常量，不把用户输入
  拼接进目标地址。
* 本地图片导入由 Vite 打包，赞助商页无网络依赖；链接不可用仅 toast，不影响
  设置弹层或 provider 编辑。
* 不修改用户已有 `docs/img2` 文件；新增代码只引用现有素材。

## 6. Verification strategy

* Rust: 为 seed helper 添加单元/异步测试，覆盖 fresh DB 三类记录、空 Key、
  最小 sort_index、`is_current=0`、重复 initialize 无重复，以及已有当前 provider
  和已有 Fluxion 记录不被覆盖。
* Frontend: `npx tsc --noEmit` / `npm run build`；静态检查 `sponsors` tab 在
  `SettingsModal`、`settingsStore`、sidebar 两种布局均有触点。运行时手测中英文、
  键盘激活、减少动效媒体查询、链接失败 toast 和离线图片显示。
* 提交前运行 GitNexus `gitnexus_detect_changes()`，确认只涉及计划中的设置、
  侧边栏、provider seed、i18n、文档和图片引用。
