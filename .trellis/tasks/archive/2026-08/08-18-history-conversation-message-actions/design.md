# 技术设计

## 边界

- 修改范围限定在 `src/components/history/SessionDetailPane.tsx`。
- 不修改历史解析、IPC、数据库、SSH 协议、样式表或翻译表。
- 交付记录沿用本会话指定的 `V1.3.7`，在实现完成时更新 `CHANGELOG.md` 与 `docs/功能清单.md`。

## 组件设计

### 复用操作栏

将 `HistoryMessageCard` 内已有的复制、编辑、插入、删除按钮抽为同文件私有的共享操作栏组件。它接收：

- 消息是否可编辑；
- 四个既有操作回调；
- 现有 `history.edit.*` 翻译键。

`HistoryMessageCard` 与 `ConversationRowCard` 都使用这个组件，继续复用已有 CSS 类名与 hover/focus 可访问性行为，避免两套按钮标记和提示文案漂移。

### 对话页接线

`ConversationRowCard` 在消息元信息所在的头部渲染共享操作栏。对话行保留 `message` 与 `messageIndex`，因此所有操作都使用原始消息，而非只使用筛选后的 `row.content`。

- 复制：调用现有 `copyMessageContent(message)`。
- 删除：调用现有 `onDeleteMessage(message)`。
- 编辑/插入：调用现有编辑闸门和状态初始化；只有闸门允许时，再将详情视图切换为 `transcript`。原文页利用已有 `editingIndex` / `insertIndex` 表单渲染对应原始消息。

为表达“闸门是否获准”，`startEditMessage` 与 `startInsertMessage` 将返回布尔结果；原文页现有调用可忽略该结果，对话页据此决定是否切换视图。

## 数据与兼容性

```text
ConversationRowCard(message, messageIndex)
  → 共享操作栏
  → 编辑/插入闸门
  → editingIndex / insertIndex
  → detailView = transcript
  → HistoryMessageCard 渲染已有表单
```

- 对话页的隐藏 part 仍不渲染，也不会新增操作入口。
- SSH/快照消息由既有 `canEditMessages && editable && line_index` 判断保持只读。
- 原始消息索引、虚拟列表 `data-index`、搜索命中与跳转映射不变。
- 批量选择模式继续由原文页承载：对话页在该模式下隐藏单条操作栏，避免与既有批量删除路径并存。

## 风险与回退

- 风险：异步编辑闸门被拒绝时不应切换视图；通过布尔返回值保证该顺序。
- 风险：对话视图只展示部分文本；复制和编辑必须仍作用于原始消息，不能写回 `row.content`。
- 回退：移除对话页共享操作栏及其回调即可，不涉及数据迁移或后端回滚。
