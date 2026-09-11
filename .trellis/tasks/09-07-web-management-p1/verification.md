# P1 验证记录

## 已通过

- `cargo fmt --manifest-path apps/server/Cargo.toml --all --check`
- `cargo check --manifest-path apps/server/Cargo.toml`
- `cargo test --manifest-path apps/server/Cargo.toml`（35 项）
- `cargo test --manifest-path crates/web-protocol/Cargo.toml`（5 项）
- `npm run web:typecheck`
- `npm run web:build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npx tsc --noEmit`
- `npm run build`
- `git diff --check`

## 已知限制

- `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` 仍被工作区已有的 `src-tauri/src/provider/database.rs` 格式差异阻止；该文件不在本次变更中，因此未自动改动。
- P1 Web 文件和 Git 操作继续由在线桌面端执行；SSH 项目文件操作仍未宣称为 Web capability。
