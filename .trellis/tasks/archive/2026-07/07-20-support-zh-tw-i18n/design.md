# support-zh-tw-i18n design

## Scope

前端国际化增强，覆盖：

- 语言类型与持久化：`src/lib/i18n.ts`、`src/stores/settingsStore.ts`
- 设置入口：`src/components/settings/pages/GeneralSettingsPage.tsx`
- 双语分支回退：多个 `language === "zh-CN" ? zh : en` 场景
- 日期/数字 locale：多个 `Intl.*("zh-CN")` 与 `toLocaleString("zh-CN")` 场景
- 桌宠本地化回退：`src/lib/desktopPet.ts`、`src/hooks/useDesktopPetCoordinator.ts`、`src/desktop-pet/DesktopPetApp.tsx`
- Trellis 国际化规范：`.trellis/spec/frontend/component-guidelines.md`

## Root-Cause Statement

当前国际化实现把“中文”错误等同于 `zh-CN`，导致语言类型、自动识别、双语分支和日期数字格式化都以内建简体中文为唯一中文分支；修复必须落在 `i18n` 主入口及其共用 helper，而不是继续在各消费组件补条件分支。

## Discovery List

- `src/lib/i18n.ts`
  - `AppLanguage`、`LANGUAGE_OPTIONS`、`detectPreferredLanguage()`、`resolveLanguagePreference()`、`translate()`、`useI18n()` 为主入口。
  - 发现 `dictionaries` 当前仅包含 `zh-CN`、`en-US`。
- `src/stores/settingsStore.ts`
  - `LanguagePreference` 与 `migrateLanguagePreference()` 约束语言持久化。
- `src/components/settings/pages/GeneralSettingsPage.tsx`
  - 使用 `LANGUAGE_OPTIONS` 渲染语言选择。
- `src/lib/desktopPet.ts`
  - `PetLocalizedText` 与 `DesktopPetConfigPayload.language` 仅支持双语。
  - `localizedPetText()` 当前非英文一律回退 `zh-CN`。
- `src/hooks/useDesktopPetCoordinator.ts`
  - 发送给桌宠窗口的配置把非英文语言统一压成 `zh-CN`。
- `src/desktop-pet/DesktopPetApp.tsx`
  - 默认桌宠文案硬编码 `zh-CN`。
- 多个组件存在中文/英文二选一分支和 `Intl("zh-CN")` 硬编码，已通过 `rg` 发现，主要集中在 `settings/`、`stats/`、`history/`、`desktop-pet/`。

## Technical Approach

### 1. 在 `i18n` 主入口增加三类能力

- 语言类型扩展为 `zh-CN | zh-TW | en-US`
- 新增统一 helper：
  - `isEnglishLanguage(language)`
  - `isChineseLanguage(language)`
  - `pickByLanguage(language, zh, en)`
  - `getLocale(language)` / `getDateTimeLocale(language)` / `getNumberLocale(language)`
- 自动识别规则：
  - `zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant` 系列 => `zh-TW`
  - `zh` / `zh-CN` / `zh-Hans` / `zh-SG` / `zh-MY` 系列 => `zh-CN`
  - 其他 => `en-US`

### 2. 用 `opencc-js` 生成 `zh-TW` 字典

- 新增依赖：`opencc-js@1.4.1`
- 从现有 `zh` 字典生成 `zh-TW`：
  - 默认 `cn -> tw`
  - 允许少量覆写词条，对术语或 UI 标点做修正
- `dictionaries["zh-TW"]` 不手写整份静态对象，避免 5000+ key 复制维护

### 3. 收口中文/英文二分逻辑

- 把 `language === "zh-CN" ? zh : en` 改为统一 helper，保证 `zh-TW` 落在中文分支
- 对本地化资源只有 `zh-CN/en-US` 的地方，`zh-TW` 继续回退到 `zh-CN`

### 4. 收口 locale 格式化

- 中文简体 => `zh-CN`
- 中文繁体 => `zh-TW`
- 英文 => 维持现有英文策略
- 替换散落在组件里的 `Intl.NumberFormat("zh-CN")` / `Intl.DateTimeFormat("zh-CN")`

## Compatibility

- 已保存的 `auto` / `zh-CN` / `en-US` 设置继续有效
- 新增 `zh-TW` 后，旧版本不会读这个值；本次只保证当前版本内行为正确
- 桌宠 manifest、catalog 等双语资源结构不扩 schema，`zh-TW` 回退到 `zh-CN`

## Risk Notes

- `opencc-js` 为运行时转换，首次模块初始化会多一次字典构建；但仅在前端加载时执行一次，风险可控
- 个别台湾地区术语可能不符合预期，需要用 override 做点修补
- 若漏改某些 `language === "zh-CN"` 分支，会出现“主文案繁体了，但局部仍显示英文/简体”的不一致
