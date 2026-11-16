# 设计

## 根因与修复边界

故障位于构建产物到便携包的交接边界：打包脚本要求资源出现在 Cargo 的 release 二进制目录，虽然发布中真正的 Web 生产者已成功，该目录仍缺少其副本。便携包应直接读取构建生产者的明确输出，资源准备与二进制输入分别表达。

`SourceDir` 保持二进制输入；新增 `ResourcesDir`（默认 `src-tauri/resources`）与 `WebDistDir`（默认 `apps/web/dist`）。所有相对路径都相对脚本所在仓库根解析，绝对路径直接规范化。先验证所有输入，再替换输出；递归复制完整资源目录和 Web dist，沿用既有 ZIP 运行布局。

不增加寻找多个目录的兜底，不在错误处隐藏缺失资源，不从可能过期的 Cargo 副本取资源。

## 发现清单

- `scripts/package-portable.ps1`：改资源输入与校验，保持输出目录保护及 ZIP 布局。
- `package.json` 的 `web:build` 与 `apps/web`/`apps/web-tap`：确认生产 Classic 后再生产 Tap；无需修改。
- `src-tauri/tauri.conf.json`、`build.rs`、`prepare-bundle-binaries.mjs`：确认安装包资源从仓库读取；无需修改。
- `.github/workflows/release.yml`：增加 Windows 定向打包测试，现有真正打包/上传/发布资产闸机保留。
- `.github/scripts/release-workflow.test.mjs`：验证回归步骤在正式打包之前。
- Web runtime、PTY、IPC、窗口焦点、分屏、WSL 项目、Worktree、Hook：此次构建主机资源路径无关，确认不改。

## 场景

| 场景 | 行为 |
| --- | --- |
| 干净 runner，没有 release 资源副本 | 从仓库生成输出与源资源打包 |
| release 存在旧资源副本 | 只使用明确的资源输入 |
| 默认 / 自定义 release 目录 | 仅影响四个二进制来源 |
| 相对 / 绝对 / 空格资源路径 | 统一规范化，使用 LiteralPath 复制 |
| Classic、Tap 或资源输入缺失 | 替换输出前失败 |
| Tap 多级 assets/fonts | 完整保留目录和内容 |
| 重复打包 | 校验成功后替换旧 staging/ZIP |
| macOS/Linux 发布、应用运行状态 | Windows 回归条件隔离；相关行为不改 |

## 风险与回滚

GitNexus 对 `package-portable.ps1` File 上游分析为 LOW，零索引内调用/执行流；`release.yml` 与 `stepIndex` 未命中，风险为 UNKNOWN，已通过实际 YAML 和内部 `stepIndex` 调用文本确认作用范围。索引落后当前代码，变更扫描未覆盖此次 PowerShell/YAML，因此不能将零结果解读为无影响，定向真实打包测试为最终证据。自定义旧目录调用可通过显式资源参数使用原布局。回滚仅涉及打包输入、回归与工作流步骤。
