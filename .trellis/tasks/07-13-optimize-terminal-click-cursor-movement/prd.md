# 优化终端点击光标快速定位

## Goal

终端输入较长文本时，点击输入内容中的目标字符，应尽快将行编辑器光标移动到目标位置，避免从当前位置逐字符播放长距离移动动画。

## Requirements

- 保留现有鼠标坐标到输入字符索引的计算逻辑。
- 根据当前位置、输入开头和输入末尾计算移动成本，选择控制指令最少的路径。
- 点击输入开头或末尾时，优先使用行首或行尾指令完成快速跳转。
- 点击中间位置时，在直接方向键移动、行首后右移、行尾后左移三种路径中选择最短路径。
- 保持 xterm 显示光标与 PowerShell、Bash、Claude Code、Codex 等 PTY 行编辑器内部光标同步。
- 不新增依赖，不修改终端输入坐标计算和输入缓冲区数据结构。

## Acceptance Criteria

- [ ] 长文本末尾点击首字符时，不再逐字符从末尾移动到开头。
- [ ] 点击末尾时可快速移动到输入末尾。
- [ ] 点击中间任意字符后，继续输入、删除时作用于正确位置。
- [ ] 中英文、宽字符及自动换行输入的点击位置计算保持正确。
- [ ] PowerShell 与 Git Bash 基础行编辑兼容；Claude Code、Codex 输入不出现明显回归。
- [ ] `npx tsc --noEmit` 通过。

## Definition of Done

- 完成最小代码修改并补充必要测试。
- 更新 `CHANGELOG.md` 和 `docs/功能清单.md`。
- 运行 GitNexus 影响分析与变更检测；若工具不可用，明确记录具体原因。

## Technical Approach

现有实现已经计算点击目标索引，但会重复发送单字符左右方向键。新增一个最短移动序列计算函数：比较当前位置直接移动、跳到行首后右移、跳到行尾后左移的指令数量，选择成本最低的方案。绝对终端光标定位不在本任务使用，因为它无法同步 PTY 内部行编辑器状态。

## Decision

- 采用跨行编辑器兼容性更高的 Home/End 锚点加少量方向键方案。
- 不采用仅修改 xterm 渲染光标的方案。
- 不采用清空并重输整行的方案，避免破坏撤销、历史和交互式 CLI 状态。

## Out of Scope

- 针对单一 Shell 调用私有光标定位 API。
- 重构终端输入缓冲区或鼠标选择逻辑。
- 添加新的终端或行编辑依赖。

## Changelog Target

`[TEMP]`

## Notes

- 主要实现文件：`src/components/XTermTerminal.tsx`。
- GitNexus 索引刷新曾因 `.gitnexus/lbug` 访问被拒绝而失败，实施前需再次检查。
- GNU Readline 支持行首/行尾与按字符移动；PSReadLine 默认支持 Home/End 的 BeginningOfLine/EndOfLine 绑定。
