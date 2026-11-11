# 提交与推送计划

## 1. fix(web): 修复内网配置引导与 Tap 项目分组

- src/features/settings/components/WebServerSettingsSection.tsx
- src/features/settings/components/WebDeviceSettingsSection.tsx
- src/features/settings/lib/webSettingsDraft.ts
- src/features/settings/lib/webNetworkGuidance.ts
- src/features/settings/lib/webNetworkSettings.test.mjs
- src/shared/i18n/messages/settings.zh-CN.ts
- src/shared/i18n/messages/settings.en-US.ts
- apps/web-tap/src/projectTree.ts
- apps/web-tap/src/projectTree.test.mjs
- apps/web-tap/src/Sidebar.tsx
- apps/web-tap/src/Settings.tsx
- apps/web-tap/src/i18n.ts
- apps/web-tap/src/panels.css
- CHANGELOG.md
- docs/功能清单.md
- .trellis/spec/backend/web-service-contracts.md
- .trellis/tasks/10-17-web-network-config-save/（需求、设计、计划、验证、浏览器 fixture 与截图）

## 不纳入本次提交

- apps/web-tap/USAGE.md：任务开始前已有的未跟踪文件，本次未修改。
- .trellis/tasks/00-join-hxx/：后续轮次新增的用户工作目录，本次未修改。

2026-10-17 用户已验证当前修复，并明确授权执行本次提交、推送至对应 PR。
目标：PR #287，nnnmdzz/CLI-Manager:feat/optional-tap-web；正常追加提交，不强制推送，不包含仅讨论的对话阅读布局。
