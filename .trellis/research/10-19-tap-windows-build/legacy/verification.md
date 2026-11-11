# 验证记录

## 基线

- 2026-10-19：远程主干从 `8a007432` 无冲突快进至 `5d1620eb`，版本 1.4.4，修复前工作区干净。
- 标准 NSIS 构建在 Tap 类型检查处报 TS2305/TS1261/TS1149，尚未进入本轮 Rust release 编译。
- 基线 Tap 测试 113/113 通过。终端定向测试 67 项中 64 通过，三项 `terminalUnicode.test.mjs` 失败：家庭组合表情表格占格、reset/备用屏光标列数、Unicode 11 回滚隔离用例。仅证明当前 Node/xterm 环境下失败，不能等同于已证实 WebView2 实机异常；本任务不修改相关源码或断言。

## 修复后

- `npm run tap:typecheck`：通过，Windows 文件名解析冲突消失。
- `npm run tap:test`：113 通过，0 失败、跳过或取消。
- `npm run check:architecture -- --strict`：1435 个源码文件，0 超长，0 违规。
- `git diff --check HEAD`：通过。
- 原组件与新文件 Git blob 均为 `34f00572d8c79ffd673ccc56c3fc0209e6a3c528`，移动前后内容完全相同。
- 生产入口和三处测试引用均更新为 `./ConversationTurnRail`；旧组件导入无残留，工具与样式路径保持原样。
- GitNexus 工具未暴露；两次刷新 codebase-memory fast 索引，以源码检索、契约与 Git diff 复核。修复前图谱未识别组件调用方，未用空 caller 结果代替实际入口检查；修复后已识别 `Conversation`，直接调用的 CRITICAL 标记已告知用户，内容原样与定向验证作为实际变更风险依据。
- codebase-memory `detect_changes` 对 staged/all 两种请求均返回空变更，与真实 Git 差异不符，因此不作为范围已验证的依据；以 `git diff --cached` 的 R100 原样移动和四处单行路径修改完成逐项复核，另有两份产品记录和本任务文档，无其他代码改动。
- 未启动应用或热部署，未做原生手机/桌面交互验收；此次没有 UI 行为或用户文案修改。

## 打包

- 源码提交 `be37dd39`（基于远程主干 `5d1620eb`），分支 `fix/tap-windows-build`，未推送。
- 标准 `npm run tauri:build:local -- --bundles nsis` 退出码 0，完成一个 NSIS bundle；复用 `src-tauri/target/local` 缓存，未清缓存、未构建 MSI。
- 桌面 `tsc && vite build`、经典 Web 与 Tap 生产构建全部通过；Rust release 编译成功，用时 5m53s。仅有既有大 chunk、bundle identifier 及 linker stdout 警告。
- 桌面 `dist/index.html`、经典 `apps/web/dist/index.html` 和 `apps/web/dist/tap/index.html` 均为本轮新生成；Tauri 现有 resources 映射包括经典 Web 和 Tap，未跳过任何客户端。
- 安装包：`F:\gitRepository\CLI-Manager\src-tauri\target\local\release\bundle\nsis\CLI-Manager_1.4.4_x64-setup.exe`。
- 生成时间：2026-10-19 16:22:27 +08:00；大小：30,393,708 字节（28.99 MiB）。
- 安装包及桌面 exe 的 FileVersion/ProductVersion 均为 `1.4.4`。
- SHA256：`BA1446CFACBED1B4AE602AE461729CD26E390ED9A0833808864C144A990D459C`。
- 未安装或启动新包；上游三个 Unicode/Emoji 用例的风险仍保留，等待用户实机验收。

## 追加：安装资源布局回归

- 用户实测旧包 `/tap` 空白后，用其 NetBird 地址复现：HTML 200，所引用的入口 JS/CSS 404；`/tap` 与 `/tap/` 均如此。经典 `/assets` 返回正确文件，网卡与端口正常。
- 只读核验安装目录及旧 NSIS 清单：Tap 的 15 个文件全部平铺在 `apps/web/dist/tap`，没有 assets/fonts 子目录。这推翻了初轮“构建成功即可证明资源封装正确”的不足判断；旧包不可作为 Tap 功能验收通过。
- 核对真实 `tauri-utils 2.8.3` 源码，目录映射保留相对层级，带目标目录的 glob 只保留文件名。本轮只将一个 Tap 源路径从 glob 改为目录，不修改业务函数、网络、卸载钩子或用户安装目录。
- 新增配置回归先在旧配置下失败（原五项通过，新增项指出 glob 错误），修复后 `node --test scripts/tauri-build-local.test.mjs` 六项全部通过。
- 本轮 Tap 测试 113/113 通过，独立严格架构检查通过。完整生产构建及新 NSIS 实际解包结果待打包后补充。
- 提交前按真实 Git diff 复核：仅一行配置、一个已有测试文件增量、相关产品/契约/任务记录；无其他业务代码变化。
- 本轮没有运行时/前端源码变化，采用官方 `tauri bundle` 复用上一轮完整构建的 1.4.4 二进制与静态资源，并读取修正后的映射重新封装；不声称本轮重新编译了未变化的源码。

### 追加修复产物

- 配置及回归提交：`b9682ae9`，当前分支 `fix/tap-windows-build`，未推送。没有修改业务源码或重新编译后端；二进制来自前述最新主干加 Windows 文件名修复的完整构建。
- 命令：设置子进程 `CARGO_TARGET_DIR=F:\gitRepository\CLI-Manager\src-tauri\target\local` 后，执行 `npm run tauri -- bundle --config src-tauri/tauri.local.conf.json --bundles nsis`，退出码 0，完成一个 NSIS bundle；保留既有 beforeBundleCommand，没有构建 MSI。
- 产物仍为 `src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.4_x64-setup.exe`，已替换旧包；文件版本 1.4.4，时间 2026-10-19 17:24:49 +08:00，30,405,144 字节。
- SHA256：`13203B7EC6066FBC96A63F9C3D30D211A49C854C5972C3E6D8B7F03993DB58CE`。
- 用官方 7-Zip 在项目隔离目录执行 archive test 通过（39 个文件），仅提取 Web 静态文件，不执行安装器或卸载钩子。
- 真实 NSIS 内 19 个 Web 文件（其中 Tap 15 个）与构建源树的相对路径、文件清单及 SHA256 逐项完全一致，没有缺失、多余或内容不同。
- HTML、CSS、manifest 的 11 项本地资源引用全部可解析到解包文件，包括 `/tap/assets/index-N8vi0kO4.js`、入口 CSS 和 `/tap/fonts/inconsolata-latin-wght-normal.woff2`；动态分块也已在前述逐文件比对中核验。入口 JS 不再被平铺到 Tap 根目录。
- 详细本地日志：`.codex/tap-resources-20261019-{before,tests,tap-tests,architecture,build,archive-test,extract}.log`；逐文件及引用核验结果：`.codex/tap-resources-20261019-verification.json`。这些为本地验证产物，不提交。
- 未覆盖 `F:\cli-manager`，未安装或停止现有应用/9090 服务；浏览器连接新包的实机验收需用户安装并重启 Web 服务后执行，不能把当前旧服务的结果当作新包结果。上游三项 Unicode 测试失败仍保留。
