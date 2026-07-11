# 优化全局拖拽响应

## Goal

消除项目内拖拽启动和视觉反馈的滞后感，使 Workspan/终端标签、项目树、设置卡片以及文件拖入终端都能紧跟鼠标，同时保持现有排序、分屏、文件移动和持久化语义不变。

## Requirements

- 保留现有 `@dnd-kit` 依赖，不新增或升级依赖。
- 统一 dnd-kit 拖拽启动距离和排序动画时长，覆盖终端 Tab、Workspan、工具栏、项目树、统计卡片和资源卡片。
- Workspan 分屏预览仅在目标 Pane 或方向变化时更新，并禁用隐藏 Pane 的 drop zone。
- 文件浏览器拖拽预览使用每帧一次的 DOM transform 更新，不在每次 pointermove 时重渲染整个文件浏览器。
- 隐藏终端不执行外部文件拖放的 Tauri 坐标换算和路径格式化。
- 不改变点击、双击重命名、右键、展开折叠、文件移动、终端路径插入和拖拽持久化行为。
- Changelog Target: `V1.2.7`。

## Acceptance Criteria

- [ ] 轻微移动鼠标即可启动拖拽，拖拽预览和排序项无明显拖尾。
- [ ] Workspan 拖入 Pane 四个方向时预览即时切换，中心区域仍不触发合并。
- [ ] 项目、分组、终端标签、Workspan、工具栏和设置卡片排序结果正确并继续持久化。
- [ ] 文件浏览器内拖拽和拖入终端都能正确命中目标，预览每帧最多更新一次。
- [ ] 系统文件管理器拖入可见终端仍按当前 Shell 规则插入路径。
- [ ] `npx tsc --noEmit` 与 `git diff --check` 通过。
- [ ] `CHANGELOG.md` 的 `V1.2.7` 和 `docs/功能清单.md` 已同步。

## Notes

- 已确认根因包括分散的 5/6/8px 启动阈值、dnd-kit 默认 200ms transform 动画、文件拖拽逐 pointermove setState，以及 Workspan 重复写入相同预览状态。
- GitNexus 影响分析为 LOW；索引刷新因 `.gitnexus/lbug` 被占用失败，实施以直接文件检查补充。
