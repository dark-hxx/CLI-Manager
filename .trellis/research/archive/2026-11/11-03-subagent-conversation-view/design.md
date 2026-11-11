# 设计与范围

## 根因与证据
- 当前 parseTranscriptLines 只保留 id/role/text，混合文本、thinking、工具参数/结果被拼成同一条 Markdown；桌面全部展开，未保留消息来源、phase 或时间。
- 真实 Codex 子转录的只读结构抽查确认 session_meta.source.subagent.thread_spawn、task_started.turn_attribution、internal_chat_message_metadata_passthrough.turn_id/content_item_kinds 和 phase=final_answer 可提供分类证据。只检查结构，不将用户会话内容复制到仓库或测试。
- 用户截图的历史气泡已有样式；只复用视觉与基础 Markdown，不加载历史 Workspace/SQL/编辑操作。

## 实现
- 共享解析器保留兼容 role/text/id，追加分类、归属、phase、时间；工具与文本拆为独立项。增量调用携带有限解析状态，reset 重建；未知来源保持中性，不将所有 user/assistant 改名为主/子 Agent。
- 有子线程及当前 turn 元数据匹配才能标记主/子；明确继承时间/turn 的历史归上下文。注入内容按块识别，真实任务含代码或关键词不被吞掉。旧日志缺少证据时标注来源未确认，保留可读内容。
- 新共享纯 React 对话组件通过 labels 和 renderMarkdown 注入依赖，桌面与经典 Web 共用；连续工具/上下文合组，折叠内容仅展开时渲染，长文本逐条展开。保留同一滚动容器和跟随规则。
- Web 快照继续使用旧客户端可读的 type/message JSONL，增加可忽略的展示元数据；字节预算和路径不外传保持。截断后显式提示，不承诺完整历史。
- 不追加父转录订阅，不扩大后端扫描，不修改 PTY/Hook/执行。子日志未记录的父回复不伪造，后续如需完整跨线程通信应另行评估。

## 触点与影响
- 修改：shared/subagentTranscriptMessages、shared/webSubagentSnapshot、桌面 SubagentTranscriptView、经典 Web SubagentPanel、共享展示/CSS、中英文文案、定向测试。
- 核对不改：子转录 Rust tail、Hook/agentId/父子会话绑定、普通 PTY、PaneLeafView/关闭行为、历史编辑/恢复及 /tap。
- GitNexus 未暴露，使用 moderate memory（45277 节点/118623 边）、真实源码与契约降级；共享解析器调用图标 CRITICAL/HIGH，已向用户说明。图遗漏 JSX 引用，以真实 import/调用和行为验证补足。

## 场景矩阵
- 本地/WSL/SSH：只消费同一已授权子转录，不更改路径/源发现；无独立转录仍显示等待/生命周期状态。
- 单/多子代理、嵌套父子：按现有 sessionId 分离缓存，未知发件方不算主 Agent。
- 焦点/分屏/最小化：保持 isVisible 门控；更新不抢滚动，换子代理清除组件局部展开状态。
- 冷读/追加/reset/尾部裁剪：状态与 ID 有界；未知旧片段不补造身份，截断明确提示。
- Hook 未安装或无日志：不创建虚假对话，沿用原状态提示。
- 宽/窄屏、深/浅色、中文/英文：按钮、角色、状态、时间格式均检查；内容只读，无新增输入入口。
