# 技术设计

## 边界与数据流

`Sidebar` 自动/手动/分屏入口 → `worktreeStore.createWorktreeForProject` → Tauri `git_worktree_create` → Git `worktree add` → SQLite Worktree 记录 → 打开终端。

## 方案

1. 在 `worktreeStore` 的创建入口维护按项目路径和任务名区分的进行中集合。进入 Rust invoke 前登记，成功或失败都在 `finally` 中释放。重复请求直接返回稳定的进行中错误，不调用 Git。
2. Sidebar 的两个组合创建函数统一 `try/catch`，将进行中错误静默忽略，将其他错误通过新增 i18n key 显示给用户；自动策略的 Promise 链也必须经过该边界。
3. Rust 增加只用于 Git 创建失败的错误片段提取：保留输出尾部并清理 checkout 进度中的回车噪声，确保最终 fatal/error 可见。既有 merge/remove 错误分类逻辑不改变。
4. 为 Rust 错误片段 helper 添加单元测试；前端使用现有 TypeScript 检查验证类型和调用路径。

## 兼容性与风险

- Tauri command 参数、成功 payload 和数据库结构保持不变。
- 进行中集合只覆盖当前 WebView 进程；Git 本身仍负责跨进程路径/分支冲突校验，后端原有 `worktree_path_exists` 合约保留。
- 只读错误文本改进不会改变 Git 操作结果；外部 Git 失败仍会失败，但原因可见。

## 回滚

若出现误拦截，只需移除 store 进行中集合和 Sidebar catch；Rust 错误片段 helper 可独立回退，不涉及数据迁移。
