# GPUI Provider 与路由面板迁移

## 目标

在 GPUI 原生壳中完整承接 Provider 目录、全局供应商切换、路由与快速切换能力，并与 Tauri 壳共用 providers.db、当前 Home 与 daemon 状态。阶段性交付必须能独立验证；首阶段建立只读目录和当前状态入口，后续再开放编辑与写操作。

## 用户需求

- 在 GPUI 中按 Claude、Codex、Grok 浏览 Provider，查看当前供应商、启用状态、端点/模型等非秘密摘要。
- 查看当前 Home、全局配置应用状态、路由代理和故障转移状态；可用时由 daemon 事件更新，不可用时提供明确刷新/错误状态。
- 管理 Provider、配置文档与密钥，保持 Tauri 壳数据兼容、秘密遮罩与保留规则一致。
- 支持全局 Provider 预览和应用、路由/接管配置、故障转移设置及命令面板快速切换。
- 支持 Provider 导入与模型候选查询，网络错误、部分导入和配置冲突有明确反馈。

## 范围与阶段

1. 只读目录：三类 Provider、卡片摘要、当前 Provider、Home 与当前全局配置状态；不读取或展示密钥明文，不写数据库或用户配置文件。
2. 目录管理：创建、编辑、复制、排序、启停、删除 Provider；配置文档使用原生编辑器，秘密值遮罩并保留未知/既有秘密。
3. 密钥与公共配置：增删改、启停、激活、揭示/复制密钥及 Claude/Codex/Grok 公共配置。敏感操作不得写日志或进入错误文本。
4. 全局切换与路由：预览指纹、确认后应用、Home 选择、全局代理、路由接管、Rectifier 与故障转移；与 daemon 事件及恢复 journal 协作。
5. 快速切换、导入与模型候选：命令面板动作、外部 Provider 导入预览/提交/冲突处理、模型异步查询和缓存。

## 约束

- 遵循父任务 `.trellis/tasks/10-30-gpui-native-migration` 与 Settings Panels 任务的 GPUI、Core、Repository、偏好和 UI 约定。
- Tauri 命令名、参数/返回契约、SQLite 数据、文件格式、错误语义与运行行为保持兼容；禁止复制一套 Provider 状态或另建不兼容数据库。
- 领域代码必须逐步进入无 Tauri 的 `crates/core` / `core-db`；GPUI 不直接依赖 `src-tauri`。
- 秘密采用最小暴露：列表只给遮罩摘要；只有明确用户操作可揭示或复制；常规日志、埋点、错误、缓存不得包含秘密。
- 全局应用写入是高风险操作：必须先预览和确认，校验 fingerprint，沿用锁、journal、原子写入、回滚与恢复规则；不得绕过既有服务实现。
- 首阶段只读交付不能宣称 Provider/路由迁移完成；父功能对齐矩阵须继续标注部分完成，直至所有阶段和平台验收闭环。

## 场景覆盖

- Claude/Codex/Grok；Provider 为空、单个、多个、被禁用、当前项已删除或数据库损坏。
- 数据库存在/缺失、只读/写失败、迁移中、Tauri 与 GPUI 先后使用同一数据。
- Home 为本机、WSL、切换中、不可达；daemon 在线、离线、版本能力不足、状态过期。
- Preview 指纹过期、并发 Apply、写入中途失败、重启恢复 journal；路由与故障转移配置为空/部分损坏。
- 密钥不存在/禁用/切换/揭示/复制；未知配置字段、嵌套秘密与非法 JSON/TOML。
- 窗口失焦、面板关闭重开、快速切换 Provider、重复点击、网络超时与导入冲突。

## 验收标准

- [ ] 每阶段实现都有独立 PRD 勾选、定向测试和迁移进度记录；端到端功能完整后父对齐矩阵才更新。
- [ ] 阶段 1 在 GPUI 中可读取三类 Provider 和当前状态，加载/空/错误/刷新状态明确；真实 SQLite 测试证明只读且不会创建缺失数据库，秘密不进入 UI DTO。
- [ ] 阶段 2–3 所有 CRUD、密钥与公共配置操作和 Tauri 契约一致；秘密遮罩、保留、揭示、复制及错误路径有回归测试。
- [ ] 阶段 4 Preview→确认→Apply、Home/路由/故障转移全流程有成功、过期 fingerprint、并发、部分写入回滚和启动恢复测试；daemon 事件正确更新 UI。
- [ ] 阶段 5 快速切换、导入、模型查询覆盖取消、超时、冲突和失败重试。
- [ ] Tauri 与 GPUI 共用数据库和配置往返验证通过；不增加 schema 或 IPC 不兼容改动。
- [ ] 中文与英文文案完整；GPUI 页面不创建 WebView；`cargo test -p cli-manager-desktop-gpui`、相关 core/core-db 测试和 `npm run check:architecture -- --strict` 通过。
- [ ] Provider 命令/核心符号修改前后执行 GitNexus 影响与 `detect_changes`；CRITICAL 风险在设计和交付记录中逐条回应。

## 风险记录

- GitNexus 对 `provider_global_apply` 下游报告 CRITICAL：47 个受影响符号、5 条执行流，包含 `apply_hot_switch`、代理保存、服务配置和 takeover 保存。结果来自当前索引；本次计划不把该影响解释为可忽略，进入全局切换阶段前必须重新确认调用图并制定边界测试。
- `provider_catalog_list` / `provider_global_apply` 上游结果为 UNKNOWN（无解析调用者）；按要求以源码搜索和命令注册确认实际入口，不视为未使用。
- 当前 Provider 服务直接依赖 Tauri app paths、配置文件、WSL、daemon 和独立 `providers.db`，不存在可供 GPUI 直接复用的中立服务。阶段 1 的准确数据来源和只读 repo 契约必须在设计阶段确认。
