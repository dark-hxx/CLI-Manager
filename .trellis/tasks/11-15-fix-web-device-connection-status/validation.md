# V1.5.1 Web 设备连接状态验证

## 结果与根因修复

代码修复完成。根因位于后台权威状态查询到 React 设置消费者的同步边界：独立 daemon 连接已成功，但不会发送 Tauri 事件，全局 bridge 的查询结果此前没有传播。

- `webDeviceStatusSource` 只保留最近一份快照，供页面订阅；同一时刻的状态读取共享一次 IPC，较早请求的迟到回执不覆盖已接收的较新快照，相同快照不通知。
- `webDeviceApi.getStatus` 及保存、启动、停止、重启、清除配对回执接入共享来源。现有全局 3 秒查询即为 daemon 到设置页的更新通道。
- `WebDeviceSettingsSection` 先订阅再读取；原生事件触发查询，不直接信任另一个 transport 的载荷。保存回执只按提交 revision 同步 profile，不回退连接徽标。
- Rust transport、现有 IPC 名称/字段、后台生命周期及快速终端/操作轮询均未修改。主/分屏会话、WSL/Worktree 和 Hook 不参与设备级状态判定；浏览器状态、服务端存储、独立 Web 服务监听设置经排查确认无关。
- 已更新 V1.5.1 CHANGELOG、功能清单及 Web 服务契约。mini-trellis session 140 已写入 `.trellis/workspace/hxx/journal-3.md`，关联上述契约；未自动提交。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `node --test src/shared/lib/webDeviceStatus.test.mjs src/shared/lib/webBridgePolling.test.mjs src/features/settings/lib/webNetworkSettings.test.mjs` | 27/27 通过 |
| `npx tsc --noEmit` | 通过 |
| `npx vite build` | 通过，7133 模块，保留现有混合静态/动态导入及大 chunk 提示 |
| 本任务代码与记录的 `git diff --check` | 通过 |
| `npm run check:architecture -- --strict` | 失败；以下两处均已通过 `git show HEAD:<path>` 证实为任务开始前的源码问题 |

严格架构检查的现存失败：

1. `src/features/stats/api/StatsPanel.tsx`：2020 物理行，超过 2000 行。
2. `src/features/settings/components/pages/TerminalStatusBarSettingsPage.tsx`：从另一功能内部 `terminal/lib/terminalStatusBarItems` 导入，违反公共入口边界。

没有添加豁免或扩大本任务范围修改这两处。

测试覆盖：daemon 无原生事件的连接/配对/断开/重连、启停按钮及徽标颜色、中英文状态文案、旧启动/保存/查询响应、重复快照、卸载后的迟到结果、重开快照回放、重叠查询合并、查询错误恢复、真实 IPC 入口接线、未保存草稿、保存期间的新编辑，以及已有全局 bridge 的无重叠与操作唤醒行为。

## GitNexus 与工作区范围

- CLI 1.6.11 精确 context/impact 可用；索引对应 `master` 的 HEAD `3f60be77`，索引时间 2026-11-15 08:09Z。MCP 存储版本不兼容，CLI FTS 不可用，概念查找以领域契约和精确符号查询补充。
- 编辑前影响：设置组件调用方为远程连接页/设置弹窗，LOW；getStatus 的调用链涉及设置刷新及全局 Web bridge，LOW；saveProfile 为设置保存链，LOW。启停/清除配对是裸回调引用，图返回 UNKNOWN，定向文本搜索确认由设备设置页消费，未将零 caller 视为未使用。
- 实现阶段 `detect-changes --scope all` 返回 26 文件、107 符号、26 流程，整体风险 CRITICAL，包含同时进行的 Tap Skill、Codex transcript 等其他未提交任务。该结果不能充当本任务的隔离风险结论或完整提交准入；新增共享来源尚未索引。
- 实现阶段 master 与本地 origin/master 同步，领先/落后 0/0。用户随后授权提交并推送；此时 master 领先 1 个 Windows helper 构建修复提交，落后 0，远程只读查询仍为 `3f60be77`。提交范围限定本修复和对应记录，其他未提交任务保留；推送会包括已存在的 helper 提交。

## 待人工实机验收

依据 `.trellis/spec/frontend/quality-guidelines.md` 的明确要求，代理不启动桌面应用/服务验证运行时 UI。

1. 更新后的桌面程序打开“设置 -> 远程连接”。已有配对且在线的设备应显示绿色“已配对在线”；正常前台查询约 3 秒更新一次，不再永久停在“正在连接”。
2. 点击“断开”应显示“已停止”，连接按钮可用；重新连接、断网后恢复及重启后台后应同步连接状态。未经配对的成功连接仍显示“等待配对”。
3. 设置切页/关闭后重新打开、其他窗口焦点、最小化/托盘恢复后核对状态。最小化时 WebView 定时器可能节流，恢复后使用原有全局查询更新，daemon 连接独立继续运行。
4. 编辑未保存的服务地址/设备名称，再等待状态刷新或执行保存期间继续编辑，确认新输入保留。
5. “设置 -> 通用 -> 界面语言”切换 zh-CN/en-US，核对“已配对在线 / Paired and online”等状态、按钮及配对区域，时间保持 24 小时格式。

尚未更新正在运行的安装版、生成安装包或发布。本记录区分已通过的自动验证与待人工确认的桌面实机行为。

## 用户授权后的提交前复核

- 用户明确授权“提交并推送”。暂存 13 个文件，仅含本任务代码、测试、任务记录及共享文档中的对应段落；Tap Skill/Codex transcript 代码与文档段落留在工作区。
- 当前 GitNexus CLI 索引已更新到 `d84b5820`，时间为 2026-11-15 18:54:46（Asia/Shanghai）；`status` 确认覆盖 1604 文件且内容匹配，新增状态来源及测试现已索引。
- `detect_changes(scope=staged, limit=300)` 的原始结果为 75 符号、8 流程、risk=HIGH，`partial=false`、`truncated=false`，75 个符号完整列出，映射到本任务的 5 个代码/测试文件。HIGH 风险已向用户告知；复核 `WebDeviceSettingsSection`、`webDeviceApi.getStatus` 的 context 及实际来源，8 条流程都在设置组件起点命中。后台状态 authority、连接生命周期和 IPC 契约不变，命令/订阅/异步顺序回归已由前述 27 项测试覆盖。
- 另按要求运行 `detect-changes --scope all --limit 200`，得到 182 符号、29 流程、CRITICAL；其中其他未提交任务未纳入本次提交。
- 暂存的 5 个代码/测试文件逐一与已验证的工作文件比较一致，无后续代码改动；暂存文档选择及 `git diff --cached --check` 通过。两处 HEAD 既有架构违规保持已知限制，不新增豁免。
