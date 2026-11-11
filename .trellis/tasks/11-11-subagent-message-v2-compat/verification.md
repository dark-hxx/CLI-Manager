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
- 安装包信息待构建核验后补充。
