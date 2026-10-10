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

## 1.4.2 状态栏所有权修复验证（2026-10-09）

- `cargo test --manifest-path src-tauri/Cargo.toml --lib provider:: --quiet`：190/190；`project_policy::tests`：16/16；`codex_statusline::`：6/6。仅 Windows linker 信息警告，无测试失败。
- `node --test scripts/resumeCliArgs.test.mjs scripts/nativeProviderConfigView.test.mjs scripts/nativeProviderEditing.test.mjs scripts/nativeProviderGlobalView.test.mjs`：35/35；`npx tsc --noEmit`、`npm run check:architecture -- --strict`（1289 文件、0 超限/违规）、`git diff --check` 通过。
- 新增回归覆盖：供应商普通/内联/点路径表 × Home 已配置/空数组/缺失；只含状态栏的表不生成空覆盖；其他 TUI 和显式命名 profiles 保持；完整/legacy 快照清理；真实 runtime→密钥重绑定、runtime→项目扩展组合入口不重新带入旧值。上次完整配置/凭据隔离回归继续通过。
- 实施后重新索引，`remove_provider_statusline` 确认被全局 materializer 和快照读取两个真实入口调用；memory detect_changes 列出 12 个预期文件但 impacted_symbols 为空，不能据此断言无影响，最终以源码/Git diff/测试复核为准。GitNexus 未暴露。
- 未写用户真实配置、未重启已有终端、未启动桌面/Web 服务。没有新增 UI 文案；预览仍是示例数据，未将示例显示当作实际终端视觉验收。真实 WSL/SSH 及安装后 TUI 需要人工验证。
- 安装验收：保留设置页中的所选状态栏，关闭并重新创建一个 Codex 终端进程（仅重新连接存活 daemon 不算），确认使用当前 Home 顺序；另测切换供应商/项目扩展和空状态栏。若 Home 曾被旧版全局应用覆盖，先在状态栏页重新保存目标配置。无数据的 Git/PR/任务状态仍由 Codex 决定是否显示。
- 本轮只修改配置所有权，不包含模型目录超时修复，不改变供应商数据库原始文档；没有迁移或自动回写真实 Home。回滚程序后旧版可能再次把供应商状态栏写入 profile，需重新保存状态栏并新建终端。

### 1.4.2 NSIS 交付

- 修复提交 `9115a5e5` 后执行 `npm run tauri:build:local -- --bundles nsis --ci`，退出码 0，仅生成一个 NSIS 包，无 MSI。桌面/Web 前端及 Rust release、主程序/PTY daemon/Web daemon/Codex proxy 构建均成功。
- 安装包：`F:\gitRepository\CLI-Manager\src-tauri\target\local\release\bundle\nsis\CLI-Manager_1.4.2_x64-setup.exe`；30,178,504 字节；`2026-10-09 09:21:15 +08:00`。主程序 ProductVersion/FileVersion 均为 `1.4.2`。
- SHA256：`FE5B4A5D061681A2E7F9ED7090E60167C0090A9482812EF51A420C1370333E17`。
- 复用 local 构建缓存；仅现有 Vite 大 chunk、bundle identifier 建议与 Windows linker 提示，无构建失败。未自动安装、未重启用户进程、未推送远程，未将该包描述为已完成人工 TUI 验收。

## 1.4.2 Home 状态归属与 Hook 查询追加验证（2026-10-10）

- Rust `provider::` 194/194、`hook_settings::` 39/39、`project_policy::tests` 17/17、`codex_app_server_proxy::tests` 29/29、`codex_statusline::` 6/6；合计 285 项。仅现有 Windows linker 信息警告。
- 前端真实函数测试（resumeCliArgs、nativeProviderConfigView、nativeProviderEditing、nativeProviderGlobalView）36/36，含待审核 Codex 桥接环境、缺模块/特性关闭/应用桥接关闭与查询无写操作；`npx tsc --noEmit`、strict 架构检查（1290 源文件、0 超限/违规）、`git diff --check` 通过。
- 回归覆盖：3 种 TOML 表形态 × 3 种 Home 状态，保留 false/空数组/当前信任/当前 untrusted，剔除仅信任的外来路径但保留其他项目选项；清理幂等。供应商 + 公共配置合并后经真实 runtime 生成、runtime → 项目 MCP/Skills、完整/legacy snapshot、旧代理受管与用户 profile 区别均验证。
- Hook 查询重复检查缺失/已确认/禁用/过期状态时 config.toml 和 hooks.json 字节不变；损坏重复键查询不回写，明确安装才去重且保留禁用决定；旧 CC Switch 同步无确认时不造哈希，过期确认不复制，禁用状态保留。
- 第一轮 provider 测试发现带引号项目路径的 Key.to_string() 是 TOML 表示而不是实际键，导致空路径条目没被清理；改用 Key.get() 后 194/194。项目组合新增测试最初用了非法快照 ID，前端新增测试最初漏填其余布尔设置，均修正夹具后通过。未删失败用例或跳过检查。
- 实施后 moderate 重新索引；remove_provider_home_state 确认接入 materializer、snapshot reader、proxy parser 三个入口。GitNexus 未暴露，影响检查降级为 memory 调用图、detect_changes、Git diff/源码及定向测试，不把图谱空结果当作无影响。
- 未调用有副作用的用户安装/同步接口，未改用户 Home/供应商数据库，未启动应用/热部署或关闭已有终端。无 UI 文案变化，不涉及新增翻译；WSL/SSH 和用户真实 Codex TUI 尚未人工验收。
- 安装测试：关闭并新建 Codex 进程（重连存活 daemon 不算），同一供应商重复启动、切换供应商与项目扩展，检查已确认 Hook 不被旧文档反复回放。首次/实际变化的 Hook 仍可能要求审核；确认后再新建应保持。手动禁用后刷新安装状态仍禁用。跟随全局的配置如曾被旧版本覆盖，需用户重新确认/保存一次，程序不猜测并还原历史状态。
- 不重建/修改原始供应商文档，不做全局历史信任回滚，不绕过审核。回滚程序可能再次回放旧状态；需保留新的 Home 确认记录并注意旧版自动信任副作用。模型发现超时仍不在本轮范围。

### 本轮 NSIS

- 待修复提交后复用 local 缓存构建，仅 NSIS，不生成 MSI。
