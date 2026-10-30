# 设计：性能验收、双轨发布与 Tauri 下线

> 上游：父 `prd.md`（性能目标表、场景矩阵、验收）、父 `design.md` §0.1/§7/§8/§12；`research/baseline.md`、`research/perf-opportunities.md`；desktop-integration（安装包、更新 manifest 键、单实例互通、共享 daemon 规则）。
> 原则：任何阶段都能回退到 Tauri 版且不丢数据；只有在双轨数据证明 GPUI 版不劣于 Tauri 版后才切默认。

## 1. 阶段划分

| 阶段 | 版本形态 | 进入条件 | 退出条件 |
|---|---|---|---|
| R0 内部预览 | GPUI 预览安装包只在 Release 草稿/附件中提供，不进 latest.json | M4 各子任务验收通过 | 性能报告 + 场景矩阵首轮全部记录 |
| R1 Opt-in 公测 | 正式 Release 同时附带 Tauri 安装包（默认）与 `CLI-Manager-GPUI-Preview_x.y.z_x64-setup.exe`；latest.json 增加 `windows-x86_64-gpui` 键；GPUI 预览版自更新只看该键 | R0 退出条件 + 至少 2 周内部使用无 P0 | 至少 1 个正式版本周期，GPUI 崩溃率与问题反馈 ≤ Tauri |
| R2 默认切换 | 主安装包换成 GPUI（产品名恢复 `CLI-Manager`，主程序 `cli-manager.exe`）；latest.json 的 `windows-x86_64` 指向 GPUI 安装包；Tauri 版保留为 `CLI-Manager-Legacy` 附件 1–2 个版本 | R1 退出条件 + 回退演练通过 | 1–2 个版本无回退需求 |
| R3 Tauri 下线 | 删除 Tauri 壳与 React 桌面代码（§5） | R2 稳定 | — |

- 每个阶段的决策记录写入本任务 `research/release-log.md`（日期、版本、数据、决策人）。
- 平台范围：现有 `release.yml` 发布 Windows x64、macOS aarch64、Linux deb（x64/arm64）。各阶段按平台推进：Windows 先行；macOS/Linux 的 GPUI 预览包在 R1 同步提供但允许晚一个版本进入 R2。某平台未进入 R2 前，latest.json 该平台原键继续指向 Tauri 产物；R3 必须等所有平台都完成 R2（或经确认停止该平台支持）。

## 2. 性能验收

### 2.1 方法
- 基准脚本：`node scripts/bench/run-baseline.mjs`（poc-gates 建立）新增 `--target gpui|tauri`，同一台机器、同一数据目录快照、同一版本号的两个壳各跑 5 次取中位数。
- 环境记录：CPU、GPU、显卡驱动、显示器分辨率与缩放、Windows 版本、电源计划、杀毒排除情况。
- 指标与工具：

| 指标 | 工具 |
|---|---|
| 冷启动到首帧 / 到可输入 | 启动时间戳日志（`startup_trace`）+ ETW（WPR `GeneralProfile`） |
| 进程数与内存（私有工作集，含所有子进程） | `scripts/bench/proc-snapshot.ps1`（Get-Process + Job 树） |
| 终端吞吐（`cat` 100 MB、`yes` 10 s）与输入延迟 | 吞吐计时 + `typometer` 类测量或高速摄像辅助 |
| 空闲 CPU/唤醒（P1） | Process Explorer 线程 Context Switch Delta、`powercfg /energy`、10 分钟两种状态（前台空闲 / 托盘） |
| 大仓库 Git 状态（P4） | core 日志计数 + 计时 |
| 转录追加延迟与线程数（P5） | 日志 + 线程计数 |
| DB 并发（P2） | 压测脚本（core-extraction 产出） |
| 输出路径分配（P3） | `dhat`/计数器（terminal-native 产出） |
| 包体与安装后体积（P7、P8） | 产物大小 |

### 2.2 报告
- `research/perf-report.md`：父 prd 性能目标表逐行“目标 / Tauri 基线 / GPUI 结果 / 结论”，P1–P8 每项引用子任务验收记录链接；不达标项写原因与处理（修复后复测或经确认降级目标）。

