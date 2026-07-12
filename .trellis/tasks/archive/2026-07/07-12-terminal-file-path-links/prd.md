# 终端文件路径快捷打开

## Goal

让用户可以直接点击终端输出中的绝对文件路径，快速打开对应文件。

Changelog Target: `[TEMP]`

## Requirements

- 使用 xterm `LinkProvider` 识别 Windows、UNC/WSL UNC 和可安全转换的 Linux 绝对路径。
- 项目或工作树内文件使用 CLI-Manager 内置文件编辑器打开。
- 项目外文件回退到系统默认应用打开。
- 不识别相对路径或 `file:line:column`，不改变现有 HTTP/OSC 8 链接行为。
- 去除终端输出中紧随路径的常见中英文标点。
- 不新增依赖、数据库字段或 Tauri command。

## Acceptance Criteria

- [ ] `D:\\dir\\file.png` 与 `D:/dir/file.png` 可点击。
- [ ] 项目/工作树内文件在内置编辑器打开，项目外文件由系统默认应用打开。
- [ ] UNC、WSL UNC、`/mnt/<drive>` 路径按现有项目上下文正确解析。
- [ ] 不存在或无法打开的文件显示错误，不影响终端继续使用。
- [ ] HTTP/HTTPS、OSC 8、文本选择、复制和输入行为无回归。
- [ ] `npx tsc --noEmit` 通过。

## Notes

- 已确认采用混合打开模式，首版仅识别绝对路径。
- GitNexus 本地索引库缺失；实施前重新尝试索引和影响分析。
