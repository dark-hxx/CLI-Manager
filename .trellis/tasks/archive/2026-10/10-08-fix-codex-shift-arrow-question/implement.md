# Implementation Plan

## 开始门禁

- [x] 只读 Git 检查已报告：master 与本地 origin/master 同步，初始工作区干净。
- [x] 用户同意建任务，版本 V1.4.2，问题只在普通对话中提出。
- [x] 根因分诊、全局冲突复现、发现清单和场景矩阵完成。
- [x] 相关前端架构、注释、输入选区、跨层及跨平台规则已读。
- [x] PRD 收敛，design / implement 准备，影响分析 CRITICAL 已报告。
- [x] 展示最终方案并取得后续明确批准（用户：“可以 开始实施”）。
- [x] task.py start；按 trellis-before-dev 确认最终范围；实施前再次检查 master 与本地 origin/master 同步（0/0）。

## 执行顺序

1. [x] 扩展真实回调定向测试，修复前 43 项中 18 项失败，命中全局默认取消/动作优先级错误。
2. [x] 在 useKeyboardShortcuts 捕获入口落实终端优先级并添加必要注释。
3. [x] 定向测试 65/65 通过：Codex / shell、左右箭头、单/多会话、终端外、Alt/Ctrl、复合修饰键和关闭终端。
4. [x] 更新 settings zh-CN/en-US 的既有说明和 Shift 选项标签。
5. [x] 隔离 Edge 的真实 xterm + 全局捕获实验 20/20 通过，确认终端内不切 Tab 且 Shift 序列发送一次；未启动应用服务。
6. [x] 更新输入选区契约、CHANGELOG V1.4.2 和功能清单。

## 验证

- `node --test scripts/codexQueuedQuestionShortcut.test.mjs scripts/terminalNewlineShortcut.test.mjs scripts/codexManualInput.test.mjs`
- `npx tsc --noEmit`
- `npm run check:architecture -- --strict`（独立运行）
- `git diff --check`
- 修改范围审阅与 GitNexus detect_changes 已在提交前执行；用户确认测试成功并授权提交，不自动同步。

## 人工验收

- Tab 切换设为 Shift：Codex 有提问时，空输入/草稿下 Shift+Left 打开入口且不切 Tab；检查 Shift+Right。
- 多 Tab、分屏和 Workspan 切换后，按键只作用于有焦点的终端。
- 普通 shell Shift 选区正常；改为 Alt/Ctrl 后终端内切 Tab 正常；终端外 Shift 保持原规则。
- 切换 zh-CN/en-US，检查说明和 Shift 标签；时间继续使用 24 小时制。

## 交付

- [x] 记录真实测试结果与未执行的原生验收项，见 verification.md。
- [x] 实现、契约及两份版本记录一致；类型、严格架构及 diff 检查通过。
- [x] 保留其他 checkout 和运行实例，不自动安装或重启。
- 无迁移；回滚入口条件和文案即可。
- 用户确认“测试修复成功，可以提交”，快捷键修复提交为 `b7eb8008`；按 finish-work 归档当前任务并记录日志。
- 同轮用户追加的菜单图标重复问题按独立最小修复处理，提交为 `1f7b5020`；仅替换项目/Worktree 两处扩展图标并更新 V1.4.2 记录，类型及严格架构检查通过。
