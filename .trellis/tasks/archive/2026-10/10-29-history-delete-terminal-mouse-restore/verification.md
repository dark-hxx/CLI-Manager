# 验证与交付（1.4.4）

## 根因与触点

- 历史：源文件删除和元数据清理已完成，Store 仍等待下一条详情；dirty catalog 详情又等待全库串行刷新。实际只读日志中单条 FTS 删除耗时 22.03 秒及 35.29 秒。完成边界修在 Store，等待修在 Rust 详情入口，而非给确认框加超时。
- 鼠标：安装版 xterm 6.1.0-beta.288 的 SerializeAddon 保存 tracking，却未保存坐标编码，真实浏览器复现原 SGR 恢复成 legacy ESC[M。完整状态修在快照生成端，兼容仅限已知快照边界。
- 修改：historyStore、history_get_session、V2 详情存在性检查；定时/卸载快照、静态恢复、daemon attach/reconnect replay、SessionBuffer checkpoint。完整触点与边界见 design.md。
- 核对不改：确认框/防重入/源删除备份回滚；OpenCode DB locator；实时输入/原始 replay、query 所有权、历史尺寸、原始字符 ACK 计数。无新增 IPC/持久化格式或依赖。

## 自动化结果

- Node 定向组合 **111/111**：historyDeletion、historyDeletionConcurrency、terminalSnapshotMouse、terminalReplay、terminalSnapshotPersistence、terminalMouseInteraction、ptyHostSocket。执行真实 Store/确认回调/回放 Hook 和生产快照模块，仅 mock 外部边界。
- 真实安装版 xterm + SerializeAddon / 隔离 Edge 浏览器 **19/19**：15 种 tracking/encoding 组合的实际点击/拖动/移动字节、目标旧模式清理、2000 行尾裁切、reset、旧快照安全恢复与重新开启、Shift 选择。
- Rust：catalog **34/34**，daemon server **35/35**，Codex deletion **12/12**；独立 mouse_snapshot 过滤 **2/2**（包含于 daemon 计数，不重复累计）。全部使用临时/内存夹具。
- `npx tsc --noEmit`、桌面 `npm run build`、经典 Web + Tap `npm run web:build` 全部通过。Vite 仅提示既有大 chunk 体积警告。
- 独立 `npm run check:architecture -- --strict`：1436 源文件，零超限、零违规；`git diff --check` 通过。
- GitNexus 未暴露，按契约 + codebase-memory moderate（45195 节点/117241 边）+ 实际源码降级。新快照符号调用已核对；TS 动态 Store 调用图缺边。提交前 staged detect_changes 仍返回空，与 27 文件实际差异不符，按真实暂存差异逐项验收，不将空影响列表视为零风险。
- 日志位于 ignored `.codex/history-mouse-*.log`、`.codex/terminal-mouse-browser.log`。

## 发布与未覆盖项

- 构建前提交修复，再复用 Cargo 缓存重建主程序/必要 helper，仅 NSIS。桌面资源嵌入 exe，本轮不是旧后端重新封装。
- 不启动安装版/Tauri、不删除用户真实会话、不强杀 daemon、不安装或推送；实机 Windows/Codex、多窗口/WSL 以及手机 Safari 留给用户验收，不声称已验证。
- 旧快照的原编码已不可恢复：只对明确快照暂停不安全鼠标跟踪，应用重新声明后正常工作；新快照保真。无法识别的旧 daemon 会话需要关闭并重新打开，不猜测 SGR，不全局禁用鼠标。
- 未变更用户可见文案；无新增翻译。中英文界面实机切换未执行，相关既有文案及 24 小时格式未改。
- 失败处理：修正 ES2020 不支持 Object.hasOwn；补齐旧 replay 测试 mock 的 sessions；Shift-hover 本来可发送报文，断言限定实际选择手势，不改变生产策略；已撤销与任务无关的 rustfmt 改动。

## NSIS 实包验证

- 代码先提交为 `93a158ca9bb0a30892fcc0becd3430a1dd5b172d`；构建使用已验证且指纹不变的桌面/Web/Tap dist，ignored 本地 override 仅跳过重复前端构建，保留完整 Rust/helper 编译和 bundle hook。不改 tracked 打包配置、不复用旧后端冒充修复。
- 缓存 release 主构建 11m02s，helper 构建 10m58s，最终仅输出一个 NSIS；编译期间有 MSVC 创建导入库的 stdout 警告及已有 STATIC_VCRUNTIME 弃用提示，无构建失败。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.4_x64-setup.exe`。
- 生成时间：2026-10-29 10:11:12 +08:00；31,635,108 字节。
- SHA256：`FE878C50719B96AED210BC35AAFFF275DD7849A5F145EC4293B510E7250B854A`。
- 7-Zip archive test 与解包成功；19 个 Web/Tap 文件（15 个 Tap）路径及 SHA256 全量一致，11 个静态引用全部存在，字体 `/tap/fonts/inconsolata-latin-wght-normal.woff2` 保留。
- 主程序含本次桌面构建全部 447 个 JS 资源键，本次修复代码在 `assets/App-BqqVdbDW.js`；四个二进制与本轮 release 构建逐字节核对。主程序唯一允许差异为 Tauri 已验证的 NSS/UNK 三字节 bundle marker，主程序与 daemon 均非旧构建。
- 旧包先备份并核对 SHA256。详细 manifest/二进制/源提交指纹：`.codex/history-mouse-package-verification.json`；构建日志：`.codex/history-mouse-nsis-build.log`。
- 首次验证脚本误以为字体在 `tap/assets/fonts`，与源 manifest 不符；核对源 CSS、完整 manifest 及解包结果后改为实际 `tap/fonts` 精确文件断言，重跑全部验证通过。没有为此修改程序或降低文件/指纹校验。
- 安装包验证时工作区干净且 HEAD 为上述代码提交；其后仅提交本验证记录与任务进度，不改变交付代码。未安装、未启动用户应用、未推送，等待用户验收。

## 用户验收与合并授权（2026-10-29）

- 用户反馈“修复了”，同意按原流程推送仓库，并明确本地开发分支不用推送。
- 本轮开始工作区干净，修复分支无上游；fetch 后本地 master 与 origin/master 均为 `e4b0c3d2`，领先/落后 0/0，无新增远程冲突。
- 任务验收归档，仅补充验收记录；实现及已验证安装包不变。将修复合并到 master，并且只更新 `origin` 的 `refs/heads/master`，保留本地开发分支，不创建或更新其远程分支。
