# 历史来源删除设计

## 行为边界

七个新增来源采用精确的转录文件删除：删除 CLI-Manager 已读取、已验证且由用户选中的原始记录。现有 Claude/Codex 的文件树、Kimi/Grok 的目录/索引处理及 OpenCode 的 SQLite 事务保持原有分发。

输入继续使用 `history_delete_session` 的既有 source、filePath、projectKey 和路径配置参数，无新 IPC、依赖、数据库迁移或来源扫描协议。

## 数据流

1. 列表/批量入口调用统一删除资格判断，确认目标快照和可执行条目。
2. Store 再次检查远程/只读、快照和来源能力，阻止绕过 UI 的不合法调用。
3. Rust 命令规范化来源，分派到现有专用删除路径或新的文件级删除路径。
4. 新路径复用规范路径、来源候选、项目身份和恢复锁检查；Cline 额外匹配已知合法根集合。
5. 为明确目标集合创建独立备份后删除；失败沿用回滚/人工恢复错误约束。
6. 成功后失效历史派生缓存；Store 沿用 session_meta、生成标题和收藏快照清理，再更新列表/详情/搜索。

## 后端

### 精确目标与共享执行器

- 新增 `src-tauri/src/features/history/deletion.rs`，负责新来源的删除分发与文件级入口，保持 `mod.rs` 命令薄层。
- 从 `conversion.rs` 的现有树删除中提取接受明确路径列表的备份/删除执行器；保留原树删除函数签名和目标收集逻辑，证明旧行为等价。
- 七个新来源向执行器传入单个已验证目标，不调用通用 `collect_subtask_session_file_refs`，不递归删除父目录。
- 文件必须是实际普通文件；格式、来源枚举和项目键必须匹配。目录、数据库文件或伪造的 locator 不得进入文件删除器。
- 不增加“同来源 CLI 只要运行就禁止删除”的进程扫描；保留既有明确删除契约，操作系统拒绝时如实返回错误。

### Cline 多根校验

- 在 `scope.rs` 增加删除专用入口/根集合辅助函数；普通来源仍复用现有单根校验。
- Cline 合法根来自 `resolve_cline_history_roots()`，不接收任意前端指定根，也不把这些根的共同父目录视为可信根。
- 请求路径规范化后必须属于某一个真实合法根，并与 `collect_session_files(Some("cline"), roots)` 返回的来源、实际路径、项目键匹配。
- 根不存在或越界时返回稳定错误，不能降级为任意路径删除。
- 不改变转换/编辑入口的来源能力边界。

### 备份目录唯一性

- 当前快照文件名已按原路径散列，但变更目录名可能因同毫秒/同文件 stem 相同而共享，单文件 manifest 会互相替换。
- 采用独占创建的唯一变更目录（现有 UUID 依赖或等价排他分配），每次快照保有独立 manifest 和原路径。
- 保持旧 manifest 结构、发现方式、清理策略和旧备份可读性；无需迁移已有备份。
- 同名 events/transcript/API 历史的并发或快速备份必须均可独立发现和恢复；测试不依赖真实时钟恰好相撞。

## 前端

- 在历史域新增小型删除资格模块，供 `HistoryListPane`、`HistoryWorkspace` 和 `historyStore` 共用。
- 能力声明显式覆盖十二个当前来源；新来源默认不因复用 reader 模板而自动取得删除权限。
- 资格判断保留远程/只读限制、快照语义及子代理约束。快照删除不能误走原文件删除分支。
- 批量确认使用实际可删除目标；后台执行前统一校验，真实 I/O 失败保留既有中断和部分成功提示。
- 新文件级删除仅从前端移除实际删除的会话；旧来源仍按原语义清理确实被级联删除的子记录，避免删除后刷新出现子会话“复活”。
- 原始错误码仅作分支依据；新增不支持/只读提示通过历史领域 zh-CN/en-US 字典提供。

## 存储范围

具体七来源路径和保留数据见 `research/source-audit.md` 的来源表。该表是本轮删除对象契约：不写第三方共享历史映射/SQLite，不删除整个会话目录或项目目录。删除目标转录后，当前枚举器不会仅靠保留的旁文件重新生成 CLI-Manager 会话。

已有 Kimi/Grok/OpenCode 的专用共享索引/目录/数据库操作不受此新增文件级约束替代。

## 预期修改文件及必要性

| 文件 | 必要改动 |
| --- | --- |
| `src-tauri/src/features/history/mod.rs` | 接入新的来源删除分发 |
| `src-tauri/src/features/history/deletion.rs`（新增） | 文件级删除边界和可测试核心 |
| `src-tauri/src/features/history/conversion.rs` | 提取明确路径集合的删除执行器，保留旧树入口 |
| `src-tauri/src/features/history/scope.rs` | Cline 删除专用多根验证 |
| `src-tauri/src/features/history/backup.rs` | 唯一变更目录和独立快照清单 |
| `src-tauri/src/features/history/tests.rs`、`tests/deletion.rs`（新增） | 注册七来源及边界/回归 fixture |
| `src/shared/lib/historySources.ts` | 修正全部来源删除能力 |
| `src-tauri/src/features/history/sources.rs` | 同步后端公开能力表的十二来源 delete 状态及回归 |
| `src/features/history/lib/historyDeletion.ts`（新增） | 共用资格和文件级/级联结果策略 |
| `src/features/history/store/historyStore.ts` | IPC 前资格、成功后的实际目标清理 |
| `src/features/history/api/HistoryWorkspace.tsx` | 单条/批量确认与错误提示 |
| `src/features/history/components/HistoryListPane.tsx` | 删除可用态和提示 |
| `src/shared/i18n/messages/history.zh-CN.ts`、`history.en-US.ts` | 对应可见文案 |
| `scripts/historyDeletion.test.mjs`（新增）及直接相关回归脚本 | 资格、批量和状态测试 |
| 历史契约、`CHANGELOG.md`、`docs/功能清单.md` | 固化删除对象/新能力及 V1.4.2 交付记录 |

`historyStore.ts` 基线 1849 行，应把可独立测试的资格与结果策略放到历史域模块，不能压行或扩大架构豁免。

## 风险与兼容

- GitNexus 风险返回 UNKNOWN，已用契约与源码定位影响；不能据此声称没有上游调用。
- 备份改动的直接上游包括已有删除和消息编辑；需测试旧备份发现及已有来源，不仅测新七个来源。
- Windows 共享文件占用/权限失败应保留真实错误与源数据，测试 fixture 不触碰用户真实历史。
- 删除范围为当前读取的转录，第三方原生客户端的其他缓存/索引不是本次清理承诺。
- 不停止正在运行的源 CLI；其后续重新写入属于外部写入，不能由本地列表隐藏假装删除成功。
- 不更改 SSH、WSL 扫描范围、消息编辑、星标/审计留存、版本配置或发布流程。

## 回滚

代码变更不含数据库迁移；可按文件回退到旧分发，已写出的独立备份继续被原有 manifest 发现逻辑读取。测试或手动验收时的回滚只操作测试数据；不得自动还原/覆盖用户真实会话。
