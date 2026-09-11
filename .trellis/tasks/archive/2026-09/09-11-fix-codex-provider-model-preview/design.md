# Design

## Evidence and root causes

- NativeProviderAdvancedConfigSection.tsx:122 使用包含 mapping.source 的 key，输入变化使整行重建。修复行身份，不能使用自动 focus 补偿。
- NativeProviderFormModal.tsx:627 手动 TOML 编辑仅更新 providerConfig；保存仍传入 values.model。repository/support.rs 的 apply_typed_fields 写 JSON 顶层 model，config_summary 优先 JSON 后回退 TOML。global/materialize.rs:214 将顶层 model 投影到目标 TOML。展示/应用存在不同模型读取路径，须用冲突值测试确认具体分支后修复数据产生层。
- NativeProviderGlobalSection.tsx:97/105/108 直接展示三类指纹；仅移除这些节点，保留 useNativeProviderHome 提交 previewFingerprint 的契约。

## Scope and discovery list

- 映射组件：稳定行身份；新增、删除、输入、获取模型后选择均覆盖。
- 模型链路：NativeProviderFormModal、nativeProviderConfigView、repository/catalog、repository/support、repository/common、global/materialize。确认权威值并在最小边界统一，不重构供应商域。
- 全局展示组件：删除指纹展示，保留预览和应用保护。中文/英文一致。
- 本地/WSL 共用视图；不改环境路径。分屏、Worktree、终端焦点模式、Hook 不拥有表单状态，预计无改动，实施时核对引用。
- 文档与定向回归测试必须更新。

## Scenarios and risks

验证连续输入、粘贴、中间删除、多行映射；模型表单/TOML 修改、两者冲突、abc/sdf、公共继承开关、旧导入、保存重开及预览/写入对照；全局新建/更新/无变化与快照过期。

主要风险是旧记录双模型字段的优先级。测试先锁定复现再修复；保留未知字段和敏感字段处理，无迁移，回滚仅撤销本任务补丁。

GitNexus 查询因 FTS 缺失退化为空，索引路径仍为迁移前目录，使用当前源码核对影响范围。impact 已执行：映射/全局展示与 advanced 配置转换 LOW，materialize_codex_config MEDIUM（5 个直接调用者），get_provider HIGH（8 个直接调用者），HIGH 已向用户报告。

## Final implementation and discovery closeout

- 根因：映射行 key 随 source 改变；生效详情只合并 TOML，没有执行全局写入的显式模型投影，UI 的字段来源会先读到旧 config。
- 已改：AdvancedConfigSection 与 nativeProviderAdvancedConfig 为行生成仅存在于表单的 rowId，保存时去除；编辑/删除保留其他行 ID。
- 已改：global/materialize 将现有赋值抽为 project_codex_model，逻辑保持；repository/documents 在生效视图复用此规则，catalog 在返回/脱敏前接入。原始 settingsConfig 和 documents 保持原样。
- 已改：GlobalSection 移除三个指纹展示节点，preview/apply 对象与回调保持。
- 确认无需改：FormModal、ConfigView、Editor、support 的摘要读取、common 合并均保持；修正上游 effectiveSettingsConfig 同时修复预览和字段来源。
- 确认无需改：models.rs 使用卡片/密钥而非此生效模型；daemon/route_http 仅 Claude Bedrock 检查使用 effectiveSettingsConfig，Codex 路由仍取原有数据。
- 确认无需改：scope、Home/WSL 路径、Worktree、Hook、分屏和终端焦点模式。此次不更改真实写入优先级，不触发应用。
- 回归覆盖：稳定 key、连续输入/中间删除/新增删行、rowId 不落盘、全局原始快照传递、有效模型展示/字段来源、Rust 预览与 materialize 对照及继承/无效配置兼容。
