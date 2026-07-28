# Implementation Plan

1. 新增纯函数目标/Hunk 导航模型和 Node 定向测试。
2. 新增 `GitDiffReviewDialog` 与工具栏，移除 GitChangesPanel 内部 selectedFile/modal 细节。
3. 接入 F7/Shift+F7、按钮状态和 Hunk anchor。
4. 接入 Split/Unified 设置迁移和偏好同步。
5. 复用现有打开源文件流程并传递目标行号。
6. 验证 Git 筛选、未跟踪、删除、嵌套仓库和中英文窄窗口。
