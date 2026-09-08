# Implementation Plan

1. 用 React Profiler/浏览器 performance 记录现有 64/256/768 KiB fixture 基线。
2. 抽取 limits、metadata normalization 和纯解析输入输出。
3. 新增 Worker 与 generation 取消规则，保留小文件同步路径。
4. 按 Hunk 接入 TanStack Virtual，延迟生成可见 Hunk tokens。
5. Desktop/Agent 增加 768 KiB 与 20000 行限制和定向测试。
6. 验证导航、选择、Split/Unified、窗口 resize 和超限错误。
7. 运行 TypeScript、Node、Desktop/Agent 检查和 `git diff --check`。
