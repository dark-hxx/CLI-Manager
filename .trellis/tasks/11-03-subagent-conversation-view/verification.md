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
- 安装包解包/哈希及资源清单核对结果在构建完成后补充。不安装、不合并 master、不推送。
