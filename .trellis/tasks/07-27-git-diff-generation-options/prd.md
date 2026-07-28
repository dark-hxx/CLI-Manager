# 扩展 Git Diff 空白与上下文选项

## Goal

为文本 Diff 增加可持久化的空白比较和上下文行数选项，并保证本地、WSL、SSH 返回一致结果。

## Changelog Target

`[TEMP]`

## Requirements

- 空白模式固定为 `exact`、`ignore-eol`、`ignore-all`；默认 `exact`。
- 上下文行数固定为 3、10、20；默认 3。
- `GitTransport.getFileDiff` 接收 `GitDiffOptions`，旧调用省略选项时保持当前行为。
- Desktop Local/WSL 和 SSH Agent 必须使用同一枚举与验证边界。
- 非 exact 模式返回 `canRevertHunks=false`，禁用 Hunk/行级回滚；整文件回滚保持可用。
- 设置写入 settingsStore 并进入 preferences 同步域；非法旧值迁移到默认值。
- SSH 旧 Agent 的默认 Diff 保持可用；非默认选项必须通过新 capability 显式协商。

## Acceptance Criteria

- [ ] 三种空白模式对同一 fixture 的本地、WSL/CLI 和 SSH 结果语义一致。
- [ ] 3/10/20 行上下文生成预期 Hunk，超出枚举的输入被边界拒绝。
- [ ] 非 exact 模式不显示部分回滚入口，无法绕过前端直接执行部分回滚。
- [ ] 旧 Agent 继续支持 exact+3；选择其他选项时显示升级提示而非发送非法请求。
- [ ] 非 UTF-8、二进制、未跟踪和冲突场景保持原有安全降级。
- [ ] 中英文文案、设置恢复和偏好同步通过验证。

## Out of Scope

- 不实现语言感知的“忽略 imports/formatting”。
- 不实现任意上下文数字、完整文件模式或单 Hunk 独立扩展。
