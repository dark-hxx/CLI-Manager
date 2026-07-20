# support-zh-tw-i18n implement

## Ordered Checklist

- [x] 1. 扩展语言类型与设置持久化
  - 修改 `src/lib/i18n.ts`
  - 修改 `src/stores/settingsStore.ts`
- [x] 2. 引入 `opencc-js@1.4.1` 并生成 `zh-TW` 字典
  - 更新 `package.json`
  - 更新 `package-lock.json`
- [x] 3. 增加统一语言 helper，替换核心双语/locale 逻辑
  - 先改 `i18n` 主入口
  - 再批量修正 `settings/`、`stats/`、`history/`、`desktop-pet/` 受影响文件
- [x] 4. 处理桌宠本地化回退
  - 修改 `src/lib/desktopPet.ts`
  - 修改 `src/hooks/useDesktopPetCoordinator.ts`
  - 修改 `src/desktop-pet/DesktopPetApp.tsx`
- [x] 5. 更新文档
  - 更新 `.trellis/spec/frontend/component-guidelines.md`
  - 更新 `CHANGELOG.md`（目标 `V1.3.0`）
  - 更新 `docs/功能清单.md`
- [x] 6. 验证
  - 运行 `npx tsc --noEmit`
  - 人工复核 `zh-TW` 类型收口和主要格式化路径
  - 根据用户回归反馈补齐桌宠、Git 面板、关闭确认两类弹框等残余简体文案

## Validation Plan

- 类型检查：`npx tsc --noEmit`
- 搜索回归：
  - `rg -n 'language === "zh-CN"' src`
  - `rg -n 'Intl\\.(DateTimeFormat|NumberFormat)\\("zh-CN"' src`
  - `rg -n 'toLocaleString\\("zh-CN"' src`

## Risky Files

- `src/lib/i18n.ts`
  - 翻译主入口，影响全局
- `src/stores/settingsStore.ts`
  - 影响设置迁移与持久化
- `src/lib/desktopPet.ts`
  - 影响桌宠窗口 payload 类型

## Rollback Notes

- 若 `opencc-js` 引入后类型或打包异常，先保留语言类型与 locale helper 改动，再回退依赖接入层，确认问题是否来自包导入方式。
- 若个别页面出现繁体/英文混杂，优先检查是否漏改 `language === "zh-CN"` 分支。
