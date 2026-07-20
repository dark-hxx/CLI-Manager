# support-zh-tw-i18n

## Goal

为 CLI-Manager 增加繁体中文（`zh-TW`）界面支持，使用户可以在设置中显式选择繁体中文，并让自动语言识别在繁体中文系统环境下落到繁体中文。

## Changelog Target

[V1.3.0]

## Confirmed Facts

- 当前国际化核心入口在 `src/lib/i18n.ts`，现有语言仅包含 `zh-CN` 与 `en-US`。
- 语言偏好持久化定义在 `src/stores/settingsStore.ts`，当前仅允许 `auto | zh-CN | en-US`。
- 语言选择 UI 位于 `src/components/settings/pages/GeneralSettingsPage.tsx`。
- 仓库中除翻译字典外，还存在多处 `language === "zh-CN"`、`language === "en-US"`、`Intl.DateTimeFormat("zh-CN")`、`Intl.NumberFormat("zh-CN")` 等硬编码分支。
- 桌宠相关文本与 manifest 本地化结构当前只支持 `zh-CN` / `en-US`。
- 当前分支 `master` 的远端 `origin/master` 领先本地 3 个提交；用户已明确要求本次先忽略远端更新，仅做本地开发。

## Requirements

- 新增 `zh-TW` 作为可选语言，并可在设置页中选择。
- 自动语言识别需要识别繁体中文环境（至少覆盖 `zh-TW` / `zh-HK` / `zh-MO` 相关前缀）。
- 所有基于 `useI18n()` 的用户可见文案在 `zh-TW` 下应展示繁体中文。
- 现有散落的中文/英文分支与日期数字格式化逻辑需要支持 `zh-TW`，不能继续把“所有中文”都硬编码为 `zh-CN`。
- 对仅支持 `zh-CN` / `en-US` 的结构化资源，允许在本次范围内对 `zh-TW` 回退到 `zh-CN`，前提是不影响界面正常工作。
- 需要更新 `.trellis/spec/frontend/component-guidelines.md`、`CHANGELOG.md` 与 `docs/功能清单.md`。

## Constraints

- 不擅自升级框架或大版本依赖。
- 尽量复用现有 i18n 结构，避免把同一套语言判断继续复制到更多文件。
- 本次先以本地开发为准，不处理远端同步。

## Out Of Scope

- 不扩展桌宠 catalog / manifest 的数据 schema 到三语言结构。
- 不顺手重构无关页面或主题逻辑。
- 不处理远端 `master` 合并或 rebase。

## Decisions

- 繁体中文文案采用“以现有 `zh-CN` 文案为基底，使用转换/映射生成 `zh-TW`”的方案落地。
- 允许对少量术语做人工覆写，但不维护一整套独立人工 `zh-TW` 字典。
- 接受新增轻量级繁简转换依赖，以避免手写维护大规模转换表。

## Acceptance Criteria

- [x] 设置页语言选项新增繁体中文，切换后即时生效并可持久化。
- [x] 当系统语言为繁体中文区域值时，`auto` 模式解析为 `zh-TW`。
- [x] 主翻译入口支持 `zh-TW`，且缺失场景有明确回退，不出现运行时错误。
- [x] 日期、时间、数字等格式化在 `zh-TW` 下不再错误使用 `zh-CN` 作为唯一中文 locale。
- [x] 桌宠及其他仅双语资源在 `zh-TW` 下可正常显示，允许临时回退到简体资源，但不能报错或空白。
- [x] `.trellis/spec/frontend/component-guidelines.md`、`CHANGELOG.md` 与 `docs/功能清单.md` 已更新。
