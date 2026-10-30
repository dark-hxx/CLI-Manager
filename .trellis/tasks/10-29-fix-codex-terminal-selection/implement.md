# 实施计划

## 规划与研究

- [x] 只读分支检查：master 与本地 origin/master 记录同步，保留已有删除。
- [x] 创建任务并记录 V1.4.5、SSH 及 macOS 两种反馈。
- [x] 完成修复分诊、代码触点清单及状态场景枚举，记录图谱不可用后的降级证据。
- [x] 真实 xterm 基线 24 个组合 + 1 个候选配置实验通过。
- [x] 用户明确要求修复 macOS 缺陷，已确认按已提交的修饰键选择方案实施。

## 执行顺序

1. 加载 trellis-before-dev，重新检查 task 状态及相关鼠标/组件/注释/质量契约。
2. 修改前对实际符号运行 upstream impact；图谱失败时保留错误并复核精确引用，向用户报告共享终端影响范围。
3. 在 TerminalMouseInteraction 中增加 macOptionClickForcesSelection=true，保持普通 TUI 上报；不修改 SSH/daemon/剪贴板协议。
4. 更新静态测试并扩展真实浏览器鼠标用例：平台、上报模式/编码、normal/alternate、source/restored、无上报直接选择、强制选择文本及零选择字节、普通鼠标/滚轮上报。
5. 检查桌面 UI 是否需要在既有终端提示/帮助入口说明 Windows Shift、macOS Option；仅在需要用户可见文案时同步 zh-CN/en-US，不引入常驻遮挡层或任意新增配置项。
6. 回归搜索开/关时是否建立选区，明确透明高亮独立风险；若需要额外行为修复，先更新设计和确认范围。
7. 修正前端鼠标约定中的跨平台说明及 OSC 契约中的过时 true 描述；更新 CHANGELOG.md 的 V1.4.5 与 docs/功能清单.md 的终端选择/复制条目。
8. 加载 trellis-check，运行定向验证和独立架构检查，记录人工验收缺口；未经明确授权不提交、不推送。

## 验证命令

```powershell
node --test scripts/terminalMouseInteraction.test.mjs scripts/terminalSnapshotMouse.test.mjs scripts/terminalReplay.test.mjs
$env:PLAYWRIGHT_MODULE = Join-Path $HOME '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
node scripts/terminalSnapshotMouse.browser.mjs
npx tsc --noEmit
npm run check:architecture -- --strict
git diff --check
```

若新增独立浏览器选择回归，将其命令加入此清单。若生产修改扩展到 Web/Tap，先确认范围，再运行对应 typecheck 和定向测试；没有 Rust 修改时不启动全量 Cargo 编译。

## 人工验收（当前 Windows 环境不可代替）

- Windows 本地与 SSH Codex：确认现场鼠标模式，开启时 Shift 拖选可见、复制文本正确，无选区 Ctrl+C 仍中断。
- macOS 本地与 SSH Codex：Option 拖选有高亮，Cmd+C 得到文本，普通 TUI 鼠标点击/拖动/滚轮保留。
- 单窗/多窗、分屏、切 Tab/Workspan、恢复/重连、背景开启/关闭，以及无鼠标上报的 shell 直接拖选。
- 如新增提示，手动切换 zh-CN/en-US，确认文字和 24 小时制不回归。

## 回滚点

仅撤销本任务的共享选项及配套测试/文档；不改用户数据与已有其他修改。若强制选择泄漏字节或正常 TUI 鼠标回归，停止交付，回到模式/事件所有权分析，禁止症状处关闭整个鼠标协议。
