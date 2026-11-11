# 验证记录

## 范围与安全边界
- 分支 `refactor/remove-cc-connect`，基线 `6dd0385e`（master 与已记录 origin/master 同步），新分支无上游；未同步远程、未推送。
- 移除 cc-connect 前后端入口与生命周期；提取真实 CLI 解析，保留 Web/Tap、普通 Hook/审批、SSH 和供应商公共能力。
- 不卸载外部工具、不全局杀进程、不修改用户供应商/Home 配置、不删除凭据或历史。旧托管窗口完整备份到会话 Store 的 `retiredRemoteHandoffSessions`，不自动重启；停止旧外部服务后可从历史恢复。
- GitNexus 未暴露，实现后 codebase-memory 刷新/detect_changes 返回 Transport closed。以当前源码、完整 Git 差异、契约和可执行测试复核，未把过期图当作当前结论。

## 自动验证
- 桌面 `npx tsc --noEmit`、`npm run web:typecheck`、`npm run tap:typecheck`：通过。
- 定向 Node 回归：118/118，通过退役快照、备份顺序、失败关闭/重试去重、混合分屏恢复、桌宠状态/几何/传输、历史恢复、Hook profile、数据迁移与打包契约。
- Tap 测试：113/113。
- Rust 定向：70 通过，1 项保持上游默认 ignored（需要已安装 Codex/Claude 的只读版本探测）；覆盖共享 launcher、旧快照引用、Web conversation、Codex proxy、供应商 runtime/profile 信任与数据目录迁移。
- Codex proxy E2E：4/4，实际编译 helper 并使用隔离 fake CLI，无真实供应商请求。
- 设置 Chromium 隔离夹具：10/10，覆盖生产设置外壳、焦点/Escape、深浅主题及中英文；业务服务隔离，不启动 Tauri 实例。首次因预装 Playwright 路径不存在失败，改用 ignored `.codex/tools/browser-test` 的隔离安装后通过，未改变项目依赖。
- `npm run check:architecture -- --strict`：1401 源文件，0 超过 2000 行，0 新违规。
- `git diff --check`：通过。Rust 仅链接器创建库/对象文件的信息性 warning；之前移除运行期专属 helper 后测试引用的编译失败已修正并重测。

## 未覆盖
- 未安装或启动新应用，未停止用户的现有 Web 服务；真实手机、真实账号、SSH 主机及旧外部服务退出由用户安装后验收。
- 上游已有的 3 项 terminalUnicode 回归失败不在本轮范围，未修改或跳过断言掩盖；本轮仅执行相关定向套件。
- 保留旧设置 tab ID 和只读旧快照/socket 兼容不是保留 cc-connect 运行模块；旧独立程序如仍运行，本轮不会擅自终止。

## 打包
- 代码提交 `ba0b98ed` 后，执行 `npm run tauri:build:local -- --bundles nsis`，退出码 0。桌面/Web/Tap 生产构建、缓存 Rust release（5 分 59 秒）及 NSIS 均完成；有 Rust 变更，没有仅前端重封装，没有构建 MSI。
- 安装包：`F:\gitRepository\CLI-Manager\src-tauri\target\local\release\bundle\nsis\CLI-Manager_1.4.4_x64-setup.exe`。
- 时间：2026-10-19 18:35:57 +08:00；大小：28,961,070 字节；安装器和解包桌面 exe 的文件版本为 1.4.4。
- SHA256：`B03BED6E724A740C79301AB4BAF261771E25B376912C326A2E383B018F85B7FF`。旧同名包已在 ignored `.codex/packages/` 原样旁备份并核对旧哈希。
- 官方 7-Zip archive test 及非安装解包通过（39 文件）。19 个 Web 文件（Tap 15 个）的相对路径/完整清单/SHA256 与构建源树完全相等；11 项 HTML/CSS/manifest 引用均存在，保留 `/tap/assets` 与 `/tap/fonts` 层级。
- 3 个 helper exe 与 release 源字节完全相同；桌面 exe 与 release 仅在 Tauri 的 `__TAURI_BUNDLE_TYPE_VAR_` 标记处有 NSS/UNK 三字节差异，其他字节完全相同。已核对 tauri-utils 2.8.3 的 NSIS 枚举标记；这是 bundler 注入/还原标记，不是混入旧二进制。
- 桌面生产 JS 已核对不包含旧 cc-connect IPC 和桌宠托管 action。当前代码提交没有打包生成的额外工作区改动。
- 本地证据：`.codex/remove-cc-connect-{build,archive-test,extract}.log`、`.codex/remove-cc-connect-package-verification.json`。没有执行安装器、没有启动热部署或改动现有服务；等待用户实机验收。
