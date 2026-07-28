# Implementation Plan

1. 扩展设置契约：新增 `GitDiffOpenMode`、`gitDiffOpenMode`、`gitDiffWrapLines`，补齐默认值、迁移、同步和设置测试。
2. 修正主题边界：完善终端 token，限定 application/terminal CSS 作用域，Review Dialog 显式启用终端主题。
3. 修正布局：移除内容外框，接入换行按钮、nowrap CSS、横向滚动和虚拟列表重新测量。
4. 修正打开流程：复用 pinned tab 编排，source 成功关闭，Pin 持久修改默认打开模式并提供恢复入口。
5. 同步中英文、Git Diff Viewer 契约、`CHANGELOG.md` 与 `docs/功能清单.md`。
6. 运行 `npx tsc --noEmit`、`npm run build`、全部 Git Diff 定向测试、`git diff --check` 和 GitNexus detect changes。

## Rollback Points

- 设置字段与打开路由必须一起回退，避免存储了无法消费的模式。
- CSS 主题作用域与 Viewer data attributes 必须一起回退，避免终端变量失效。
- nowrap CSS 与 Hunk overflow/remeasure 必须一起回退，避免内容被裁剪。
