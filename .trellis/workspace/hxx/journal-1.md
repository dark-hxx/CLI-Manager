# Journal - hxx (Part 1)

> AI development session journal
> Started: 2026-05-22

---



## Session 1: 修复内部终端 diff 输出左侧色块错乱

**Date**: 2026-05-22
**Task**: 修复内部终端 diff 输出左侧色块错乱
**Branch**: `master`

### Summary

诊断为 PTY reader 在 chunk 边界切断 UTF-8 多字节字符与 ANSI CSI/OSC 序列，导致 xterm 残字节被解读为 SGR 参数污染背景色。后端新增 pty::boundary::safe_emit_boundary 纯函数（22 单测含穷举 stress_all_split_points_reconstruct），reader 线程接入边界保护 + 256KB 兜底；前端把模块级共享 TextDecoder 改成 per-session 实例 + stream 模式，WebglAddon 注册 onContextLoss 回落 Canvas。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e4c29cb` | (see git log) |
| `c5b806f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 发布 V0.1.4 版本与 CHANGELOG

**Date**: 2026-05-22
**Task**: 发布 V0.1.4 版本与 CHANGELOG
**Branch**: `master`

### Summary

汇总 V0.1.3 之后的 4 个 commit 写入 CHANGELOG（PTY 边界修复 / 性能优化 / Catppuccin+Gruvbox 5 套终端主题 / 工程内务），同步 4 处版本字段 0.1.3→0.1.4（package.json / Cargo.toml / tauri.conf.json / Cargo.lock）。另行提交本地 TODO 文件到 .trellis/workspace/hxx/TODO.md（终端换行快捷键可配置 + Tab 关闭按钮放大）。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `20b134f` | (see git log) |
| `742573a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Terminal background customization

**Date**: 2026-05-25
**Task**: Terminal background customization
**Branch**: `master`

### Summary

Implemented internal-terminal background image (JPEG/PNG/GIF) with opacity, fit, 9-grid position, blur, dark overlay, plus per-session right-click hide/show. Backend Tauri commands (save/cleanup/exists) with sha256 content-addressed naming, validate_relative_path + canonicalize defenses, assetProtocol scope locked to backgrounds/**. Frontend settingsStore migrate* pattern with transient missing flag; xterm allowTransparency set unconditionally at construction; applyTransparency now injects a darken-coupled cell alpha floor so glyph edges stay legible over high-frequency images. CSS wrapper uses z-index:0 (not isolation:isolate) to avoid GPU compositing promotion that downgrades DOM text rendering. Spec updates: new guides/tauri-user-file-security-checklist.md, plus state-management & component-guidelines additions.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `af2ac24` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: fix font color coverage to derive secondary/muted tokens

**Date**: 2026-05-25
**Task**: fix font color coverage to derive secondary/muted tokens
**Branch**: `master`

### Summary

Fixed uiTextColor only overriding --text-primary by also deriving --text-secondary (85% mix with bg) and --text-muted (60% mix) in App.tsx effect, so sidebar tree groups, command palette, settings subtitles and history panels follow the user-selected color. Updated PRD with Decision Amendment recording the scope expansion from PRD's original 'primary-only' assumption.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7cde1c6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Hook 自定义目录联动历史统计与历史列表分割修复

**Date**: 2026-06-04
**Task**: Hook 自定义目录联动历史统计与历史列表分割修复
**Branch**: `master`

### Summary

历史读取链路跟随 Claude/Codex Hook 自定义目录并隔离缓存；历史会话列表改为卡片式分割，补充右键删除入口。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `349dffc` | (see git log) |
| `648bbe9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Fix Windows PowerShell paste and scrollback

**Date**: 2026-06-08
**Task**: Fix Windows PowerShell paste and scrollback
**Branch**: `fix/windows-terminal-powershell-paste`

### Summary

Fixed Windows PowerShell terminal history disappearing after resize/tab changes and restored native xterm paste semantics to prevent multiline paste corruption.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d15495d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: Settings UI 修复收尾与侧边栏项目树 UX 优化

**Date**: 2026-06-10
**Task**: Settings UI 修复收尾与侧边栏项目树 UX 优化
**Branch**: `master`

### Summary

提交 settings UI 重构修复（主色 10 级色阶+primaryShade、快捷键页按钮组替换 SegmentedControl、主题页 sticky 预览、scrollbar-gutter）与死代码/未用依赖/shell 插件清理；实现侧边栏项目树优化：目录折叠状态持久化到 settingsStore（含失效记录自愈清理）、行内悬浮按钮精简为仅启动、右键菜单加图标+分隔线分组并收紧密度；CHANGELOG 记录 V0.2.8 条目。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `75e1ede` | (see git log) |
| `0383611` | (see git log) |
| `f51eb81` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: Windows 闪窗修复与设置/侧栏 UX 修复

**Date**: 2026-06-10
**Task**: Windows 闪窗修复与设置/侧栏 UX 修复
**Branch**: `master`

### Summary

修复 GUI 进程静默 spawn 未设 CREATE_NO_WINDOW 导致的 ccusage 面板/Git Bash 解析 CMD 闪窗（silent_command helper）；修复终端预览 sticky 被 Mantine 无 layer position:relative 覆盖的问题（wrapper div 承载 xl:sticky）；项目右键新增打开所在目录（openPath + 带 scope 的 opener:allow-open-path）；应用字体颜色控件打磨并修复偶尔才生效的两个根因（取色器 onChange 实时提交、对比度门槛 4.5→1.6 且不再静默丢弃，新增 src/lib/contrast.ts 共享工具与可见反馈）；变更计入 CHANGELOG V1.0.1 段。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7839e34` | (see git log) |
| `f5c43ea` | (see git log) |
| `4b4108b` | (see git log) |
| `1680b6b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
