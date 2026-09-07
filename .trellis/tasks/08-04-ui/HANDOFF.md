# 08-04-ui 交接说明

更新时间：2026-08-04
状态：`in_progress`，Release gate：`BLOCKED`
分支：`feat/native-provider-management`

## 本轮改动

- `NativeProviderSettingsPage`：详情区改为四个本地 Tab，默认“基本信息”；切换供应商或 CLI 类型时回到默认 Tab。
- `NativeProviderEditor`：基本信息与生效配置拆开渲染，生效预览保留独立可滚动区域。
- `NativeProviderGlobalSection`：在供应商目录的基本信息 Tab 直接复用现有全局预览、确认、应用、刷新和错误保护链路。
- `NativeProviderAdvancedConfigSection` / `nativeProviderAdvancedConfig.ts`：Codex/Grok 复用 CCS 风格高级维护项；高级元数据保留在既有 JSON envelope 的 `advanced` 字段，不把未被 CLI 识别的代理字段写入官方 TOML。
- 全局确认框改为显示 app type 对应的 `.claude` / `.codex` / `.grok` 配置目录；应用按钮不再要求用户先点击预览，点击应用时自动获取新预览指纹后继续使用原有安全写入链路。
- `NativeProviderCodeEditor` / `nativeProviderConfigView.ts`：统一 Monaco 编辑器生命周期、JSON/TOML 展示格式和供应商专属配置 envelope 转换；稳定 path/model 避免通用配置折叠恢复时绑定已释放实例。
- `NativeProviderFormModal`：新增/编辑均可维护当前供应商专属 JSON/TOML 配置；Codex/Grok 展示 TOML，后端保存时保留密钥管理区敏感字段。
- `NativeProviderFormModal`：当专属文档为空时，根据基础字段和高级字段生成 Claude JSON、Codex TOML、Grok TOML；用户手动编辑原始文档后进入 manual 状态，避免覆盖未知字段。
- `provider_global_current`：按 active-key provider plan 与真实目标文件逐项匹配识别当前供应商，再回退 `is_current` 处理漂移/缺 key。
- `NativeProviderEditor`：移除详情区复制按钮；目录卡片仍保留复制入口。
- 主从 grid：使用视口高度计算，目录与详情共享高度，各自保持 `min-h-0` 与滚动边界。
- `nativeProviderDetailView.ts`：集中维护四个详情视图和非法值回退规则；新增 3 个 Node 回归测试。
- `src/lib/i18n.ts`：新增详情 Tab 的 zh-CN/en-US 文案。
- `src/lib/i18n.ts`：新增 Codex/Grok 高级维护项和校验错误的 zh-CN/en-US 文案。

Codex 与 Grok Build 未复制新的独立维护分支，继续复用同一页面/表单/Key/文档组件；Claude 专属 API 格式、认证字段、完整 URL、模型映射和 1M 配置未改动。

## 验证状态

- `npx tsc --noEmit`：PASS。
- `node --test scripts/nativeProvider*.test.mjs`：PASS，13/13；新增空文档生成、高级 envelope round-trip 和非法高级字段校验回归。
- `cargo fmt --all -- --check`：PASS。
- `cargo check`：PASS。
- `cargo test --no-fail-fast --quiet`：PASS，832 passed、0 failed、1 ignored（833 tests）。
- `git diff --check`：PASS；i18n parity：PASS，zh=3467、en=3467、missing_en=0、extra_en=0。
- GitNexus `detect_changes`：最终记录 unstaged changed=137、75 files、0 affected processes、low risk；compare master changed=129、108 files、0 affected processes、low risk。当前索引对部分 TSX/未跟踪符号解析不完整，重复调用的 changed symbol 计数有波动，需人工解读。
- GitNexus：TSX 函数组件未生成可命名符号；接口级直接上游为 LOW，已人工确认 `SettingsModal` 和页面导入关系，无 HIGH/CRITICAL 真实触点。
- WSL：BLOCKED，`wsl.exe --status` exit=50，系统提示需先安装 WSL。
- 真实 Tauri UI、macOS 和运行时语言/键盘/ARIA：BLOCKED，不能以静态检查替代。
- Codex/Grok 高级选项和空配置自动生成已完成静态实现；实际表单编辑、TOML 可读性和保存后重开仍需 Tauri UI 手测。
- 本轮用户反馈的 Monaco、全局识别、按钮布局、TOML 展示、表单专属配置、详情复制按钮、全局确认路径和无需手动预览应用已完成代码修复；上述运行时证据仍未获得。

## 继续工作前

1. 在可用 Windows Tauri 环境按 `acceptance.md` 完成截图和交互验收；WSL 不可用时保持 BLOCKED。
2. 未完成全部 Gate 前不要归档任务、标记完成、提交或推送。
