# 实施步骤：性能验收、双轨发布与 Tauri 下线

> 先读：本目录 `prd.md`、`design.md`；父 `prd.md`（性能目标表、场景矩阵）；`research/baseline.md`、`research/perf-opportunities.md`；desktop-integration 的 `design.md` §7–§8。
> 前置：只读 Git 同步检查；R3 每个删除/搬迁提交前 GitNexus `impact`（被删除公共符号）与提交前 `detect_changes`。

## R0 内部预览（约 2 周）
1. 按平台（Windows / macOS aarch64 / Linux deb x64、arm64）建立进度表，记录各平台进入各阶段的时间（design §1）。
2. 扩展基准脚本 `--target gpui|tauri`、`proc-snapshot.ps1`；跑两壳基准，生成 `research/perf-report.md` 初稿。
3. 生成 `research/scenario-matrix.md` 并执行首轮。
4. 执行 design §4 往返用例全集，记录。
5. 修正 `CLAUDE.md`/`AGENTS.md` 中过时的 Hook 描述（`claude_hook.rs` → daemon Hook 端口），与迁移无关可先行。
6. 出口评审：性能不达标项、P0/P1 问题清单与处理计划。

## R1 Opt-in 公测（≥ 1 个正式版本周期）
1. CI：Release 同时产出 Tauri 默认包与 GPUI 预览包；latest.json 合并脚本加入各平台 `-gpui` 键（`windows-x86_64-gpui`、`darwin-aarch64-gpui`、`linux-<arch>-deb-gpui`；单测：Tauri 原键不变，`prepare-r2-release.mjs` 改写覆盖新键）。
2. 发布说明（design §7）；README 增加预览版说明；CHANGELOG。
3. 反馈收集：Issue 模板增加“版本形态（Tauri/GPUI）”字段；崩溃报告（crash_reporter）按壳区分统计。
4. 每周汇总到 `research/release-log.md`；修复回合。
5. 出口评审：崩溃率与问题数对比；回退演练（GPUI → Tauri）通过。

## R2 默认切换（1–2 个版本）
1. 打包：GPUI 主安装包恢复产品名 `CLI-Manager`、主程序 `cli-manager.exe`；Legacy 包改名 `CLI-Manager-Legacy`。
2. latest.json：`windows-x86_64` 指向 GPUI 包（Tauri 客户端经自动更新迁移到 GPUI）。现行 Tauri 更新资产是 MSI：先在草稿 Release 验证 tauri-plugin-updater 2.x 读取 `windows-x86_64` 指向 NSIS `.exe` 时能正确安装（签名同一公钥、passive、cleanup 能停 Tauri 主程序与 daemon）；若不行，改为提供 GPUI 的 MSI 过渡包，或发布一个“桥接”Tauri 版本把 `updaterJsonPreferNsis` 打开后再切。macOS `darwin-aarch64`、Linux `linux-<arch>-deb` 同样验证 Tauri 客户端能安装 GPUI 产物；AUR 由 PKGBUILD 切换。
3. 迁移体验：首次启动 GPUI 检测到旧安装形态（预览版目录、Legacy）时提示卸载多余版本；资源管理器菜单指向新主程序。
4. 场景矩阵全量回归一轮；性能报告终稿。
5. CHANGELOG 记录行为差异；`docs/功能清单.md` 标注。

## R3 Tauri 下线（约 2–3 周）
按 design §5，每类一个提交：
0. 前置：替换签名器（design §5.2 签名工具），用旧 Tauri 客户端校验新签名产物通过。
1. 搬迁：helpers → `apps/helpers`；三个共享 crate → `crates/`；ssh-agent → `apps/ssh-agent`；resources、installer 上移；更新打包脚本与 CI。
2. `.cargo/config.toml` target-dir 改为 `target` 并同步全部脚本/CI。
3. 删除 Tauri 适配层与配置；删除 React 桌面前端与相关脚本/测试（逐个判定，列清单写入提交说明）。
4. 架构治理脚本改入口并重建基线；`npm run check:architecture` 通过。
5. 文档：CLAUDE.md/AGENTS.md/README/功能清单/pty-daemon-manual；spec 归档 React 规则。
6. `detect_changes --scope compare --base-ref master`；GitNexus 重新 analyze。

## 验证命令

```bash
node scripts/bench/run-baseline.mjs --target tauri
node scripts/bench/run-baseline.mjs --target gpui
cargo test --workspace
node --test scripts/*.test.mjs        # R3 后为保留下来的脚本
npm run check:architecture
node scripts/package-gpui.mjs
```

## 估时
R0 约 2 周、R1 一个版本周期（3–4 周日历时间，投入约 1 人周/周）、R2 约 2 周、R3 约 2–3 周。

## 回退
- R1：用户卸载预览版即可；数据共享无需迁移。
- R2：Release 中保留 Legacy 包；如需整体回退，把 latest.json 的 `windows-x86_64` 指回 Tauri 包（版本号需高于 GPUI 版，发布一个 Tauri 补丁版）。
- R3：在 R3 开始前打 tag `pre-tauri-removal`；下线后发现严重问题按 tag 重建 Legacy。
