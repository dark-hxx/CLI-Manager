# 子代理对话视图与执行详情分层

## Goal

子代理默认对话展示，任务与回复明确分层，工具和注入上下文折叠；保留只读行为、增量解析及 Web 兼容。版本 1.4.4，先提交再 NSIS，不合并主干、不推送。

## Requirements

- 子代理默认使用与历史会话相近的左右对话气泡，区分可证明来源的主 Agent 指令、子 Agent 回复和最终答复。
- 系统说明、继承上下文、思考及工具记录默认折叠；长任务可展开原文。提供对话/执行记录切换，仍为只读，不启动模型、不编辑日志。
- 桌面为主，复用共享展示并兼容经典 Web 的受限快照；不改变普通终端、分屏/关闭行为及 /tap 原生终端。
- 仅展示子转录实际记录的往来；未知身份不冒充主/子 Agent，不跨会话猜测或合成消息。
- 保留隐藏窗口暂停解析、增量解析、滚动跟随、截断提示及容量限制；中英文完整。

## Acceptance Criteria

- [x] 注入上下文、混合文本/工具、Codex phase/channel、继承历史和无身份旧日志均正确分类。
- [x] 后续指令/回复实时追加，工具默认收起，展开/切换不改原始日志，长消息无横向撑破。
- [x] 多子代理/父会话切换、隐藏/重显、截断/reset、中英文与窄屏回归通过。
- [x] 类型/架构、桌面及 Web/Tap 构建通过；隔离浏览器验证真实组件，不启动用户应用。
- [x] 提交后构建并校验 1.4.4 NSIS，不安装、不合并 master、不推送。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
