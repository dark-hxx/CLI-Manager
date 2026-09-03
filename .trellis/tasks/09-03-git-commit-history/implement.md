# Implementation Plan

## Delivery Checklist

- [x] 定义前端/Rust 历史数据结构和稳定错误契约。
- [x] 实现 native libgit2 提交分页、搜索、详情和只读文件 Diff。
- [x] 实现 WSL 固定 argv/超时链路及结构化输出解析。
- [x] 扩展 `GitTransport`、SSH bridge、SSH Agent dispatch 和 `gitHistory` 能力协商。
- [x] 实现 `GitHistoryView`，接入 Git 面板分段切换、搜索、分页、详情和只读 Diff。
- [x] 增加 zh-CN/en-US 文案、加载态、空态、错误态和旧 Agent 升级提示。
- [x] 更新 Git 契约、`CHANGELOG.md` 的 `TEMP` 版本及 `docs/功能清单.md`。
- [x] 增加 native/WSL/SSH/前端关键逻辑测试。

## Review Gates

- 修改既有符号前，用 codebase-memory 调用链、契约、`rg` 和源码复核影响范围。
- SSH wire shape 必须保持旧 Agent 不接收未知请求。
- 历史 Viewer 必须保持只读，Controller 层也不得暴露 mutation。
- 所有异步结果必须校验 transport/repository/search generation。
- 提交前运行 `detect_changes` 并以 `git diff` 复核实际范围。

## Validation

```powershell
npx tsc --noEmit
node --test scripts/gitHistory.test.mjs scripts/gitStoreRemote.test.mjs scripts/gitDiffViewerArchitecture.test.mjs
cargo fmt --all -- --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml git_history
cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml git_history
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/ssh-agent/Cargo.toml
git diff --check
```

## Rollback Points

1. 后端和 Transport 完成后先验证协议与 fixtures，不接 UI。
2. UI 接入后验证本地，再验证 WSL/SSH 能力协商。
3. 若 SSH Agent 发布链路未通过，保留本地/WSL 实现但不暴露 SSH 历史入口。
