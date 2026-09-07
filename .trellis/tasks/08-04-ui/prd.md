# 原生供应商大屏详情与全局切换 UI 调整

CHANGELOG Target: `[TEMP]`

## Goal

修复原生供应商目录在大屏下的空间浪费、详情信息层级混乱和全局供应商入口不可见问题，并使 Codex 与 Grok Build 的供应商维护体验保持一致。

## Confirmed facts

- 当前 `NativeProviderSettingsPage` 将 `供应商目录 / CLI Home`、CLI 类型 Tab、通用配置和目录/详情主从区放在同一页面流中。
- 目录/详情网格使用固定的 `lg:h-[min(68vh,760px)]` 高度；在大屏截图中主内容结束后仍有明显空白。
- `NativeProviderEditor`、`NativeProviderKeySection`、`NativeProviderDocumentEditor` 当前连续堆叠，详情区同时展示基本信息、生效配置预览、Key 和完整文档，信息层级拥挤且长内容不完整可见。
- 全局供应商应用能力已经存在于 `NativeProviderHomeSection` / `NativeProviderGlobalSection`，但当前入口位于 CLI Home surface，供应商目录主视图没有明显的“设置为全局”操作。
- `NativeProviderFormModal` 已按 app type 复用表单，Claude 有独立 API 格式、认证字段、完整 URL、模型映射和 1M 配置；Codex/Grok 仍复用普通基础字段和完整文档编辑器。
- 用户提供的 CCS Codex 维护截图要求 Codex 与 Grok Build 共享同一类维护结构：供应商名称、官网、API Key、请求地址/完整 URL、默认模型、高级选项、模型映射、User-Agent、请求覆盖和完整 auth/config 文档。

## Requirements

### UI-01 大屏空间利用

- 目录/详情主工作区在大屏下应使用可用窗口高度，避免固定短高度导致底部大片空白。
- 目录与详情仍保持边界明确、各自滚动；不能通过无限增高供应商列表解决空白问题。
- 1024px、1440px 及更大窗口均不能产生横向溢出或把关键操作推出可视区。

### UI-02 详情信息分层

- 供应商详情改为清晰的多 Tab/分区查看结构，至少覆盖：基本信息、生效配置、API 密钥、完整配置文档。
- 默认 Tab 必须能看到供应商名称、启用状态、API 基础/请求 URL、模型、API 格式和当前 Key；切换 Tab 后保留当前供应商选择。
- 生效配置预览、字段来源和长 JSON/TOML 文档必须在各自滚动容器中完整可查看，不得把多个大块内容强行压在同一首屏。
- 空选择、加载、错误和无文档状态仍需有明确内容，不显示空白异常卡片。

### UI-03 全局供应商入口

- 在供应商目录主视图提供清晰的“设为全局/应用全局”入口，操作前后状态可见。
- 入口必须复用现有 global preview/apply/confirm/recovery 语义，不复制写入逻辑，不绕过 Home、锁、指纹、补偿和 journal 保护。
- 当前全局供应商、当前 Key、目标文件状态和应用结果必须在详情或全局 Tab 中可见。

### UI-04 Codex/Grok Build 维护一致性

- Codex 与 Grok Build 复用同一维护页面层级和交互结构；类型差异仅体现在命令名、目标路径、格式和后端字段。
- 两类供应商均应可编辑基础连接信息、Key、默认模型、完整 TOML 配置和相关 JSON 文档；保留未知字段 round-trip。
- 不改变 Claude 专属 API 格式/认证字段/模型映射规则。

### UI-05 国际化与无障碍

- 新增按钮、Tab、状态、空态、ARIA 文案同步 `zh-CN`/`en-US`。
- Tab、全局操作、详情滚动和文档编辑器支持键盘访问、焦点可见和正确 ARIA 状态。

## Acceptance Criteria

- [ ] 大屏截图不再出现主内容结束后的大块空白；目录/详情高度随窗口可用空间响应式变化。
- [ ] 详情按 Tab 分层，基本信息、生效配置、Key、完整文档均可独立查看，长内容不被截断。
- [ ] 供应商目录或详情存在明确的全局设置入口，并能显示当前全局状态与应用结果。
- [ ] Codex 与 Grok Build 维护结构一致，覆盖 CCS 截图中的核心字段和文档编辑能力。
- [ ] 1024px/1440px/大屏下无关键控件丢失；键盘、ARIA、中英文运行时检查通过。
- [ ] `npx tsc --noEmit`、`cargo fmt --all -- --check`、`cargo check`、`cargo test`、`git diff --check`、i18n parity 和 GitNexus detect_changes compare master 通过。

## Out of scope

- 不新增自动 Key 轮换、健康度、配额、重试或 failover。
- 不替换现有 provider/Home/global 后端写入协议，不新增依赖，不升级框架。
- 不运行 `npm run dev/build`、`npm run tauri dev/build`，除非用户在本轮明确要求。

## Confirmed interaction decision

- 详情固定为“基本信息 → 生效配置 → API 密钥 → 完整配置”四个 Tab，默认打开“基本信息”。
