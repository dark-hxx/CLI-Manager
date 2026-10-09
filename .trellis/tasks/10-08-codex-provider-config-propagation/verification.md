# 1.4.1 配置传递验证

## 已通过

- `cargo test --manifest-path src-tauri/Cargo.toml --lib provider:: --quiet`：184/184。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib project_policy::tests --quiet`：15/15。
- `node --test scripts/resumeCliArgs.test.mjs scripts/nativeProviderConfigView.test.mjs scripts/nativeProviderEditing.test.mjs scripts/nativeProviderGlobalView.test.mjs`：34/34。
- `npx tsc --noEmit`，`npm run check:architecture -- --strict`：1191 文件，0 超限/违规；`git diff --check` 通过。
- 第一轮供应商测试 183/184，失败为新测试使用 TOML 索引给不存在键赋值而 panic；改用 table.insert 后重跑 184/184。不是忽略失败或删除用例。

## 覆盖与发现清单

- 仓储合并/预览：显式模型、公共配置启用/禁用、未知字段与实际 materializer 一致；普通/内联表递归合并。
- global materializer/runtime：推理强度、service_tier、instructions 路径、上下文、features、模型目录 URL、重试/超时、未知数组；现有 Home 的 MCP、信任、权限和未覆盖选项保留。
- 凭据：新增来源根/嵌套/表数组/内联结构按既有识别规则清理；不清理 Home 中原本保存的其他模块凭据。API 密钥仍由 auth/子进程环境注入，不将配置文件当作密钥迁移通道。
- scope：新快照固定完整 profile 内容，身份/损坏验证；旧快照缺少新字段仍按原 overrides 读取。
- project_policy：完整配置叠加 MCP/Skills、同键覆盖、数组替换、保留其他字段与所有权标记、无供应商配置、非法 TOML 拒绝；旧测试抽至同职责测试文件，避免超过 2000 行。
- terminalLaunch：执行真实编排函数（I/O mock）验证组合 profile 接入、组合缺失时本机完整 profile + 扩展参数、旧快照回退、已有自定义 profile 路由保持、WSL 不引用 Windows profile。
- Codex proxy 已有完整 profile 展开路径，无需修改；PTY/通知/渲染/模型网络发现确认不属于此次改动。

## 限制和安装验收

- 未启动桌面/Web 服务，未改真实配置及已有终端；未执行模型推理请求。无用户可见文案变更，不涉及新增翻译。
- 传递不等于 CLI 支持：无效/当前 Codex 未支持选项仍可能警告；模型列表超时不在修复范围。
- WSL、手工 `--profile personal` 及旧快照保持兼容分支，未宣称已修完整任意 TOML 的跨 shell 传递。真实 WSL 环境未运行。
- 普通新配置字段未声明时继承 Home 值；本轮不新增全局字段撤销/所有权历史迁移机制。
- 安装新包后：项目/Worktree 供应商重新创建终端即可生成新 profile；跟随全局供应商需应用一次供应商配置，再新建终端。核对 `max`/`Fast`、公共配置和 MCP/Skills 组合；旧进程不会自动重载。

## 发布

- 修复代码提交后，复用 local 缓存运行 `npm run tauri:build:local -- --bundles nsis --ci`。
- 修复提交 `7e3d5dce`；上述构建命令退出码 0，桌面/Web 生产构建与 Rust release 编译通过，生成 1 个 NSIS 包，没有构建 MSI。未推送远程，未修改生产优化/签名配置。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.1_x64-setup.exe`，29,963,606 字节；时间 `2026-10-08 19:50:38 +08:00`。
- SHA256：`B007B33E9F1DE45443539068D5F4A421693BA46BA32650D52958BE10C9ACCAC2`。
- 主程序及 Codex proxy、PTY daemon、Web daemon 均为本次编译产物；旧 NSIS 包保留为同目录 `CLI-Manager_1.4.1_x64-setup.before-config-fix.exe`，需要时可回滚程序版本（不撤销用户新应用的配置）。
- 构建警告仅为现有大前端 chunk、macOS bundle identifier 建议及 Windows linker 信息，无失败；未启动安装程序或用户应用。

## 合并最新主干与推送前复核（2026-10-09）

- 用户授权按既有流程推送；合并 `origin/master` 的 `917437d1`，保留主干 1.4.2 版本，不重新打包、不修改已有 1.4.1 安装包。
- 唯一文本冲突位于 `scripts/resumeCliArgs.test.mjs` 的尾部追加测试。保留 Codex 配置与 DeepSeek 恢复两组用例；测试夹具接入主干新增的真实 DeepSeek 命令识别函数，业务实现不额外改写。
- 配置/恢复前端测试 35/35、DeepSeek TUI/启动回归 37/37；`npx tsc --noEmit`、strict 架构检查（1289 文件、0 超限/违规）通过。
- 合并后 Rust `provider::` 测试 185/185、`project_policy::tests` 测试 15/15 通过；仅有 Windows linker 信息警告。`git diff --cached --check` 通过，无残留冲突。
- GitNexus MCP 未暴露，提交前影响复核降级为相对 `origin/master` 的 staged diff、冲突标记检查与定向测试；变更范围仍为原供应商配置传递修复及其文档/测试。模型目录超时仍仅完成诊断，不属于本次修复。
