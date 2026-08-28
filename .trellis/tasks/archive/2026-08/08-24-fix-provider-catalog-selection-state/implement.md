# 修复供应商列表残留选中态 - Implementation Plan

1. 在 `NativeProviderSettingsPage` 的 `NativeProviderCatalog` 调用处，将视觉用 `selectedProviderId` 限制为详情弹窗打开期间。
2. 更新 `CHANGELOG.md` 的 `TEMP` 版本条目和 `docs/功能清单.md` 的供应商目录说明。
3. 添加并执行 `node --test scripts/nativeProviderCatalogSelection.test.mjs`，再执行 `npx tsc --noEmit`、`npm run build`、diff 检查与 GitNexus 受影响范围检查。
4. 在可运行的桌面环境中手动验证：打开供应商详情 -> 编辑 -> 关闭详情，目录不再保留选中行；再次打开详情和新增供应商的选择上下文正常。
