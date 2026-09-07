# 供应商密钥维护 - 激活自动应用 + 页面访问缓存 + Switch 视觉修复

## Goal

三个改进：当前供应商切换激活密钥后自动写入全局配置文件，无需手动 Apply；供应商维护页面记住上次访问的供应商和详情 Tab；活动密钥的 Switch 开关在禁用态下仍正确显示已启用状态。

## Changelog Target

`[TEMP]`

## Confirmed Facts（代码检查确认）

### 问题 1：激活 key 不自动应用

- `handleActivateKey`（`src/components/settings/pages/NativeProviderSettingsPage.tsx:158-162`）检查 `wasCurrent` 后弹 toast 提示 "activeKeyChanged"，但**不调 `applyGlobal`**。
- 后端 `activate_key_in_transaction`（`src-tauri/src/provider/repository/keys.rs:56-75`）在同一事务内把选中 key 投影到 `providers.settings_config`，即数据库里的全局配置已更新。
- 但写入 Claude/Codex/Grok 配置文件（`~/.codex/auth.json` 等）需要额外调 `provider_global_apply`（`src-tauri/src/provider/global.rs`）。
- `useNativeProviderHome` hook 的 `applyGlobal`（`src/components/settings/providers/useNativeProviderHome.ts:221-238`）在前端可调用，但激活路径未连接。

### 问题 2：页面无访问缓存

- `NativeProviderSettingsPage`（`src/components/settings/pages/NativeProviderSettingsPage.tsx:72-77`）中 `appType`、`detailView` 都初始化为默认值（`NATIVE_PROVIDER_APP_TYPES[0]`、`DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW`）。
- `useNativeProviderCatalog`（`src/components/settings/providers/useNativeProviderCatalog.tsx:44-51`）中 `selectedProviderId` 同样无持久化。
- `nativeProviderDetailView.ts:12` 的 `resetNativeProviderDetailView()` 固定返回 `"basic"`。
- 离开页面再回来，所有选择丢失。

### 问题 3：活动密钥 Switch 视觉混淆

- `NativeProviderKeySection`（`src/components/settings/providers/NativeProviderKeySection.tsx:227-233`）对 `key.isActive` 的密钥设 `disabled`，Switch 变灰。
- Mantine Switch 在 `disabled` + `checked` 时 track 颜色变灰，用户视觉上误以为密钥被停用。
- 实际上该密钥的 `enabled=1`、`isActive=1`，只是不允许用 Switch 直接关闭活动密钥。

## Requirements

### R1: 当前供应商激活密钥时自动 Apply

- 在 `handleActivateKey` 中，若被激活密钥所在供应商是 `isCurrent`，激活成功后**静默自动调用 `applyGlobal`** 写配置文件。
- 无需确认弹窗——用户点击"启用"时意图已明确。
- Apply 成功 toast 提示成功；Apply 失败 toast 提示错误，不回滚已完成的激活。

### R2: 供应商维护页面记住访问状态

- 记住**当前 App Type Tab**（claude/codex/grokbuild）——跨页面导航后恢复。
- 记住**上次选中的供应商 ID**——回到页面时恢复选中。
- 记住**详情 Tab**（basic/effective/keys/documents）——按供应商分 key 存储，切换供应商时恢复该供应商上次的详情 Tab。
- 缓存仅在同一会话有效，不需要跨应用重启持久化（内存级即可）。

### R3: 活动密钥 Switch 视觉修复

- `isActive` 的密钥 Switch 保持 `disabled`（不可切换），但视觉上必须区分"已启用但不可操作"和"已停用"。
- 方案：Switch 保持 `checked={true}`（活动密钥必然已启用），使用 `color="cliPrimary"` 不做灰化；利用 tooltip 文字说明不可操作的原因。

## Acceptance Criteria

- [ ] AC1: 当前供应商的密钥被激活后，全局配置文件被自动更新，新启动的 Claude/Codex/Grok 使用新密钥。
- [ ] AC2: 当前供应商激活密钥 apply 失败时，提示错误但不回滚已完成的激活。
- [ ] AC3: 非当前供应商激活密钥时，行为不变（不触发 apply）。
- [ ] AC4: 离开 Native Provider 页面再回来，App Type Tab 保持之前选择。
- [ ] AC5: 离开 Native Provider 页面再回来，之前选中的供应商恢复选中。
- [ ] AC6: 切换供应商后，详情 Tab 恢复到该供应商上次选择的 Tab；新选中的供应商默认显示 basic。
- [ ] AC7: 活动密钥的 Switch 在禁用状态下视觉上仍是"已启用"，不会让人误以为被停用。

## Out of Scope

- 跨应用重启的缓存持久化（localStorage/数据库存储）。
- isCurrent 供应商切换激活密钥的 undo/回滚机制。
- 修改 Switch 尺寸或位置。

## Open Questions

（无——三个问题均通过代码检查确认根因）
