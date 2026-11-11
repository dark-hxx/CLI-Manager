# 验证与交付边界

## 实施与影响范围
- 根因：原共享解析器把任务、工具与思考拼成一个 text，展示入口再全量渲染。因此在共享 JSONL 解析/快照边界保留分类与归属证据，桌面和经典 Web 接入同一只读展示组件。
- 已核对触点：共享解析器/快照、桌面 SubagentTranscriptView、经典 Web SubagentPanel、中英文、样式、定向测试、领域契约；Rust tail、Hook、PTY、PaneLeafView、历史编辑与 Tap 执行链不改。
- 分支 `feat/subagent-conversation-view`，基线 `12115cc3`；无上游。未 fetch/pull、合并或推送；master 保持不变。
- GitNexus 不可用，使用 memory moderate 索引（实施后 45292 节点 / 118693 边）和源码/diff/测试复核。图确认新组件只接入桌面与经典 Web 两个直接调用方；共享解析器 HIGH/CRITICAL 影响已提前告知。

## 已验证
- `npx tsc --noEmit`、`npm run web:typecheck` 通过。
- `node --test scripts/subagentConversation.test.mjs scripts/historySubagentHierarchy.test.mjs`：10/10 通过；真实解析器、Codex phase/turn/继承上下文、Claude 混合块、追加/reset、异常行、Web 兼容/字节预算/多子代理隔离与层级回归。
- `node scripts/subagentConversation.browser.mjs`：隔离 Edge 浏览器挂载真实桌面 Store/组件及经典 Web 面板。默认折叠（无隐藏 Markdown DOM）、展开/执行记录、长原文、追加/reset、隐藏追平、切换子代理、300 条上限、向上阅读不被抢滚动、中英文 24 小时时间、深浅色及 390px 无横向撑破均通过；已查看截图。
- `npm run build`、`npm run web:build`（含 Tap）通过。桌面仍有现有大 chunk 提示；不为本轮功能扩展到全局分包重构。
- `npm run check:architecture -- --strict`：1441 个源文件，零超限/零新违规；`git diff --check` 通过。
- 首轮浏览器测试的双应用 Tailwind 根扫描失败属于夹具配置问题；改用 esbuild 打包真实组件与生产 CSS 后通过，不修改生产 Tailwind 配置。

- 提交前调用 memory detect_changes(staged) 返回空清单，与 Git 的 20 个已暂存文件不符；不采用空结果作为安全证明，以完整暂存 diff、源码调用方与上述验证为准。

## 有意保留的边界
- 不额外订阅父转录，不合成子日志未记载的父子对话。来源不明确的旧 Claude/Codex 或裁剪尾部记录保留中性标签；明确继承/注入内容可在详情中查看。
- 原始日志不修改；视图仍受既有尾部/消息数/Web 字节预算限制，图片二进制不展开。不承诺执行记录是原始 JSONL 的逐字审计副本。
- 未启动/安装用户应用，未修改真实会话或配置。自动测试替代了语言设置的隔离状态切换；真实 WSL/SSH、Hook 到转录发现的端到端仍复用未改链路，需用户用安装包实测。

## 打包
- 先提交再构建 1.4.4 NSIS；主 exe 重新编译嵌入前端。三个 helper 与已验证 `93a158ca` 包的 SHA256 一致且后端源码无差异，经本地构建钩子再次校验后复用。
- 构建代码提交 `deb00765`；NSIS 已生成，未安装、未合并 master、未推送。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.4_x64-setup.exe`，31642318 字节，2026-11-03 20:06:24 +08:00。
- SHA256：`8A1E9F7456BD37856BF1E9DE3748C6DDACC89351826505213B2EDDB3A9366902`。
- 7-Zip 归档检测/解包通过；19 个 Web 文件（含 15 个 Tap 文件）与构建产物逐项匹配，447 个桌面资源 key 确认嵌入新主程序，11 处 HTML/CSS/manifest 资源引用有效；三个 helper 与已验证旧包逐字节一致。主程序与 raw exe 仅有 Tauri NSIS 的 NSS/UNK 三字节标记差异。
- 初次 beforeBundle 安全校验发现主 crate 的 cargo build 覆盖了 release 目录中的 helper，因此主动阻断打包；本地钩子改为从已核验的 helper-binaries 缓存复制三份独立 helper 后重新封装。未修改正式打包配置；重试构建成功。
- 验证记录：`.codex/subagent-conversation-package-verification.json`；构建与浏览器日志、深浅色/窄屏截图均在 `.codex/subagent-conversation-*`。隔离浏览器及测试 HTTP 服务已退出。
- 任务进入 review，等待用户安装验收；不提前归档。

## 用户验收与主干集成（2026-11-03）
- 用户更新后要求启动多个子 Agent 实测；3 个独立子 Agent 和一轮追加对话完成，用户确认“测试正常”，随后授权合并主干并推送仓库。
- 本轮 fetch 获取远程 master 的 25 个新增提交，先将本地 master 快进到 `e0a1261e`，再合并已验收的 `feat/subagent-conversation-view`。合并无冲突，双方翻译/变更说明均保留；解析器、展示组件、桌面/Web 入口与已验收功能分支逐字一致。
- 合并定向回归 31/31 通过（子代理解析/层级、键盘路由与 Web/Tap 镜像）；桌面 `tsc --noEmit`、Web/Tap 类型检查及真实桌面/Web 隔离浏览器回归均通过，测试 HTTP 服务与浏览器已停止。
- 严格架构检查：1487 个源文件零长度超限，但远程主干已有一项 `SidebarFooter.tsx -> settings/lib/sponsors` 跨域导入违规。相关文件与 `origin/master` 完全一致，本次不夹带赞助模块修复、不新增豁免，不将该检查标为通过。
- GitNexus MCP 未暴露，CLI runner `.gitnexus/run.cjs` 不存在（MODULE_NOT_FOUND）；降级刷新 memory moderate 索引并调用图变更分析。memory 的空调用/变更结果与真实 JSX 调用和已暂存差异不一致，不作为无影响证明，使用完整 Git diff、真实入口及定向验证复核。
- 仅授权推送 `origin/master`，不推开发分支、不强制推送；本轮不重新打包，之前安装包仍对应 `deb00765` 交付。
