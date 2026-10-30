# 实施步骤：设置 / 扩展 / Provider / 同步 / SSH / 提示词 / 统计

> 先读：本目录 `prd.md`、`design.md`；`src/features/{settings,extensions,providers,sync,remote,prompts,stats,agents}`；core-extraction 的 Repository/命令对照表；rich-content-host 的 CodeEditor 与预览数据接口。
> 前置：只读 Git 同步检查；把视图模型纯逻辑移入 core 时先 `impact`。

## 步骤

| # | 步骤 | 验证 | 估时 |
|---|---|---|---|
| 1 | 轮询清单 `research/polling-map.md`；各页面交互对照表 | 评审 | 2 d |
| 2 | 设置框架：SettingsPage/SettingField/导航/搜索 | 单测：字段绑定与未知字段保留 | 1 周 |
| 3 | 常规/外观/侧栏/快捷键/命令建议/模板/历史来源/第三方通知/开发者/关于/赞助 | 与 Tauri 版逐项对照 | 2 周 |
| 4 | Hook 与 Statusline 页 | Hook 装/卸三种 CLI；Statusline 预览 | 1 周 |
| 5 | 模型定价、同步页（含冲突对话框） | 构造冲突验证不静默覆盖 | 1 周 |
| 6 | SSH/远程页（主机、分组、导入、Agent 安装进度、CLI 集成） | 真实 SSH 主机手测 | 1.5 周 |
| 7 | Provider：视图模型纯逻辑移 core（附测试）→ 列表/编辑/Key/路由/故障转移/代理/导入/模型候选/快速切换 | 路由事件驱动；Key 不入日志 | 3 周 |
| 8 | 扩展：MCP/Skills 列表、排序、编辑器（表单 ↔ JSON）、导入、GitHub Skill | 与 Tauri 版配置文件结果一致 | 2 周 |
| 9 | 提示词/模板 | 三级作用域 | 0.5 周 |
| 10 | `ui_kit::chart` 与热力图；统计各视图；请求日志虚拟表格；实时统计 | 30 天数据流畅；P1 事件驱动 | 3 周 |
| 11 | Web 服务/设备设置 UI（二维码、状态）——依赖 desktop-integration 的接口，先用 trait 占位 | 手测 | 0.5 周 |
| 12 | 统计截图离屏导出（或隐藏按钮并记录） | 手测 | 2 d |
| 13 | P1 验收：polling-map 每条落实；最小化后无面板定时器运行 | Process Explorer / 日志 | 2 d |
| 14 | 双壳往返：Tauri 改设置 → GPUI 读取 → GPUI 改 → Tauri 读取（含未知字段） | 记录 | 1 d |
| 15 | spec：`.trellis/spec/frontend/gpui-settings-contracts.md`（SettingField 规则、写回与未知字段、事件驱动约定、chart 组件 API）；CHANGELOG | — | 1 d |

总估时约 16–18 人周（可按 设置/Provider+扩展/统计 三人并行）。

## 验证命令

```bash
cargo test --workspace
cd src-tauri && cargo test
npx tsc --noEmit
cargo run -p cli-manager-desktop-gpui
```

## 回退
各页面独立提交；双轨期允许 GPUI 版暂缺低频页面（开发者、赞助），但 Hook、Provider、同步、SSH、主题、快捷键、常规为必须项。
