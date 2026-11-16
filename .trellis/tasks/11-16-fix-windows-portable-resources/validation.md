# 验证结果 — 2026-11-16

## 根因证据与修复

发布 Action 43822127758 的 Windows job 133148643340：Web 构建及 MSI/NSIS 构建、更新签名与上传成功；便携步骤在 `target/release/apps/web/dist/index.html` 缺失处失败。

回归先运行旧脚本：夹具中四个 EXE、仓库资源和 Classic/Tap 输出均齐全，但没有 Cargo 资源副本，测试确实在同一必需 Web 路径失败。修复后该夹具成功生成 ZIP。

便携包现在通过独立的 `SourceDir`、`ResourcesDir` 和 `WebDistDir` 读取生产者输出；资源与 ZIP 目标布局独立。没有取消缺失校验，也没有在多个目录之间猜测或取旧副本。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `node --test scripts/package-portable.test.mjs`，PowerShell 7.7.0 | 15/15 通过，零跳过 |
| `CLI_MANAGER_PORTABLE_TEST_POWERSHELL=powershell.exe` 的同一测试，Windows PowerShell 5.1 | 15/15 通过，零跳过 |
| `node .github/scripts/release-workflow.test.mjs` | 通过 |
| `node --test scripts/tauri-build-local.test.mjs` | 7/7 通过 |
| `npm run check:architecture -- --strict` | 1522 个源文件，零 2000 行超限，零违规 |
| `git diff --check` | 通过；仅仓库 CRLF 设置提示，无空白错误 |

打包测试直接执行 PowerShell 脚本，用 .NET ZIP API 读取每项原始字节并对照夹具源内容。覆盖干净 release、旧副本、重复打包、绝对/相对/空格路径、独立二进制来源、版本规范化、四个 EXE、两个 HTML、两个 assets 目录、资源目录缺失，以及显式错误路径和非法版本。缺失输入均保留已有 ZIP/staging。

## 触点复核

- 已修改：便携打包入口、新回归、Windows 工作流回归步骤及前置校验、V1.5.1 CHANGELOG、Windows 功能清单、便携包契约。
- 已确认无需修改：`web:build` 的 Classic→Tap 输出、Tauri 资源映射、Rust build.rs、helper/bundle 二进制准备、安装包签名与资产发布闸机。
- 已确认无关：应用运行时、窗口状态、分屏、PTY/IPC、WSL 项目、Worktree、CLI Hook。

## Graph 与交付限制

本地实现时，GitNexus File impact 对 `package-portable.ps1` 报 LOW；`release.yml` 与 `stepIndex` 未命中，报 UNKNOWN，实际调用及 Windows 条件通过源码文本补充确认。首次扫描的索引落后当前 HEAD，`detect-changes --scope all` 返回 `No changes detected`，不能解读成无影响，因为 PowerShell/YAML 与新增测试没有完整图覆盖。

验证使用独立夹具二进制与资源，隔离此次打包交接问题；没有重新编译完整 Rust release或安装产物。代码更新已快进到 `20a419fb`。原 Action 绑定旧发布提交，直接重跑不会包含本地修复。

## V1.5.1 重新推送

用户随后明确删除远程 V1.5.1 标签并授权重新推送。提交前只读检查确认远程标签不存在，master 与远程 `20a419fb` 同步，工作区全部变更属于本任务；npm、两处 npm lock、Rust manifest/lock 与 Tauri 六处版本均为 `1.5.1`，签名更新产物仍启用，提取的 V1.5.1 发布说明包含此次便携包修复。刷新 GitNexus 索引并分析 staged/all 变更后提交，将 master 和指向修复提交的 V1.5.1 标签推送，由标签 push 触发正式发布工作流。

### 刷新后的 Graph 复核

- 索引成功刷新：36,108 nodes、154,747 edges、300 flows；FTS 扩展不可用，不影响此次图引用结果。
- staged/all 分析报告 11 文件、7 个新测试顶层常量；CLI 标为 299 个 flow、MCP 标为 293 个 flow，风险均为 **critical**，没有将该结果视作清洁检查。
- `missingInputs` context 被关联到几乎所有运行流程，并显示来自其他测试的 10 个文件引用及与源码不符的 Markdown imports。完整 context 已通过 CLI 捕获并解析，结果没有 partial/truncated 标记，完整引用核查覆盖这 10 个文件。
- 逐个检查这 10 个引用文件：均没有 `missingInputs` 标识符，也没有导入本次测试。全局定向文本核对仅发现本测试内部声明和循环使用该常量；发布工作流只通过独立 `node --test` 进程调用该测试。实际测试仅导入七个 `node:*` 模块，未导出任何应用符号。
- 因此此次 critical 来自可证实的索引引用误关联；保留报告及限制，不通过改测试或忽略风险来使图报告变绿。实际变更仍限定于打包脚本、工作流回归与记录，依据两种 PowerShell 下全部 15 项真实打包测试、工作流验证、既有 7 项配置测试和零违规严格架构检查继续授权的提交推送。
