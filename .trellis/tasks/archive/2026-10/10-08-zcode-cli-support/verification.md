# ZCode CLI 类别验证

2026-10-08，按用户最终确认的“仅增加 CLI 类别”范围实施。

## Changes

- `src/shared/lib/cliTools.ts` 新增 ZCode 描述和图标 key；默认命令 `zcode`、厂商 `zhipu`，未声明历史或图片粘贴能力。
- `src/shared/ui/CliToolIcon.tsx` 使用已有依赖的 Zhipu 图标。
- 项目下拉列表复用此前的统一定义派生规则，ZCode 自动出现在末尾；前五项顺序及四项隐藏规则保留。
- V1.4.2 CHANGELOG 和项目功能清单已更新。
- 没有新增专用解析器、恢复策略、后端或依赖；此前研究中 HIGH 风险的共享函数未修改。

## Automated evidence

- `node --test scripts/deepseekTui.test.mjs scripts/agentTerminal.test.mjs`：16 passed，0 failed。
- `npx tsc --noEmit`：通过。
- `npm run check:architecture -- --strict`：1281 个源文件，0 个超过 2000 行，0 违规。
- `git diff --check`：通过；Git 提示本地文本将按既有配置转换 CRLF，无空白错误。
- GitNexus `detect_changes(scope=all)` 提交前检查：LOW；结合实际 diff 核对，业务改动仅涉及 CLI 预设列表、描述及图标映射。
- 一次性 Node 检查直接打包并调用生产模块，未新增测试文件：唯一 ZCode 描述、CLI 命令表、项目／标签图标识别、未开放的历史／图片能力、默认命令、五种 Shell 下的字面参数拼接、自定义 Node 启动命令保留、Agent metadata、实际 SVG 渲染均通过。
- 从 ConfigModal 的实际常量求值，最终列表为 `claude, codex, pi, grok, dsh-tui, opencode, kimi, qwen, gemini, copilot, cline, zcode`。

## Validation limits

用户明确本机没有安装 ZCode，因此没有运行真实 ZCode、桌面新建／编辑／语言切换或 WSL/SSH 端到端验收。Shell 参数检查验证的是管理器命令拼接，并非五种 Shell 的真实 ZCode 运行。品牌名在两种语言中均使用同一 `ZCode` 常量。

用户后续安装官方 CLI 后，可新建／编辑项目选择 ZCode，在内置终端验证启动与交互。原生会话恢复、历史、统计、Hook、MCP/Skills 等仍为后续独立需求。

## Delivery

任务按本轮缩小后的类别接入范围完成；真实 CLI 运行不计作已通过。用户已明确授权提交代码并推送至 PR #273，目标为 `jackie-cqz/CLI-Manager` 的 `fix/deepseek-harness-webui` 分支。提交与推送结果以 Git 记录和会话交付记录为准。
