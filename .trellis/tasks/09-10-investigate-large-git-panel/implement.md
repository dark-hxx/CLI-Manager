# 实施记录

## 状态
用户已批准方案，task.py start 已执行。主会话已完成实现与定向验证，最终构建及交付记录见 research/validation.md。

## 执行顺序
- [x] 分支只读检查、issue 正文/评论、契约及 V1.3.9 对照。
- [x] GitNexus context/impact、源码确认、64887 条规模实验及研究记录。
- [x] 用户审阅最终 PRD/design/implement 并同意实施。
- [x] 加载 trellis-before-dev、相关状态/hook/架构契约，task.py start；编辑每个既有函数前补齐对应 GitNexus impact。
- [x] 提取纯树模型与可见行/目录统计；添加规模和路径/分组/选择语义测试。
- [x] 改成单滚动容器虚拟树，拆开行渲染和完整后代操作，使用精确 selector 与缓存统计。
- [x] 大列表 Worker/分批 fallback，测试错误、终止、项目切换和过期结果。
- [x] 请求合并、快照相等复用、面板摘要聚合；用延迟模拟证明同仓库最大并发 1、事件合并、写后刷新、新身份及 A→B→A 隔离。
- [x] 更新 V1.4.0 CHANGELOG.md、docs/功能清单.md 的 Git 部分及相关性能契约。
- [x] trellis-check 和必要架构/跨层验证；记录真实浏览器结果和环境限制。

## 验证
- 新增行为测试：64887 根文件/宽目录/深路径/已跟踪和未跟踪混合，完整数据计数，头尾可达，折叠/模块分组稳定；目录批量操作仍处理不可见子孙。
- 浏览器：固定视口挂载行数应有稳定上界（建议断言少于 200 行），滚动/关闭面板/提交框输入保持响应；记录首开、滚动、选择、无变更刷新 Performance。相同数据刷新不重建树。
- 定向现有测试：node --test scripts/gitStoreRemote.test.mjs scripts/gitTransportLease.test.mjs scripts/gitDiffReviewNavigation.test.mjs scripts/gitWorkspace.test.mjs scripts/dragInteraction.test.mjs
- npx tsc --noEmit
- npm run check:architecture -- --strict（独立运行）
- npm run build（Worker 和打包接线有变更）
- 确有 Rust 修改时再 cargo check/定向 cargo test，不为纯前端改动启动全量 Rust 测试。
- 手动切换 zh-CN/en-US，检查树操作和提示；本地/WSL/SSH 实机不可用时以 Transport 测试覆盖并明确限制。

## 回滚与交付
仅回滚本任务业务改动；现有未提交代码和文档必须保留。已更新两份代码变更记录；沿用 V1.4.0 条目，未更改应用版本配置。不自动提交、推送或评论 issue。
