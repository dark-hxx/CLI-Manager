# 实现计划

1. 修改 `src-tauri/src/commands/git_worktree.rs`，加入创建失败错误尾部提取 helper，替换 create 分支的前缀截断，并补 Rust 单测。
2. 修改 `src/stores/worktreeStore.ts`，增加创建中的 key 集合、`try/finally` 释放和稳定错误码。
3. 修改 `src/components/sidebar/index.tsx`，统一自动/手动/分屏创建异常边界，避免未处理 Promise。
4. 修改 `src/lib/i18n.ts`，同步 zh-CN/en-US 创建失败文案。
5. 更新 `CHANGELOG.md` V1.3.1。
6. 运行 `npx tsc --noEmit`、`cargo test --manifest-path src-tauri/Cargo.toml`，并运行 GitNexus 变更检测。
