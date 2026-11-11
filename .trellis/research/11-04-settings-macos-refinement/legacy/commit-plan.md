# 提交清单（待确认）

拟创建一个本地提交：`feat(settings): refine macOS-style settings UI`。

范围：设置视觉、响应式布局、焦点过滤、设置弹窗外观隔离、赞助配置公开入口、对应回归及交付记录。`lib/sponsors.ts` 删除与 `api/sponsors.ts` 新建是实现迁移。

当前清单全部来自本任务，无未识别的用户改动。代码尚未暂存或提交；只在一次性确认后执行此清单，不推送。人工桌面验收与已知测试限制见 validation.md。

## 文件

- `.trellis/spec/frontend/index.md`
- `.trellis/spec/frontend/settings-visual-contracts.md`
- `.trellis/tasks/11-04-settings-macos-refinement/check.jsonl`
- `.trellis/tasks/11-04-settings-macos-refinement/commit-plan.md`
- `.trellis/tasks/11-04-settings-macos-refinement/design.md`
- `.trellis/tasks/11-04-settings-macos-refinement/implement.jsonl`
- `.trellis/tasks/11-04-settings-macos-refinement/implement.md`
- `.trellis/tasks/11-04-settings-macos-refinement/prd.md`
- `.trellis/tasks/11-04-settings-macos-refinement/task.json`
- `.trellis/tasks/11-04-settings-macos-refinement/validation.md`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `scripts/nativeProviderEditing.test.mjs`
- `scripts/settingsDialog.test.mjs`
- `scripts/settingsFocus.test.mjs`
- `scripts/settingsPresentation.test.mjs`
- `src/features/projects/components/SidebarFooter.tsx`
- `src/features/settings/api/SettingsModal.tsx`
- `src/features/settings/api/sponsors.ts`
- `src/features/settings/components/HookSettingsControls.tsx`
- `src/features/settings/components/SettingsLayout.tsx`
- `src/features/settings/components/SettingsListItem.tsx`
- `src/features/settings/components/SettingsNav.tsx`
- `src/features/settings/components/SettingsPrimitives.tsx`
- `src/features/settings/components/SettingsThemeProvider.tsx`
- `src/features/settings/components/SettingsTopBar.tsx`
- `src/features/settings/components/WebDeviceSettingsSection.tsx`
- `src/features/settings/components/WebServerSettingsSection.tsx`
- `src/features/settings/components/pages/CommandSuggestionSettingsPage.tsx`
- `src/features/settings/components/pages/DataStorageSection.tsx`
- `src/features/settings/components/pages/DeveloperSettingsPage.tsx`
- `src/features/settings/components/pages/GeneralSettingsPage.tsx`
- `src/features/settings/components/pages/ModelPricingSettingsPage.tsx`
- `src/features/settings/components/pages/PerformanceSettingsSection.tsx`
- `src/features/settings/components/pages/ShortcutSettingsPage.tsx`
- `src/features/settings/components/pages/SidebarSettingsPage.tsx`
- `src/features/settings/components/pages/SponsorsSettingsPage.tsx`
- `src/features/settings/components/pages/SshCliIntegrationDialog.tsx`
- `src/features/settings/components/pages/SshConfigImportDialog.tsx`
- `src/features/settings/components/pages/SshHostEditor.tsx`
- `src/features/settings/components/pages/SyncSettingsPage.tsx`
- `src/features/settings/components/pages/TemplateSettingsPage.tsx`
- `src/features/settings/components/pages/TerminalThemePresetGrid.tsx`
- `src/features/settings/components/pages/ThemeSettingsPage.tsx`
- `src/features/settings/components/providers/NativeProviderCard.tsx`
- `src/features/settings/components/providers/NativeProviderEditor.tsx`
- `src/features/settings/components/providers/NativeProviderFormModal.tsx`
- `src/features/settings/lib/sponsors.ts`
- `src/shared/hooks/useFocusTrap.ts`
- `src/shared/ui/dialog.tsx`
- `src/styles/components.css`
- `src/styles/components/settings.css`
