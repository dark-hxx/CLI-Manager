# 实施计划

## 代码变更

- [x] 新增 `src/features/terminal/browser/TerminalPiOutputFilter.ts`，实现精确 advisory 匹配、跨帧残尾、有界缓存和 `reset()`。
- [x] 更新 `src/features/terminal/browser/TerminalPiCompatibility.ts`，在 Pi 激活时串接过滤器并在重置时清理状态。
- [x] 更新 `scripts/terminalPiCompatibility.test.mjs`，补充完整提示、所有切分边界、重复提示、相邻文本、非匹配文本和 reset 回归。
- [x] 更新 `CHANGELOG.md` 的 `V1.4.0` 终端相关条目。
- [x] 更新 `docs/功能清单.md` 的终端工作区条目。
- [x] 更新前端终端、跨层和跨平台规范，记录根因与防回归约束。

## 验证清单

- [x] `node --test scripts/terminalPiCompatibility.test.mjs`
- [x] `npx tsc --noEmit`
- [x] `npm run check:architecture -- --strict`
- [x] 执行终端输出相关的现有定向测试。
- [x] 检查 `git diff`、任务验收项、GitNexus 变更范围和新增函数注释。

## 人工验收场景

- Windows 11 + WSL，Pi 全屏 TUI，配置 75 个以上 direct tools：底部输入区保持可见可输入。
- 让 advisory 在不同 PTY 帧边界到达，并验证重复 advisory 不显示。
- 普通 Shell、其他 CLI、非匹配 MCP 提示和 Pi 退出后普通输出保持不变。
- 切换终端、回放/恢复会话后，输入区和普通输出不受旧残尾影响。
