# ZCode CLI 类别接入设计

## Scope

按用户最新要求，只增加 CLI 类别。此前研究中的专用 TUI 识别和恢复策略留作后续；本轮不修改终端生命周期。

## Changes

1. `src/shared/lib/cliTools.ts`：扩展 `CliToolIconKey`，在统一描述表末尾新增 `id/command/icon = zcode`、`label = ZCode`、`vendor = zhipu`、`imagePasteMode = unsupported`，不设置 `historySourceId`。
2. `src/shared/ui/CliToolIcon.tsx`：直接导入现有依赖的 `Zhipu/components/Color` 并在显式映射中增加 `zcode`。
3. `ConfigModal` 已按统一表派生选项，新增工具自动进入末尾；保留此前五项优先／四项隐藏配置，不另复制列表。
4. 现有 `resolveProjectStartupCommand`、终端创建和 Worktree 路径传递原样复用；品牌注册不启用新的 Provider、恢复或历史能力。
5. 变更记录写入 `CHANGELOG.md` 的 V1.4.2 和 `docs/功能清单.md` 的项目管理板块。

## Evidence and impact

注册常量 `CLI_TOOL_DESCRIPTORS`、`CLI_TOOL_ICONS` 的 GitNexus impact 均为 LOW、没有被索引的直接调用方；实际消费路径已核对为项目选择、标签和图标。此前 HIGH 风险的 `detectCliResumeKind` 已移出本轮改动范围。

仅新增品牌名，无新增可翻译的说明文案；中英文共用同一项。保留现有项目元数据和自定义命令。不新增依赖、数据库、IPC 或持久化字段。

## Validation boundary

通过现有函数检查工具识别、候选排序、命令参数和元数据，再执行类型、现有相关回归与严格架构检查。用户未安装 ZCode，本轮不宣称真实 TUI、会话恢复或远端兼容已经验证。
