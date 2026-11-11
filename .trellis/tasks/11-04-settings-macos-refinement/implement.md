# 实施与验证

- [x] 分支同步检查、方案确认、分诊与架构约束阅读、索引刷新。
- [x] 影响分析；设置主题适配、分组和设置行。
- [x] 外壳、导航、标题、响应式布局、通用和终端设置。
- [x] 其余设置页、列表及 Portal 浮层；语义状态与主题兼容实现。
- [x] 定向回归：extensionsSettingsLayout、extensionsMcpSaving、nativeProviderCatalogSelection、defaultThemeSettings、workspaceBackgroundLayout。
- [x] npm run build；npm run check:architecture -- --strict。
- [x] 最终 git diff --check；TEMP、功能清单与视觉契约；GitNexus detect_changes 完整结果归档。
- [x] 记录人工验收矩阵，详见 validation.md。
- [ ] 人工桌面验收及一次性提交确认。

项目禁止启动桌面应用/服务做自动 UI 验证；实际桌面效果待人工验收。

补充回归发现一项已有 OSC 52 测试引用旧变量名而失败，相关测试和终端源码均与 HEAD 相同；见 validation.md。
