# 验证与交付记录

## 根因

1. Web 设置的网络信任选项被折叠隐藏，Rust 校验错误直接透出英文；服务设置混用运行状态与编辑草稿，保存失败后的 refresh 将地址恢复为旧值。设备设置还存在保存回执覆盖保存期间新编辑的问题。修复落在设置 UI 的配置输入与状态同步边界，保留显式信任校验。
2. Tap 的 Sidebar/NewSession 平铺 projects，未消费快照已提供的 groups、parentId、groupId 和 sortOrder；同名项目缺少辨识上下文。修复落在快照消费层，按原始 ID 组织层级、排序和会话，不改发布协议或数据库。
3. 追加反馈的图标遮挡源于项目行 span 通用文字裁剪和 flex 收缩；已将文字与图标样式分离。原空 collapsed 列表默认全展开，现按活跃终端项目 ID 派生展开路径，并保留手动覆盖值。已覆盖非选中但仍运行的终端、当前查看的已结束会话、没有终端以及异步状态更新。

## 发现清单与影响

- 已修改：WebServerSettingsSection / WebDeviceSettingsSection、共享设置草稿 reducer、网络引导与错误映射、settings 双语字典。
- 已修改：Tap projectTree（含活跃项目展开路径）/ Sidebar / NewSession、配套样式与双语文案；唯一 UI 组合调用者均为各自设置页/App。追加图标/展开修复确认 Web 设置、传输和执行链无关。
- 已核对无需修改：Web server validate_config / save_config / resolve_allowed_origin；Web device new_profile / normalize_device_url / normalize_public_url；桌面 useWebDeviceBridge 快照发布、共享 Web 类型、Tap 协议/useWorkspace、Classic ProjectTree。
- 确认无关：数据库/迁移、Cookie/认证/配对、凭据存储、PTY/CLI 执行、SSH 权限与真实服务进程。
- GitNexus list_repos 返回零仓库；query、四个 UI 符号 impact 和交付时 detect_changes 均失败为 No indexed repositories。使用契约、引用搜索、定向测试和 diff 降级核对，不能声明图索引新鲜或图分析已通过。
- 起始分支 pr-287 无上游，未执行 fetch/pull/push/merge/rebase。起始未跟踪 apps/web-tap/USAGE.md 未读取或修改，不纳入提交。

## 自动化检查

- `node --test src/features/settings/lib/webNetworkSettings.test.mjs scripts/webPairingLifecycle.test.mjs`：10 通过。
- `npm run tap:test`：21 通过，含树模型、层级/排序、同名项目身份、会话/工作树归属、孤儿/循环、搜索、真实组件回调、活跃路径默认展开、无活跃终端折叠、折叠跨设备隔离和双语测试。
- `npx tsc --noEmit`：通过。
- `npm run tap:typecheck`：通过。
- `npm run tap:build`：通过，生产包生成到 apps/web/dist/tap。
- `npm run check:architecture -- --strict`：1396 个源文件，零超长、零违规。
- `git diff --check`：通过。
- 未修改 Rust；不启动无关全量 Rust 检查。

## 浏览器验收

Chrome MCP 缺少 Chrome 可执行文件，改用本机 Edge 无头模式和独立临时 profile，加载生产构建与只读 fixture，未使用真实账号/设备/CLI。

`browser-preview.mjs` 提供本地 fixture；`browser-check.mjs <fixture-url>` 验证并截图：

- 1280×900 桌面：默认仅展开“开发项目”和活跃终端所属 CLI-Manager 项目；手动展开其他分组后完整呈现 3 个分组、5 个项目，同名项目路径、嵌套层级正常，无侧栏横向溢出。
- 深层长路径下逐个测量图标容器与 SVG，均保持完整 15px，文字与图标至少间隔 5px；手机宽度也通过同样的几何断言。
- 搜索 `/home/dev` 可找到没有会话的项目。
- 新建会话选择器同样有 3 个分组。
- 390×844 手机抽屉默认仅展开活跃项目路径，其他节点折叠。
- Edge 与临时 fixture 服务已退出，临时浏览器 profile 已清理。

截图：[桌面默认展开](screenshots/tap-projects-desktop.png)、[手动展开后图标](screenshots/tap-project-icons-expanded.png)、[新建会话](screenshots/tap-project-picker.png)、[手机](screenshots/tap-projects-mobile.png)。

## 实机验收与提交授权

代理未自动启动/重启桌面应用或改变用户配置；中英文错误提示及组件语言切换已由自动化覆盖。本次不涉及时间格式，未打安装包或部署至用户运行目录。2026-10-17 用户明确确认当前修复已经验证，并授权提交、推送到对应 PR。

V1.4.4 CHANGELOG、功能清单及 Web 契约已同步。提交前通过 Git 远程引用核对：本地 HEAD、dark-hxx/CLI-Manager 的 refs/pull/287/head、nnnmdzz/CLI-Manager 的 refs/heads/feat/optional-tap-web 均为 a2ebd1cd7c711c2bef5181ad684b75a23e71c420；本次正常追加提交到该 PR 分支，不强制推送。
阅读模式的左右对话布局仅讨论，未纳入本次实现或提交。apps/web-tap/USAGE.md 与 .trellis/tasks/00-join-hxx/ 是独立用户工作，不纳入。
