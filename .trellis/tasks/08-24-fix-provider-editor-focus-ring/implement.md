# 修复供应商编辑关闭后的焦点残留：实施计划

1. 在 `NativeProviderDetailModal` 暴露退出完成回调，并将该 Modal 的自动 `returnFocus` 关闭；保留 `trapFocus`、Escape 和遮罩关闭行为。
2. 在 `NativeProviderSettingsPage` 为现有 surface 导航持有 ref；用 one-shot close ref 实现只在已接受关闭、目录仍可见且导航节点已连接时运行的退出后焦点回调，并将已选 radio input 聚焦后传给详情 Modal；不要新增可聚焦页面根节点。
3. 扩展 `scripts/nativeProviderCatalogSelection.test.mjs`，断言：详情 Modal 禁用自动行焦点返回、退出后调用页面焦点回调，焦点落在既有目录 surface 导航的已选 radio，且既有目录 selected 契约仍存在。
4. 更新 `CHANGELOG.md` 的 `TEMP` 条目和 `docs/功能清单.md` 中原生供应商管理条目。
5. 验证：聚焦脚本测试、`npx tsc --noEmit`、`npm run build`、`git diff --check`；运行 GitNexus `detect_changes()` 复核影响范围。
6. 手动桌面验证：对 Claude、Codex、Grok Build 各打开并关闭详情；用鼠标、遮罩、关闭按钮和 Escape 关闭；验证表单取消/保存先回详情、再关闭详情后可继续 Tab 导航且列表行没有残留焦点环。
