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
