# 远程 Git 全功能面板实施计划

## 1. 前置状态

- 当前任务保持 `planning`，本文件不授权实现。
- 用户已确认：功能范围以本地 Git 面板为准；Agent 未发布，不维护旧只读兼容。
- 实现前必须再次加载 `trellis-before-dev`。
- 修改业务符号前必须运行 GitNexus impact。当前 GitNexus 因缺少 `tree-sitter-kotlin` 无法建索引；工具未恢复时按 `design.md` Discovery List + 契约 + `rg` 执行，并在交付中记录限制。
- 整体变更风险为 HIGH；必须按阶段验证，不能一次性同时改 UI、Store、bridge 和 Agent 后再排错。

## 2. 预计修改文件

### 前端

- `src/lib/types.ts`：导出统一 Diff payload、选择行和仓库引用类型。
- `src/lib/sshRemoteGit.ts`：完整 SSH Git Transport、请求分类、只读 retry/写禁止 retry。
- `src/lib/gitTransport.ts`（新增）：Local/WSL 与 SSH 的窄 Transport 契约和创建函数。
- `src/stores/gitStore.ts`：上下文 key、repositoryId、全部动作经 Transport、写后刷新。
- `src/components/git/GitChangesPanel.tsx`：删除 SSH 只读 JSX，增加 SSH 刷新策略和 capability 错误态。
- `src/components/git/DiffViewerModal.tsx`：Diff/Hunk/行回滚改为注入动作。
- `src/lib/i18n.ts`：zh-CN/en-US 错误与状态文案。

### Tauri/daemon

- `src-tauri/src/commands/ssh_git.rs`：扩展 kind allowlist、严格 payload 转发与错误归一化。
- `src-tauri/src/daemon/ssh_agent_bridge.rs`：Git lane、`gitFull` 检查、超时和 consumer 清理。
- `src-tauri/src/daemon/client.rs`：Git 网络操作所需的有界 daemon 请求时限。
- `src-tauri/src/lib.rs`：仅在现有注册缺失时调整；原则上继续复用当前一个 Tauri command。

### SSH Agent

- `src-tauri/ssh-agent/src/lib.rs`：协议 minor `1.7`。
- `src-tauri/ssh-agent/src/protocol.rs`：`gitFull` capability、全部 Git kind 分派和测试。
- `src-tauri/ssh-agent/src/git.rs`：完整读写 runner、校验、操作实现和临时仓库测试。
- `src-tauri/ssh-agent/Cargo.toml`：仅增加项目已有版本的 `encoding_rs`、`chardetng`，用于非 UTF-8 Diff 对等。

### 契约与任务文档

- `.trellis/spec/backend/ssh-agent-contracts.md`：协议 1.7、Git lane、全功能 RPC、安全与重试契约。
- `.trellis/spec/backend/git-status-contracts.md`：远程状态/Diff 与本地展示契约。
- `.trellis/spec/backend/ssh-remote-terminal-contracts.md`：更新“远程 Git 未支持”的旧边界描述。
- 必要时更新 `CHANGELOG.md` 的当前版本功能清单；是否纳入由最终交付检查决定。

确认不修改：`src-tauri/src/commands/git.rs` 的 Local/WSL 路由、`GitChangesTree.tsx`、`FileEditorPane.tsx`、远程 Worktree 生命周期。

## 3. 分阶段实施

### Stage 1：契约类型与 Agent 纯 Git 能力

1. 固化请求/响应字段、错误码、路径/分支/patch 限额。
2. 在 Agent 拆分 read/write runner，写 runner 保留 Git 锁、禁止交互和自动重试。
3. 补全仓库/状态/Diff/分支读取，先让结果与本地 DTO 对齐。
4. 实现 Stage/Unstage、回滚、删除、Commit、网络、分支和冲突动作。
5. 每个破坏性操作先完成状态与边界校验，再执行。
6. 使用临时 Git 仓库完成 Agent 单测。

阶段门：

```powershell
Push-Location src-tauri/ssh-agent
cargo test
cargo check
Pop-Location
```

未达到功能/安全测试前，不进入协议接线。

### Stage 2：协议、capability 与 Git lane

1. 升级 Agent protocol minor 到 1.7，advertise `gitFull`；同步把 Agent 独立产品版本从已发布的 `0.1.0` 升级到 `0.1.1`，禁止覆盖旧 tag/签名制品。
2. 扩展 Agent protocol kind 分派和 Tauri `ssh_git` allowlist。
3. daemon 新增专用 Git lane 和独立派生 client identity；所有 Git 请求串行，Git lane 不要求 `toolSource`。
4. hello 后按 capability 阻断 Git 请求，缺失时不影响其他 Agent 能力。
5. 对齐 Agent、bridge、daemon client 的读取/磁盘写/网络超时。
6. 增加 capability、lane、队列关闭、结果未知和 release 测试。

