# 08-04-ui 验收记录

更新时间：2026-08-04
任务状态：`in_progress`
发布版本：`[TEMP]`

## 验收结论

当前代码级检查已通过，但真实 Tauri UI、WSL、macOS 和运行时中英文/键盘验收仍需人工环境完成，因此本任务暂不能标记完成，Release gate：`BLOCKED`。

## 本轮缺陷根因与影响触点

- 根因 1：后端 `build_targets` 已将 Home 派生为 `.claude` / `.codex` / `.grok`，但确认框读取了 `preview.home.homePath`，把父 Home 目录误显示成写入目标。影响触点是 `NativeProviderGlobalSection` 的确认文案，不影响实际计划路径；修复改为按 `preview.appType` 读取对应 `targets.*ConfigDir`，并补充三类 CLI 路径回归。
- 根因 2：前端把 `state.preview` 同时当作“展示预览”和“允许应用”的前置状态，导致未手动点击 Preview 时 Apply 永远禁用。影响触点是 `NativeProviderGlobalSection`、`useNativeProviderHome.previewGlobal/applyGlobal` 及 catalog/Home 两个入口；修复在 Apply 时自动生成新预览和指纹，后端仍执行锁、冲突、分阶段写入、验证、补偿和 journal。
- 场景复核：Claude/Codex/Grok Build 均选择各自配置根目录；已有预览与无预览均可应用；Home 草稿未保存时仍禁止应用；本地与 WSL 共用同一派生路径规则，WSL 真实写入继续 BLOCKED。

## Gate 记录

| Gate | 状态 | 证据/阻塞原因 |
| --- | --- | --- |
| UI-01 大屏空间利用 | PASS（静态） / BLOCKED（运行时） | 主从区使用 `lg:h-[calc(100vh-24rem)]`，列表与详情共享同一 grid 高度且各自保留滚动；1024/1440/真实大屏截图仍需手测。 |
| UI-02 详情分层 | PASS（静态） / BLOCKED（运行时） | 详情固定为“基本信息 → 生效配置 → API 密钥 → 完整配置”，默认 basic；生效 JSON/TOML 与完整文档使用稳定 Monaco 编辑器/滚动容器，文档 Tab 使用 `keepMounted` 保留草稿；真实切换和长文档显示仍需手测。 |
| UI-03 全局供应商入口 | PASS（静态） / BLOCKED（真实写入） | 基本信息 Tab 复用 `NativeProviderGlobalSection`；确认框显示 Claude/Codex/Grok 对应配置目录；应用按钮无须先手动预览，会在应用时自动生成新指纹，后端仍保留锁、冲突、补偿和 journal 保护；`provider_global_current` 先按所有目标文件与 active-key 计划精确匹配，再回退数据库 current 标记。真实 Home 写入、补偿、journal、外部修改保护需在 Tauri/WSL 环境验证。 |
| UI-04 Codex/Grok 一致维护 | PASS（静态） / BLOCKED（运行时） | 两类 app type 复用同一页面、详情 Tab、Key 区、文档编辑器和新增/编辑专属配置编辑器；内部 JSON envelope 的 `config` 在界面显示为 TOML，后端更新保留密钥管理区敏感字段；真实 auth/config TOML round-trip 需手测。 |
| UI-05 国际化与无障碍 | PASS（静态） / BLOCKED（运行时） | 新增 Tab、配置编辑器、状态文案已同步 zh-CN/en-US，Monaco/Tabs 使用可访问名称；语言切换、焦点、方向键、ARIA 读屏仍需人工验证。 |
| Claude 专属字段回归 | PASS（静态） / BLOCKED（运行时） | 未修改 `NativeClaudeConfigSection`，API 格式/认证字段/完整 URL/五类模型映射/1M 逻辑保持原路径；需人工确认下拉和标记展示。 |

