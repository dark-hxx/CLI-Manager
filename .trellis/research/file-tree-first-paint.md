# 文件树首屏加载与 Git 查询解耦

## 范围与决定

- 2026-11-13：用户要求修复目录加载慢并打包，后续明确要求不要因任务/版本确认停止。按已提出的默认方案新建本记录，从已验证的本地 `97ee6daa` 建 `fix/file-tree-first-paint`；保留 helper WebView2 构建兼容修复，不同步远程。
- 安装包保持当前 1.5.0，未另外指定变更记录版本，因此按规则记 TEMP。验证后先本地提交，再仅构建 NSIS，不安装、不推送。
- 不把本轮首屏修复当作主进程高内存问题的修复；不改 Git 扫描/统计算法、文件操作、数据库、终端或运行中会话。

## 根因

文件 Store 的打开流程用 `Promise.all` 把根目录读取与完整 Git 变更/增删行数查询绑定，直到两者都完成才发布树并结束 loading。阻塞位于前端编排边界，而非必须重写文件系统读取。

- 修改前已用原函数与完整 Store 的延迟 IPC 测试复现：目录已返回但 Git 未返回时，文件树仍为空、loading 不结束，恢复文件预览也被推迟。
- 修复为先发布目录、结束 loading，再后台收集 Git 标记；目录失败不启动可选 Git 查询，Git 失败沿用原有降级，不清空已显示的目录。

## 发现清单与影响面

- 已修改：`src/features/files/api/fileExplorerStore.ts` 的 `openProject` 编排和迟到 Git 发布检查。
- 已核对：`FileExplorerSidebar` 只在 loading 且树为空时显示首屏等待；无需更改 UI/文案或样式。
- 已核对：侧边栏、终端面板和文件编辑器通过此 Store 打开项目；Git Diff 的 await 调用只依赖目录就绪和后续 reveal/pinned diff，不依赖初始 Git 标记已经返回。
- 已确认无须修改：`file_list_dir` 单层枚举、WSL find、SSH context/release、Git 变更查询和 Diff 行数统计，以及现有后台刷新。
- 调用图将共享 Store 到编辑器/终端切换入口标为 CRITICAL，已在编辑前告知用户；不把未解析的动态对象方法当成无调用。
- GitNexus MCP 未暴露且 `.gitnexus/run.cjs` 缺失。降级为 codebase-memory 图/搜索、领域契约、真实调用方源码、Git diff 和可执行测试；提交前再做变化分析，不把空结果当成干净结论。

## 场景与验证

- 定向测试覆盖本地/WSL 的慢 Git、空目录、慢目录、Git 失败、目录失败、切换项目、同项目 Worktree、大小写不同的 WSL 路径、关闭面板、切回原项目共享 pending 请求、旧目录失败、SSH 无本地调用及恢复文件预览。
- 第一轮红测试中 SSH 合成 Project 缺 `remote_path`，已补齐测试对象；不是生产 SSH 故障。其余失败证明旧首屏阻塞。
- 修复后 14 项新增测试及 21 项原有文件/项目/刷新/预览回归全部通过。
- 扩大到全部文件树/文件内容相关测试共 114 项通过；另有 7 项构建入口回归通过。桌面、经典 Web、Tap 类型检查与生产构建通过，未新增用户文案或样式。
- 普通和 strict 架构检查均仍报主干既有两项：`settingsStore.ts` 2063 行和 `TerminalStatusBarSettingsPage.tsx` 私有跨域导入；两文件与本轮基线完全一致，不新增豁免或夹带无关修复。
- Windows 主程序会重新构建以嵌入新前端；只打 NSIS。产物、源码提交、资源清单与解包核验保存在本地 `.codex/file-tree-first-paint-*`；不宣称未经执行的原生安装版体验已经验收。

## 交付与用户验收

- 1.5.0 NSIS 基于源码提交 `6b119883` 构建并完成解包核验：19 个 Web/Tap 文件、447 个嵌入桌面 JS 资源键、4 个实际构建二进制及首屏 Store 新 chunk 均已核对。安装包 SHA256：`5E06C12BAA80D42602942F4BDFDBBFD812A39851E1EE656F00D38635BBDC7010`。
- 首轮 helper 最终链接缺少 Tauri 库 build script 的 CRT 参数；重试仅在当前打包进程的 `LINK` 环境复用该输出的 11 项 `/NODEFAULTLIB`、`/DEFAULTLIB` 参数后成功。未修改 Rust 业务代码、系统全局环境或跳过 helper 构建。
- 2026-11-13：用户安装实测确认修复并授权推送。远程主干新增 `a3ffeefb` 统计界面更新；无冲突合入本轮修复及前置 helper 锁文件兼容修复，只推送 master，保留本地开发分支但不发布。
- 合并后 125 项文件树/文件内容/统计/构建定向测试及 TypeScript 检查通过。严格架构检查为远程既有 3 项：原 2 项外，`a3ffeefb` 的 `StatsPanel.tsx` 达 2020 行；该文件保持与远程一致，不扩大本轮推送范围修复。此次未重新打包远程新增统计界面。
