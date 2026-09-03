# Implementation plan

## Implementation

- [x] 建立 Codex 内部 ToolStart/ToolStop Hook 定义并纳入托管状态。
- [x] 为审批仲裁加入同作用域工具进度 tombstone，覆盖事件乱序。
- [x] 完善 transcript 候选与基线处理，保持 WSL/SSH 安全边界。
- [x] 确认被抑制事件无法进入任何通知 fan-out。
- [x] 更新契约、CHANGELOG 和功能清单。

## Validation

- [x] `cargo fmt --all`
- [x] `cargo test claude_hook --lib`（31 passed）
- [x] `cargo test hook_settings --lib`（37 passed）
- [x] `cargo check --lib`
- [x] `npx tsc --noEmit`
- [x] `git diff --check`
- [x] 缓存构建 NSIS，跳过 MSI 与更新签名：`CLI-Manager_1.3.8_x64-setup.exe`，21,064,782 bytes，SHA-256 `20141D7ED203221ED765C1750564A0B621D320C593BF363768AAD74E06DAF795`。