## 3. 场景矩阵回归

- 父 prd 场景矩阵逐维度（窗口焦点、分屏、WSL、Worktree、SSH 远程、hook 装/未装、多显示器 DPI、IME、后台会话、跨壳 attach、WebView2 缺失、低功耗/托盘、大数据量）生成检查表 `research/scenario-matrix.md`，每格记录：版本、执行人、结果、问题链接。
- 自动化部分：`cargo test --workspace`、各 `node --test` 脚本（保留中的）、core 集成测试；手工部分按清单执行。

## 4. 数据与会话往返

| 用例 | 步骤 | 期望 |
|---|---|---|
| 数据往返 | Tauri 版产生项目/分组/模板/历史收藏/设置（含未知字段）/Provider/SSH → 关闭 → GPUI 版打开并修改 → 关闭 → Tauri 版打开 | 两侧可见全部数据；未知字段保留；迁移 checksum 无冲突 |
| DB 版本前进 | GPUI 版新增 migration（若有）后回退 Tauri 版 | 迁移只增不改，Tauri 版忽略新表/列；若某版本 GPUI 引入 Tauri 版不认识的 migration，Tauri Legacy 必须同步携带该 migration（发布规则写入 spec） |
| 跨壳 attach | Tauri 版开启后台会话 → 退出 UI → 启动 GPUI 版 attach；反向 | 父 design §7：ANSI checkpoint 重放；不支持的格式降级为“仅新输出 + 提示” |
| 共享 daemon 版本 | 新 GPUI 带新 daemon，旧 Tauri daemon 正在运行且有会话 | desktop-integration §8.3：降级使用旧 daemon + 提示；无会话时替换 |
| 回退演练 | R2 后从 GPUI 回退安装 Tauri Legacy | 安装器停本目录进程；数据完整；资源管理器菜单指向 Legacy |

## 5. Tauri 下线清单（R3）

### 5.1 删除
| 路径 | 说明 |
|---|---|
| `src-tauri/src/commands/**`、`lib.rs` 中 Builder/插件/`invoke_handler!`、`adapters/**` | Tauri 适配层 |
| `src-tauri/tauri.conf.json`、`capabilities/**`、`gen/**`、`build.rs` 中 tauri-build、`icons` 中仅 Tauri 使用的部分 | 配置 |
| `src/**`（React 桌面前端）、`index.html`、`vite.config.ts`、根 `tsconfig*.json` 中桌面部分 | 前端 |
| 根 `package.json` 中桌面依赖与脚本（`tauri*`、`dev`、`build`、`preview`）；`scripts/` 中只服务于 React 桌面的 `*.test.mjs`（逐个判定：已迁移为 Rust 单测的删除，仍校验 core/安装器的保留） | 工具链 |
| `scripts/tauri-cli.mjs`、`tauri-build-local.mjs`(+test)、`tauriCliDevProxy.test.mjs`、`dev-server.mjs` | Tauri 专用 |

### 5.2 保留与搬迁
| 现路径 | 去向 |
|---|---|
| `src-tauri/helpers`（daemon / web-daemon / codex-proxy bin） | `apps/helpers`（bin 名与 VERSIONINFO 不变），`prepare-helper-binaries.mjs` 更新路径 |
| `src-tauri/{hook-schema,history-core,agent-capabilities-core}` | `crates/` 下同名 |
| `src-tauri/ssh-agent` | `apps/ssh-agent`（CI `--manifest-path` 同步修改） |
| `src-tauri/resources/{conpty,ssh-agent}` | `resources/`（打包脚本同步） |
| `src-tauri/installer/{hooks.nsh,cleanup.ps1}` | `installer/` |
| `apps/web*`、`apps/server`、`crates/web-protocol` | 不动（`apps/web` 仍是 web-daemon 的前端） |
| `.cargo/config.toml` 的 `target-dir = "src-tauri/target"` | 改为 `target`，同步更新所有脚本与 CI 中的产物路径 |
| 根 `package.json` | 仅保留 workspaces（web、web-tap）与其脚本、`check:architecture` |

