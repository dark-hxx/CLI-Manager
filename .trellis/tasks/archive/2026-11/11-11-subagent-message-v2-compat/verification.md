# 验证与交付边界

## 根因与落点
- 新版 Codex 的 `response_item.agent_message` 被共享解析器忽略，首条 child 身份被继承的 parent meta 覆盖，大文件尾读又会丢失头部。修复落在 Rust 有界读取、共享解析/裁剪和真实桌面/Web 入口，不改普通 PTY、Hook、Tap 或用户日志。
- 正文明文按左右对话显示；明确加密的通信只显示来源及中英文不可读取提示。此次不能还原源日志本身不存在的明文，不读取额外父日志、不解密、不编造任务。

## 已验证
- 16 项 Node 定向测试通过：旧 Codex/Claude、v2 明文/加密/混合、嵌套/同级/无身份、继承 meta、增量/reset、三个有界消费入口及 Web 快照预算。
- Rust `cargo test --lib subagent_transcript::tests`：27/27 通过，覆盖大文件尾读白名单身份、精确 offset、文件缩短、超大元数据拒绝及既有本地/WSL 路径发现；`cargo check` 通过。
- 桌面 TypeScript/生产构建、经典 Web/Tap TypeScript/生产构建通过。桌面保留既有大 chunk 警告，不做无关分包重构。
- 隔离浏览器挂载真实桌面 Store/组件与经典 Web 面板，新旧对话、加密提示/双语、跟进消息、隐藏追平、reset、子代理切换、300 条上限、阅读滚动、深浅色及 390px 回归通过；已查看截图，浏览器和测试服务正常退出。未启动 Tauri/真实应用。
- 真实问题转录仅在内存中重放，完整与模拟新 Rust 尾读均正确保留 29 详情、主代理加密消息提示、子代理最终答复；真实正文未复制进代码/测试。
- 独立 strict architecture：1489 源文件、零长度超限，但基线已存在 SidebarFooter -> settings/lib/sponsors 一项跨功能导入违规。本轮该文件与 master 相同，不将检查标为通过，不添加豁免或夹带修复。
- GitNexus MCP 不可用且本地 runner 缺失，按规则降级 memory 图/契约/源码；实施后索引 30041 节点/99976 边，确认裁剪工具有 Store、桌面窗口与 Web 快照三个真实调用方。detect_changes 能枚举修改文件但 impacted_symbols 为空，与真实调用链不符，不当作无影响证明；完整 Git diff 和定向验证为最终依据。

## 本地交付约束
- 分支 `fix/subagent-message-v2-compat`，基线 `73874439`。未 fetch/pull/merge/push，不合并本地主干，不安装；仅沿用 1.4.4 NSIS，提交后构建。
- 保留 1 MiB 尾读（额外有界首行身份提取）、4 Mi 字符 Store、2 Mi 字符解析、300 展示行与 Web 快照预算。超出尾部窗口的历史、无有效头部/turn 的旧片段依旧可能省略或显示来源未确认，不伪称完整审计转录。

## 安装包核验（2026-11-11）
- 代码先提交为 `65691452`，再从该提交构建 1.4.4 NSIS。复用已验证的前端产物，主程序及三个 helper 按现有锁文件重新编译；未复用旧后端充当新包。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.4_x64-setup.exe`，31,663,461 字节，2026-11-11 14:58:43 +08:00。
- SHA256：`BDA9B0A853B7790D2B537A3C2E6F24E76EEBC121ABBEFBA224407785202042E6`。
- 7-Zip 完整性检测和解包通过，19 个 Web 文件（含 15 个 Tap 文件）逐项 SHA256 与本轮构建产物一致；448 个桌面 JS 资源 key 确认嵌入新主程序，新解析/加密提示资源均存在，所有 HTML/CSS/manifest 引用可解析。
- 三个 helper 与本次编译产物逐字节一致；主程序仅有 Tauri NSIS 的 `NSS/UNK` 三字节标记差异。机器可读记录 `.codex/subagent-v2-package-verification.json`。
- 旧 NSIS 保存在 `.codex/packages/CLI-Manager_1.4.4_before-subagent-v2-20261111-144641.exe`；无应用安装/启动或用户配置变更。工作分支保留，等待用户安装验收，master 仍为 `73874439`；没有远程同步。

## 用户验收与主干集成（2026-11-11）
- 用户确认 A/B 两个真实子代理各两轮往来正常，随后授权提交/合入远程主干并恢复“状态栏”入口；沿用主干 1.5.0，不另打包、不推开发分支。
- 按新授权 fetch 远程 master，取得 17 个提交，基线 `50e0f17f`。合并只有 CHANGELOG 与功能清单两处文档冲突；按主干 1.5.0 分类保留双方内容及已验收的新版子代理记录兼容说明，不覆盖远程设置样式、图标和其他功能。
- 状态栏消失的根因是远程 `b2c4b525` 从静态 `SETTINGS_TAB_ORDER` 移除了该项；原页面、翻译、渲染分支和后端保留。只恢复导航项并纳入宽内容布局，不改保存/安装/运行链路，不恢复“命令提示”菜单。核对触点：SettingsModal、桌面/紧凑导航、StatuslineSettingsPage、中英标签；后端和配置已确认无关。
- 导航恢复属于已有页面的局部静态配置修复，不新建任务；实际 SettingsLayout 中英渲染、源 AST 导航顺序、原页面接入与隐藏项隔离均有回归。
- 合并后 28 项设置/子代理定向测试及 31 项设置/首页回归全部通过；桌面/Web/Tap 构建及类型检查、Rust cargo check、真实桌面/Web 子代理隔离浏览器回归均通过。未启动真实应用，浏览器及测试 HTTP 服务已退出。
- 独立 strict architecture：1499 个源文件、零长度超限、零违规；此前的 sponsors 跨域问题已由远程主干修复，本次未夹带修改。子代理 7 个核心源码与已验收 `65691452` 逐字一致。
- GitNexus runner 仍缺失，降级 memory 图/契约/源码。SettingsModal -> App 被标为 CRITICAL，已告知；刷新主干/实施后索引（30309 节点/100049 边）。compare 只覆盖已提交的旧分支差异，all/staged 返回空清单，与 Git 相对远程的 24 项暂存差异不符；不视为安全证明，以实际 Git diff/调用入口及上述测试为准。
- 本轮仅验证与源码集成，不生成新安装包；之前 1.4.4 NSIS 仍对应 `65691452`，不将其称为最新 1.5.0 主干安装包。验证通过后按授权仅推送 origin/master，不强推、不创建 PR。