阶段门：

```powershell
Push-Location src-tauri
cargo test --lib
cargo check
Pop-Location
```

### Stage 3：前端 Transport 与 Store

1. 增加 `GitTransport`，Local/WSL 逐个映射到现有 Tauri command。
2. `buildSshRemoteGitContext` 直接使用 Host + Agent installation + Project，不依赖 Claude/Codex Hook/history source；将 SSH RPC 映射到同一接口，写请求不注册 Background Tasks retry。
3. Store 从 `projectPath` 判定升级为 `contextKey + repositoryId`。
4. 所有读写 action 移除直接 `invoke` 和 `assertGitWritable()`，统一经当前 Transport。
5. 集中实现写后刷新矩阵和结果未知刷新。
6. 验证 Local/WSL 请求参数与改造前完全一致。

阶段门：

```powershell
npx tsc --noEmit
```

增加针对环境路由、过期响应和 retry policy 的最小 Node 测试；不引入新的前端测试框架。

### Stage 4：共享面板与 Diff

1. `DiffViewerModal` 改为加载/回滚动作注入。
2. `GitChangesPanel` 删除 `readOnly` 和 SSH 专用 JSX/文本 Diff。
3. SSH 使用完整树、提交栏、分支菜单、Pull/Push、冲突和确认弹窗。
4. 保留 Local/WSL watcher；SSH 增加聚焦/可见刷新和 15 秒前台轮询。
5. 增加 capability/Agent/Git/认证/结果未知错误态。
6. 同步 zh-CN/en-US。

阶段门：

```powershell
npx tsc --noEmit
git diff --check
```

静态检索必须证明：

- `GitChangesPanel` 不再包含 SSH 专用 Git 渲染。
- `DiffViewerModal` 不再直接选择本地/远程命令。
- SSH 路径不会进入 `git_*` 本地 invoke。

### Stage 5：契约更新与整体质量门

1. 更新三份 backend contract，写清协议 1.7 和远程写安全边界。
2. 执行 `trellis-check`。
3. 运行 GitNexus `detect_changes`；工具仍坏则用 `git diff --stat`、`git diff --check`、精确 `rg` 和逐文件 review 替代，并记录原因。
4. 完成 PRD Acceptance Criteria 对照。
5. 仅在全部检查通过并由用户确认后进入 Trellis finish/commit 流程。

## 4. 自动验证命令

```powershell
npx tsc --noEmit

Push-Location src-tauri
cargo check
cargo test --lib
Pop-Location

Push-Location src-tauri/ssh-agent
cargo check
cargo test
Pop-Location

git diff --check
```

不主动运行 `npm run dev/build`、`npm run tauri dev/build` 或启动桌面应用。

## 5. 人工验收清单

1. Local、WSL、SSH 分别完成仓库切换、状态、Diff、Stage/Unstage、Commit、Fetch/Push/Pull、分支和冲突流程。
2. SSH 验证文件/Hunk/行回滚、未跟踪删除的二次确认和刷新结果。
3. 断网或在写响应期间终止连接：界面不得自动重试，刷新后展示真实状态。
4. HTTPS 凭据未配置和 SSH key 不可用：快速失败，不出现密码输入或日志泄露。
5. 多窗口、分屏、项目快速切换、嵌套仓库切换：无跨项目/跨仓库状态覆盖。
6. Agent 缺失或没有 `gitFull`：只阻断远程 Git，提示重新安装/更新 Agent，不调用本地 Git。
7. 远程 Git 锁被外部终端占用：明确失败，锁释放后手动刷新/重试。
8. zh-CN/en-US 文案完整，英文时间仍为 24 小时制。

## 6. 风险与回滚点

- HIGH：Store 路由改造可能影响 Local/WSL。先建立 Local transport 对等映射并单独验证，再接 SSH。
- HIGH：Discard/Delete/Hunk/Lines 是不可逆写操作。Agent 状态复核和路径测试未通过时不开放 UI。
- HIGH：Commit/Checkout/Pull 响应丢失无法判断是否执行。禁止 retry，强制刷新。
- MEDIUM：Git lane 影响 Agent bridge 生命周期。通过独立 lane 避免改动 Hook Primary 与 History/File Readonly 行为。
- MEDIUM：非 UTF-8 Diff 需要新增 Agent 依赖。只复用主程序已有成熟依赖版本，不引入 Git/SSH 重型库。

