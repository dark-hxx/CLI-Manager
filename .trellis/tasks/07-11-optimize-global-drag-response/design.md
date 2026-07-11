# 全局拖拽响应设计

## 决策

- 保留 dnd-kit，通过共享配置将启动距离统一为 3px、排序 transform 动画缩短为 100ms。
- 文件拖拽预览只在开始/结束时进入 React 状态；移动过程通过 requestAnimationFrame 更新 Portal DOM 的 translate3d 和命中态。
- Workspan 相同 Pane/方向的 drag-over 不重复 setState，隐藏布局的 drop zone 设为 disabled。
- 外部文件拖放先过滤不可见终端，再执行 Tauri 缩放比例查询。

## 风险控制

- 保留非零启动距离，避免单击和双击被误判为拖拽。
- 不改变 drag-end 数据处理、数据库持久化或文件移动逻辑。
- 不新增用户文案和公共接口。
