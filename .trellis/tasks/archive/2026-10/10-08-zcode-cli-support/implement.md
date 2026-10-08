# ZCode CLI 类别接入实施计划

## Authorization

- [x] 完成并报告只读分支／上游检查；保留此前三处修改。
- [x] 创建任务、核对官方入口，编写并展示原首期计划。
- [x] 用户批准直接实施并将范围明确为增加 CLI 类别；确认本机未安装 ZCode。
- [x] 按最新范围重写 PRD／设计／本计划。
- [x] 激活任务。

## Implementation

- [x] 统一工具类型和描述表增加 ZCode，复用现有 Zhipu 图标。
- [x] 验证配置弹窗自动纳入 ZCode，保持此前优先顺序和隐藏项。
- [x] 更新 V1.4.2 CHANGELOG 和项目功能清单。
- [x] 运行现有定向回归、类型检查和严格架构检查；复核 diff。
- [x] 记录没有真实 ZCode 运行验证，完成任务交付。

## Checks

```powershell
node --test scripts/deepseekTui.test.mjs scripts/agentTerminal.test.mjs
npx tsc --noEmit
npm run check:architecture -- --strict
git diff --check
```

对静态描述项不新增镜像实现的测试文件；使用一次性断言检查统一表、候选顺序、图标键与原有启动拼接。没有后端修改，不执行 Cargo 全量检查。没有新增用户提示文案，不触发文案翻译修改。

后续不使用异步提问。用户授权后立即实施，不再请求任务／版本确认。2026-10-08 用户明确要求提交代码并推送至 PR #273。