## 已执行检查

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | PASS，退出码 0 |
| `node --test scripts/nativeProvider*.test.mjs` | PASS，13/13；包含详情视图、导入引用、JSON/TOML 配置 envelope、敏感字段显示、空配置生成、高级 envelope round-trip、非法高级字段校验和全局配置目录路径回归 |
| GitNexus upstream impact | PASS（函数符号未命名返回 UNKNOWN；接口直接上游实际 LOW，已人工复核） |
| `cargo fmt --all -- --check` | PASS，退出码 0 |
| `cargo check` | PASS，退出码 0 |
| `cargo test --no-fail-fast --quiet` | PASS，832 passed、0 failed、1 ignored（833 tests） |
| `git diff --check` | PASS，退出码 0；仅有既有 LF/CRLF 转换警告 |
| i18n parity | PASS，zh=3467、en=3467、missing_en=0、extra_en=0 |
| GitNexus `detect_changes` | PASS，最终记录 unstaged changed=137、files=75、affected=0、risk=low；compare master changed=129、files=108、affected=0、risk=low。当前索引对部分 TSX/未跟踪符号解析不完整，重复调用的 changed symbol 计数有波动，按 affected processes 与人工触点复核。 |
| WSL 探测 | BLOCKED，`wsl.exe --status` 返回 exit=50，系统提示需先安装 WSL |

## UI-09/10：Codex/Grok 高级维护与空配置生成（2026-08-04）

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| Codex/Grok 高级选项 | PASS（静态） / BLOCKED（运行时） | 新增共享 `NativeProviderAdvancedConfigSection`，提供上游格式、模型映射、User-Agent、Header/Body JSON 覆盖、Goal mode 和远程压缩；新增文案已同步双语。 |
| 供应商配置自动生成 | PASS（静态） / BLOCKED（运行时） | 空的 Claude/Codex/Grok 专属文档按基本字段生成 JSON/TOML；用户手动编辑非空原始文档后不再被高级字段覆盖。Node 回归覆盖 Codex/Grok TOML 生成。 |
| 高级字段校验 | PASS（静态） / BLOCKED（运行时） | Header/Body 必须为 JSON 对象，模型映射必须有 source/target；保存前阻止非法配置，密钥仍由密钥管理区负责。 |

### UI-09/10 缺陷根因与影响触点

- 根因：新增/编辑表单只维护基础字段和原始文档，没有 CCS 风格的 Codex/Grok 高级字段；当 provider 的 `settingsConfig` 为空或缺少有效嵌套 `config` 时，编辑器只能显示空文档。影响触点是表单状态、供应商配置 envelope、JSON/TOML 展示和保存校验。
- 修复：复用既有 envelope，非 Claude 高级字段保存于 `advanced` 元数据；根据 Base URL、模型、wire API 和 Claude 模型映射生成 CLI 可识别的 Claude JSON、Codex TOML、Grok TOML。非空原始文档视为用户草稿，保留未知字段，不静默覆盖。
- GitNexus upstream impact：`NativeProviderFormModal`、`providerConfigDocumentFromSettings`、`settingsConfigFromProviderDocument` 在当前索引中均为 `UNKNOWN/not found`，无 HIGH/CRITICAL 结果；已人工复核设置页→表单→catalog update→repository merge/envelope→materializer 触点。
- 回归：`node --test scripts/nativeProvider*.test.mjs` 覆盖空文档 CLI-specific 生成和 `advanced` envelope round-trip。

## 必须人工完成的项目

- Windows Tauri UI：1024/1440/大屏、列表/详情同高、无横向溢出、四个 Tab 切换、长 JSON/TOML、文档草稿保留。
- 键盘、焦点、ARIA、zh-CN/en-US 切换，以及英文界面的 24 小时制。
- Home/WSL/Hook/History、global/project/Worktree/SSH/session snapshot、CCS 导入和修复引用。
- 三个 global writer 的真实写入、补偿、journal、外部修改保护和 recovery。
- macOS 窗口控件/运行时兼容性。