- 搬迁采用 `git mv`，一类一个提交；每个提交后 `cargo check --workspace` + 打包脚本 dry-run。
- 架构治理：`scripts/architecture.mjs` 现以 `src-tauri/src/lib.rs`、`commands/mod.rs` 为 Rust 路由入口，`architecture/baseline.json` 含大量 `src/` 文件；下线时同步改为以 `crates/core` 与 `apps/desktop-gpui` 为入口并重新生成基线（`--baseline-json`），否则 `npm run check:architecture` 失效。
- CI：`release.yml` 删除 Tauri 构建步骤，GPUI 打包 + 签名 + latest.json 生成成为主流程；ssh-agent workflow 路径更新。
- 签名工具：现有更新产物与 ssh-agent manifest 均由 `npx tauri signer sign` 签名（minisign 格式，密钥 `TAURI_SIGNING_PRIVATE_KEY`）。下线 `@tauri-apps/cli` 前改用等价签名器（`rsign2`/`minisign` CLI 或 `scripts/sign-minisign.mjs`），**私钥与公钥不变**；以“新签名器签名 → 旧客户端 `tauri-plugin-updater` 校验通过”的测试作为前置。`r2-release-config.mjs` 输出的 `TAURI_CONFIG` 改为 GPUI 使用的 `CLI_MANAGER_UPDATER_ENDPOINTS`，`prepare-r2-release.mjs` 去掉“Tauri latest.json”措辞并覆盖 `-gpui` 键。
- 下线 PR 前：GitNexus `detect_changes({scope:"compare", base_ref:"master"})` 审查；重新 `analyze` 索引。

## 6. 文档更新

| 文档 | 内容 |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | 项目简介（GPUI + Rust）、常用命令、架构要点（crate 布局、界面单进程 + daemon/web-daemon、Hook 端口在 daemon、事件 → Entity、数据层 core-db/core-prefs）、约定（不再有 capability/asset scope；预览 WebView 规则）；删除过时的 `claude_hook.rs` 描述（R0 即可先修正） |
| `README*` | 安装方式、系统要求（WebView2 变为可选）、预览版说明 |
| `CHANGELOG.md` | 每阶段条目；R2 的 Breaking/行为变化（例如硬件加速开关移除、统计截图行为） |
| `docs/功能清单.md` | 逐项标注 GPUI 版状态；R3 后删除 Tauri 专属条目 |
| `docs/pty-daemon-manual.md` | 新 capabilities 与 GPUI 客户端 |
| `.trellis/spec/**` | 前端 spec（React 规则）在 R3 归档到 `spec/archive/frontend-react/`；GPUI spec 成为正式 frontend spec |

## 7. 发布说明要点（R1/R2）
- 界面单进程：不再有 WebView 渲染进程；预览（Markdown 文件 / HTML / Live Server / PDF）按需加载系统 WebView，缺失时有原生降级。
- 保留 `cli-manager-daemon`：终端会话在关闭窗口/升级 UI 后仍可保留与恢复，Hook 上报与本地路由在 daemon 中运行。
- 保留 `cli-manager-web-daemon`：Web/移动端访问的权限隔离。
- 跨壳 attach：从 Tauri 版切换后，已存在的后台会话可恢复，历史输出以重放方式呈现。
- 已知差异清单（来自 R1 反馈）。

## 8. 风险
| 风险 | 应对 |
|---|---|
| 双轨期两版本 migration 不同步 | 规则：R1–R2 期间 GPUI 新增 migration 必须同时进入 Tauri 版 `migrations()`（共享 core-db 定义已保证） |
| 共享 daemon 版本错配 | capabilities 协商 + 无会话才替换 |
| 用户同时装两版产生混乱 | 预览版独立产品名与图标角标；单实例互通 |
| 下线后发现遗漏功能 | R2 保留 Legacy 附件 1–2 版；功能清单逐项核对作为 R3 进入条件 |