每个 Stage 应形成可独立 review 的 diff。任何阶段出现 Local/WSL 回归，优先回滚该阶段，不通过兼容分支掩盖。

## 7. 启动前最终检查

- [x] 用户已审阅 `prd.md`、`design.md`、`implement.md`。
- [x] 用户明确授权开始实现。
- [x] 运行 `python ./.trellis/scripts/task.py start 07-23-ssh-remote-git-full-panel`。
- [x] 加载 `trellis-before-dev` 和相关 spec。
- [x] 对修改符号完成 GitNexus impact；索引已恢复并完成最终 `detect-changes`。

## 8. 实施与验证结果

- 完成单面板、双 Transport、协议 1.7 / `gitFull`、独立 Git lane、Agent 全量 Git RPC、安全校验、双语错误提示和文档同步。
- 根因修复：SSH context pending/missing 时不得回退 LocalGitTransport；Store 用独立 `remoteRequired` fail-closed，并在 context 切换时清理旧状态。
- 复盘发现：SSH 根仓库的合法 `repoPath` 为 `""`，`deleteUntrackedPaths` 曾用 truthy 判空导致静默跳过。已改为只拒绝 `null`，并增加 `scripts/gitStoreRemote.test.mjs` 回归测试。
- 根因分类：E（隐式假设）+ B（跨层契约）。本地仓库 ID 始终为非空绝对路径的假设泄漏到远程相对仓库 ID；TypeScript 的 `string` 类型无法区分合法空字符串与缺失值。
- 系统性排查：`gitStore.ts` 其余 Git action 均使用 `repoPath === null`；根仓库、嵌套仓库、本地、WSL、SSH 五类路径已静态复核。
- 验证通过：`npx tsc --noEmit`、两套 `cargo check`、SSH Agent 64 项测试、daemon bridge 21 项测试、SSH Git root binding 测试、Node 根仓库回归测试、定向 rustfmt、`git diff --check`。
- 主工程全量测试：702 passed / 1 failed / 1 ignored。唯一失败为未修改的 `commands::hook_settings::tests::install_then_uninstall_pi_extension`，与本任务 Git/SSH 变更无关。
- GitNexus 最终结果：20 files / 139 symbols / 5 flows，MEDIUM risk；索引状态 up-to-date。
- 人工验收追加根因：已发布 Agent `0.1.0` 仍是协议 `1.6`，不含 `gitFull`；新能力使用不可变的新版本 `0.1.1`，不提高全局 Agent 最低协议，避免误伤旧 Agent 仍可提供的文件/历史能力。
- 人工验收追加根因：文件上下文身份沿用了本地项目的 `id + path` 假设，而 SSH `path` 恒为空；同时面板同步 effect 未订阅 Host/`remote_path`，异步完成守卫只检查项目 id，导致设置变化后旧树/旧结果被复用。修复后 SSH 使用 `id + host + case-sensitive remote_path`，本地/WSL 规则不变，旧请求成功或失败均不能覆盖新上下文。
- 根因分类：B（跨层契约）+ C（变更传播遗漏）+ D（测试覆盖缺口）+ E（隐式本地路径假设）。前一次只修复“刷新携带 remote context”的症状路径，未覆盖“同一项目设置变化”的状态维度；已将身份/竞态契约和静态回归补入 spec/test。
- 最新 GitNexus `detect-changes` 覆盖当前整套未提交任务：25 files / 165 symbols / 18 flows，CRITICAL risk；风险集中于既有 Git Store、共享面板、daemon bridge 与 Agent runner 全链路。本轮不再扩展范围，也未提交。
- 人工验收追加根因：Agent `git status -unormal` 把普通未跟踪目录折叠为 `?? test/`，共享前端按 `/` 拆分后产生空名称文件节点，Diff 路径校验因此返回 `remote_git_path_invalid`。Agent `0.1.3` 改用 `--untracked-files=all`，并过滤由仓库列表管理的嵌套 Git 仓库；未跟踪文件及目录右键删除继续走既有二次确认和 Agent 状态复核。
- `0.1.3` 本轮 GitNexus：未提交变更为 9 files / 6 symbols / 0 flows / LOW；相对 `master` 的整条功能分支为 37 files / 332 symbols / 17 flows / CRITICAL，后者来自既有远程 Git 全链路，不是本轮状态参数修复新增的风险。
