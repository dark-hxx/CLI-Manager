# Commits

## 2026-05-23 — feat(terminal): add configurable newline shortcut for AI CLI

- **Branch**: feat/compact-mode-launcher
- **Context-Id**: 6ea303e0-c45f-4b69-88ab-4787e68fbd70
- **Files**:
  - src/stores/settingsStore.ts
  - src/components/XTermTerminal.tsx
  - src/components/settings/pages/ShortcutSettingsPage.tsx
- **Decisions**:
  - 默认 Shift+Enter，可切 Ctrl/Alt+Enter；通过 `useSettingsStore.getState()` 在按键时取最新值，避免重建 terminal
  - 拦截放在 `attachCustomKeyEventHandler` 顶部，单按 Enter 不进入分支，行为不变
  - 设置放在 ShortcutSettingsPage 顶部独立 section，不混入现有「录制式」快捷键列表（语义为固定三选一）
