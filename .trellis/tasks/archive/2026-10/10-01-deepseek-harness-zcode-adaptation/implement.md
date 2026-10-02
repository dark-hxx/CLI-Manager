# Implementation

- [x] 只读分支检查，官方源码调查与用户授权。
- [x] 保存PRD/design与影响范围，直接实施授权已给出。
- [ ] 增加DSH命令/身份纯模块、图标注册、项目源码设置组件、Rust source preflight。
- [ ] 接入启动、URL旁路观察、WebUI按钮及服务恢复策略。
- [ ] 双语文案及TEMP记录、契约文档。
- [ ] 定向Node/Rust测试；typecheck、build、strict architecture。
- [ ] 本地源码WebUI运行smoke（隔离DSH_HOME，避免使用用户数据/密钥）。
- [ ] 复核diff、fork、commit/push、draft PR并附加。

## Commands

node --test scripts/deepseekHarness.test.mjs scripts/agentTerminal.test.mjs scripts/resumeCliArgs.test.mjs
npx tsc --noEmit
npm run check:architecture
npm run check:architecture -- --strict
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib deepseek
git diff --check

实际执行证据写 verification.md。GitNexus不可用，提交前用引用检索及diff检查替代detect_changes，不宣称图谱检查通过。
