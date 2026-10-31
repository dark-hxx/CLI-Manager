# 实施步骤

## 阶段 1：只读目录与契约

- [ ] 对照 `providers.db` 初始化/迁移入口，梳理 Provider 与 key/card 聚合查询，确认读写池、缺库行为和旧库兼容。
- [ ] 对照 `provider_home_get`、`provider_global_current`、Home resolver 与 daemon routing 状态，区分文件事实、DB 事实及运行态事实。
- [ ] 新增脱敏只读 Repository/DTO；真实 SQLite 测试锁定排序、启停/当前态、缺失与损坏处理，并断言返回值不含秘密/原始配置。
- [ ] 新增 GPUI Provider 页面和三类筛选、加载/空/错误/刷新状态；关闭/切换后 generation 校验丢弃过期结果。
- [ ] 双语资源、Provider 入口与功能清单/Changelog 记录。
- [ ] 定向 core-db/GPUI 测试、`cargo check`、严格架构检查；人工确认只读路径不创建数据库、不写配置文件。

## 阶段 2：Provider service 去 Tauri 化

- [ ] 先完成 Providers DB pool 与 `AppPaths`/环境抽象的设计和影响分析。
- [ ] 迁移目录读取、详情脱敏、Home/状态读取所需纯逻辑和 service 到 core/core-db；Tauri 命令改为薄适配，契约快照保持一致。
- [ ] 运行 Tauri 与 GPUI 双侧回归，比较旧库输出、Home 路径、local/WSL 状态。

## 阶段 3：目录管理和配置编辑

- [ ] 迁移 create/update/duplicate/delete/reorder/enable 及文档编辑逻辑，保持事务、校验与既有错误语义。
- [ ] GPUI 接入原生表单/JSON-TOML 编辑器；未知字段、秘密保留和无效输入回滚有测试。

## 阶段 4：密钥与全局 Apply

- [ ] 迁移 Key CRUD/activate/reveal 与 common config，建立遮罩、剪贴板与秘密生命周期测试。
- [ ] 在改 `provider_global_apply` 前重跑 GitNexus upstream/downstream，核对 `apply_hot_switch`、代理、服务配置、takeover、恢复流程；对 HIGH/CRITICAL 风险完成专项 review。
- [ ] 复用 preview fingerprint、确认、apply lock、journal、原子写、回滚和启动恢复；故障注入覆盖每个写入阶段。

## 阶段 5：路由、导入与快捷切换

- [ ] 迁移 daemon routing query/update、故障转移、代理、接管和 Rectifier 状态；验证能力协商、离线与事件刷新。
- [ ] 迁移导入 preview/commit/issues 与模型候选网络查询；覆盖取消、超时、冲突和非法响应。
- [ ] 快速切换动作进入命令面板并复用 preview/confirm/apply。

## 最终验收

- [ ] 全阶段测试与严格架构门禁通过，zh-CN/en-US 手动切换确认新增界面文案。
- [ ] 在 Windows GPUI 真实窗口完成 Provider 分类、刷新、编辑、秘密操作、Apply 与 daemon 状态场景；测试非 GPUI WebView 路径不被创建。
- [ ] Tauri/GPUI 共用 DB 与配置往返一致；无新 schema 或命令兼容回归。
- [ ] 更新父 `functional-alignment.md` 与 `implementation-progress.md`，只勾选有直接证据的项目；运行 GitNexus detect_changes。
