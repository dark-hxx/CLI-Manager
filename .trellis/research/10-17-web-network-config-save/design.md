# 设计与发现清单

## 调用链与影响范围

GitNexus list_repos 返回空，query 与 impact 均报 No indexed repositories；索引不可用，不能声明索引新鲜。按 fix-triage-guide 降级为 web-service-contracts.md + 精确引用搜索。

- [x] CcConnectSettingsPage -> WebServerSettingsSection：唯一 UI 直接调用者，影响设置抽屉的 Web 服务配置；局部中风险。
- [x] WebServerSettingsSection 的初次加载、2 秒轮询、web-server-status-changed、run 成功/失败：统一区分运行状态与编辑草稿。
- [x] shared/lib/webServer.ts：核对 IPC 字段，无需改动。
- [x] commands/web_server.rs save_config -> validate_config -> resolve_allowed_origin：错误来源、Origin 推导与持久化前校验符合契约，无需修改安全策略。
- [x] apps/server/src/config.rs：独立服务同样要求显式信任，确认无关，无需改动。
- [x] WebDeviceSettingsSection：用户追加同类故障，纳入信任引导和草稿版本保护；commands/web_device.rs 与 infrastructure/web/device_urls.rs 验证显式信任，后端不变。
- [x] 双语 settings 字典、Web 服务契约与版本/功能文档：补充本次行为。
- [x] 认证、Cookie、配对、凭据、数据库、Classic 客户端与 PTY：确认无关。

## Tap 列表追加诊断

根因在 Tap 工作区快照消费层：Sidebar 和 NewSession 直接平铺 projects，忽略 groups、groupId、parentId 与 sortOrder，搜索还丢弃无会话项目。同名条目缺乏路径信息，造成列表解析异常的观感。

- [x] useWebDeviceBridge 工作区发布：已有完整分组、归属与排序，确认无需改动。
- [x] shared/types/webBrowser.ts、protocol.ts、useWorkspace.ts：已有完整快照，确认无需协议或状态传输变更。
- [x] Sidebar、Settings.NewSession：App 是两者唯一直接调用者，影响桌面侧栏/手机抽屉/新建会话选择，局部中风险；GitNexus impact 均因无索引失败。
- [x] Classic ProjectTree：核对混合分组/项目 sortOrder 语义，不跨客户端导入 UI，也不修改 Classic 行为。
- [x] Tap 独立纯 projectTree 模型恢复分组层级；同名项保留 ID，以 cwd 提供辨识；孤儿归根、循环断边，保证项目不丢失也不重复。
- [x] Worktree 启动/会话、SSH/离线禁用与权限：沿用现有已注册 ID，确认不修改执行链。

补充验证：纯树模型与搜索边界测试、真实 Sidebar/NewSession 渲染与点击目标回归、Tap 类型与生产构建；不触碰用户 live 服务。

## 侧栏图标与默认展开追加修复

根因：`.tap-folder-toggle > span` 的通用文字裁剪作用到了 AgentIcon 的 span，图标还参与 flex 收缩；原 collapsed 空列表将全部节点视为展开。
文字改用独立类选择器和弹性宽度，箭头/图标/计数不参与收缩。依据非结束终端及当前查看会话的项目 ID 计算默认展开路径，以账号/设备隔离的显式覆盖值保存手动选择；搜索只临时展开结果，不改覆盖值。
触点：Sidebar、projectTree 展开路径 helper、panels.css、定向测试和浏览器 fixture；其余 Web 设置/协议/会话执行确认无关。GitNexus impact 仍无索引；App 唯一组合入口，中风险状态行为变更。
覆盖多活跃项目、无活跃终端、异步快照/终端结束、嵌套组、同名项目、手动折叠、搜索清空、设备切换和桌面/手机长文本图标尺寸。

## 实现选择

使用设置域纯 reducer 管理 status 与 draft，status 更新仅初始化无编辑草稿；成功保存以提交时 revision 同步，保护异步期间的新编辑。失败仅更新运行状态。网络地址分类只驱动界面提示，保存仍交由后端校验，不在前端推断私有网段可信。

网络提示在折叠区外可见，选择非回环网卡时展开高级设置；后端相关错误映射到翻译键并展开高级区。保持现有 IPC 字符串兼容，无 Rust/API 变更。所有网络信任开关仍由显式用户操作改变。

## 验证

Node 定向测试执行真实 reducer 与网络提示/错误映射，覆盖失败后刷新、事件、迟到保存、地址与 HTTPS/HTTP 场景。运行 TypeScript、独立严格架构检查与 diff 检查。桌面实机语言切换遵循仓库不自动启动应用规则，报告未执行的手工项。
