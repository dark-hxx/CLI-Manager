# CLI-Manager Web UI/UX 设计文档

> 状态：完整功能设计基线（浅色 / 深色双主题）
> Changelog Target：`[TEMP]`
> 范围：仅 UI/UX 设计，不包含产品代码、接口或数据库实现

## 1. 产品定位

CLI-Manager Web 是桌面端的远程可视化工作台。桌面端继续负责本地 CLI、项目文件、Git、Worktree、Hook 与系统能力，Web 端负责远程操作、结构化对话、过程审计、历史查询和数据分析。

Web 端不复刻终端。原终端工作区改为接近 Codex 桌面端的对话体验：用户看到 Prompt、AI 回复、工具调用、子任务、文件变更、验证结果和审批请求，而不是 ANSI 输出和终端光标。

## 2. 设计目标

1. 用户可以快速确认当前操作的是哪台设备、哪个项目和哪个会话。
2. AI 执行过程可追踪，但不让大量技术日志淹没主要对话。
3. 文件变更、工具调用、审批和错误必须出现在与任务相关的位置。
4. 历史、Replay 和分析沿用桌面端已有数据表达方式。
5. 桌面浏览器保持高信息密度，移动端仍能完成查看、对话和审批。

## 3. 设计原则

### 3.1 对话优先

- 主工作区只呈现对用户有意义的结构化信息。
- 默认展开当前步骤和最终回复，详细输入输出按需展开。
- 工具调用以摘要卡片呈现，不直接倾倒原始 JSON。

### 3.2 上下文始终可见

以下信息必须固定在对话页顶部：

- 当前设备。
- 当前项目与 Worktree。
- Git 分支。
- CLI 来源、模型和推理等级。
- 会话运行状态。

### 3.3 风险操作显式化

- 审批卡片必须显示目标设备、项目、命令或文件。
- 删除、覆盖、恢复、提交、推送等操作使用危险色和二次确认。
- 设备离线时不保留看似可执行的主按钮。

### 3.4 延续桌面端视觉

- 使用现有 `terminal-green` 深色配色。
- 使用 Surface Layering 区分区域，避免密集分割线。
- 使用 Lucide 风格线性图标，不使用 Emoji 作为功能图标。
- 交互反馈只改变颜色、边框和背景，不使用导致布局抖动的缩放动画。

## 4. 信息架构

```text
CLI-Manager Web
├─ 工作台
│  ├─ 新建对话
│  ├─ 当前对话
│  ├─ 实时执行过程
│  └─ 审批与异常
├─ 项目
│  ├─ 项目与分组
│  ├─ Worktree
│  └─ 项目状态
├─ 文件
│  ├─ 文件树
│  ├─ 搜索
│  ├─ 文件预览
│  └─ Diff
├─ Git
│  ├─ 变更与暂存
│  ├─ 分支
│  └─ 提交记录
├─ 历史
│  ├─ 会话记录
│  ├─ AI Replay
│  ├─ 文件变更
│  └─ Prompt Library
├─ 分析
│  ├─ Token 与费用
│  ├─ 项目排行
│  ├─ 模型与来源
│  └─ 活跃趋势
├─ 设备
│  ├─ 在线状态
│  ├─ 系统资源
│  ├─ Hook 状态
│  └─ 同步状态
└─ 设置
   ├─ Web 外观
   ├─ 设备配置
   ├─ 供应商
   ├─ 备份
   └─ 安全
```

## 5. 全局布局

### 5.1 桌面布局

| 区域 | 建议尺寸 | 内容 |
|---|---:|---|
| 顶部栏 | 56px | 品牌、设备选择、同步状态、全局搜索、用户菜单 |
| 一级导航 | 64px | 工作台、项目、文件、Git、历史、分析、设备、设置 |
| 上下文侧栏 | 240–280px | 项目、会话、文件树或筛选项 |
| 主内容区 | 自适应 | 对话、文件、历史详情或图表 |
| 实时过程栏 | 320–380px | Timeline、审批、设备状态 |

### 5.2 响应式规则

- `≥1280px`：完整四区布局。
- `768–1279px`：实时过程栏收进右侧抽屉，上下文侧栏保持可折叠。
- `<768px`：单栏页面，一级导航移至底部；项目和过程使用全屏抽屉。
- Diff、图表和代码只允许组件内部横向滚动，禁止整页横向滚动。

## 6. 核心页面

### 6.1 工作台／对话

设计稿：[SVG 线框稿](./design/web-workbench-desktop.svg) · [Image 2 高保真原型](./design/web-workbench-image2.png)

页面组成：

1. 顶部会话上下文：项目、分支、CLI、模型和运行状态。
2. 用户消息：右对齐、轻强调背景。
3. AI 进展：展示当前动作、耗时和聚合数量。
4. 工具卡片：显示工具类别、目标、状态和摘要。
5. Diff 卡片：显示文件数量、增删行和关键路径。
6. 右侧 Timeline：按顺序展示 Prompt、搜索、工具、文件和验证。
7. 审批卡片：允许一次、本会话允许、拒绝。
8. 固定输入区：附件、Prompt 模板、模型、推理等级和发送/停止。

#### 对话内容层级

| 层级 | 默认行为 |
|---|---|
| 用户 Prompt | 完整展示 |
| 当前进展 | 展示一句摘要和统计标签 |
| 工具调用 | 默认折叠输入输出，仅展示结果摘要 |
| 文件变更 | 展示文件路径、增删行和 Diff 入口 |
| 验证结果 | 成功显示摘要；失败自动展开首个错误 |
| 最终回复 | 完整展示，支持复制与定位相关变更 |

### 6.2 分析看板

设计稿：[SVG 线框稿](./design/web-analytics-desktop.svg) · [Image 2 高保真原型](./design/web-analytics-image2.png)

页面结构：

- 顶部筛选：设备、项目、来源、时间范围。
- 第一行 KPI：会话、消息、Token、费用、在线设备。
- 主图：Token 与费用趋势。
- 构成区：输入、输出、缓存命中和缓存写入。
- 排行区：项目排行、模型构成、来源对比。
- 行为区：活跃热力图、24 小时分布和项目效率。

图表交互：

- Hover 展示精确值。
- 图例支持显隐。
- 点击日期下钻当天会话。
- 点击项目触发项目筛选。
- 图表必须提供键盘焦点和数据表入口。

### 6.3 移动端对话

设计稿：[SVG 线框稿](./design/web-conversation-mobile.svg) · [Image 2 高保真原型](./design/web-conversation-mobile-image2.png)

移动端只保留当前任务的核心路径：

- 顶部设备和项目上下文。
- 对话消息、进展和 Diff。
- 审批卡片。
- 固定输入区。
- 底部导航：工作台、项目、历史、分析、我的。

实时过程从右侧栏改为全屏抽屉，由顶部“过程”按钮打开。

### 6.4 项目、文件与 Git

- 项目页使用项目列表 + 项目概览主从布局。
- 文件页使用文件树 + 预览/编辑区域；窄屏改为两级导航。
- Git 页将“变更”“暂存”“分支”“提交”作为页签。
- 文件与 Git 的危险操作不进入对话输入区，统一在对应页面处理。

### 6.5 历史与 AI Replay

会话详情采用页签拆分：

- 对话。
- 时间线。
- 上下文。
- 文件变更。
- 工具诊断。
- 统计。

消息和 Diff 保持双向定位；当前选中的消息或事件使用左侧强调条，不使用整卡高亮闪烁。

### 6.6 设备与设置

设备卡片包含：

- 在线、离线、执行中、异常状态。
- 操作系统和应用版本。
- 当前任务数。
- Hook 与同步状态。
- CPU、内存、磁盘和网络摘要。

设置分为 Web 设置和设备设置。敏感字段始终脱敏，不提供复制明文按钮。

## 7. 视觉规范

### 7.1 色彩

| Token | 色值 | 用途 |
|---|---|---|
| `background` | `#0A0A0A` | 页面背景 |
| `surface` | `#111313` | 导航与一级表面 |
| `card` | `#151515` | 普通卡片 |
| `surfaceRaised` | `#181B1A` | 输入框、浮起卡片 |
| `border` | `#262626` | 边框 |
| `textPrimary` | `#F3F5F4` | 主文字 |
| `textSecondary` | `#C8C8C8` | 正文 |
| `textMuted` | `#8A8A8A` | 辅助信息 |
| `primary` | `#3DD68C` | 主操作、在线、成功 |
| `info` | `#7AA2F7` | 搜索、读取、信息 |
| `warning` | `#E5C453` | 审批、警告 |
| `danger` | `#F25E5E` | 错误、危险操作 |
| `subtask` | `#D980C8` | 子任务、Agent |

### 7.2 排版

- 字体：`Segoe UI`、`Microsoft YaHei UI`、系统无衬线字体。
- 页面标题：22–24px / 700。
- 区块标题：16–18px / 600。
- 对话正文：15–16px / 400。
- 普通正文：14px / 400。
- 辅助信息：12px / 400。
- 代码与路径：系统等宽字体，12–13px。

### 7.3 间距与形状

- 采用 4px/8px 倍数体系。
- 页面主间距 24px，卡片间距 12–16px。
- 卡片圆角 10–14px，输入区圆角 16px。
- 点击区域最小 40×40px。
- 常规动画 120–200ms，最长不超过 300ms。

## 8. 状态设计

所有关键页面必须覆盖：

- 初始空状态。
- 加载骨架。
- 正常状态。
- 执行中。
- 等待审批。
- 设备离线。
- 网络断开和重连。
- Hook 未安装。
- 无权限。
- 数据过期。
- 执行失败。

设备离线时，历史和已同步分析仍可查看；所有实时写操作置灰并显示离线原因。

## 9. 可访问性

- Tab 顺序与视觉顺序一致。
- 所有按钮有可见焦点和 `aria-label`。
- 状态不得只依赖颜色，必须同时展示文字或图标。
- 模态框打开后锁定焦点，关闭后返回触发元素。
- 图表支持方向键导航与 Enter/Space 下钻。
- 中英文均使用 24 小时制。
- 中文与英文长度变化不得遮挡主按钮或状态标签。

## 10. 设计验收清单

- [ ] 三次点击内完成设备、项目选择并进入对话。
- [ ] 当前设备、项目、分支和 CLI 来源始终明确。
- [ ] 对话、工具、文件和审批具有清晰的信息层级。
- [ ] 历史消息与 Diff 支持双向定位设计。
- [ ] 桌面、平板和手机均无整页横向滚动。
- [ ] 空状态、离线、失败、审批和重连均有明确界面。
- [ ] 中英文切换不会破坏布局。
- [ ] 视觉风格与桌面端一致，但不保留终端和分屏概念。

## 11. 完整功能设计文档

| 文档 | 内容 |
|---|---|
| [产品范围与实施计划](./web-design/01-产品范围与实施计划.md) | 产品边界、阶段、工作包、交付标准 |
| [数据上报与能力映射](./web-design/02-桌面端数据上报与Web能力映射.md) | 数据通道、桌面代理、安全和一致性 |
| [全局框架与设计系统](./web-design/03-全局框架与设计系统.md) | 布局、Token、组件、响应式和无障碍 |
| [登录配对与设备连接](./web-design/04-登录配对与设备连接.md) | 身份、配对、设备信任和权限 |
| [工作台与 AI 对话](./web-design/05-工作台与AI对话.md) | 对话、工具、审批、时间线和输入区 |
| [项目与 Worktree](./web-design/06-项目与Worktree.md) | 项目、分组、健康、SSH 和 Worktree |
| [文件与 Git](./web-design/07-文件与Git.md) | 文件树、搜索、Diff、分支和提交 |
| [历史与 AI Replay](./web-design/08-历史与AI-Replay.md) | 历史、Replay、快照和 Prompt Library |
| [分析与请求日志](./web-design/09-分析与请求日志.md) | 指标、图表、日志、口径和导出 |
| [设备任务与通知](./web-design/10-设备任务与通知.md) | 设备、资源、后台任务和通知 |
| [供应商、Hook 与状态栏](./web-design/11-供应商Hook与状态栏.md) | cc-switch、Hook 和状态栏设计器 |
| [备份恢复与设置](./web-design/12-备份恢复与设置.md) | 快照、恢复、设置和安全 |
| [状态矩阵与验收标准](./web-design/13-状态矩阵与验收标准.md) | 通用状态、场景矩阵和验收要求 |
| [Web 后端技术架构](./web-design/14-Web后端技术架构.md) | 全 Rust 服务、SQLite3、缓存和扩容边界 |
| [移动 Web 参考调研](./web-design/15-移动Web参考调研.md) | LiveAgent、Orca 调研和移动端决策 |

## 12. 完整高保真原型

深色原型保存于 [`docs/design/web-complete`](./design/web-complete/)，浅色原型保存于 [`docs/design/web-complete/light`](./design/web-complete/light/)，共 58 张。两套主题使用相同信息架构和交互流程；弹窗、空态、加载、错误、离线和权限细节以专题文档中的状态矩阵为准确依据。

Image 2 批量生成提示词保存在 [深色原型提示词](./web-design/Image2原型提示词.jsonl) 和 [浅色原型提示词](./web-design/Image2浅色原型提示词.jsonl)。快速评审可查看 [深色总览 1](./design/web-complete/overview-contact-dark-1.jpg)、[深色总览 2](./design/web-complete/overview-contact-dark-2.jpg)、[浅色总览 1](./design/web-complete/overview-contact-light-1.jpg) 和 [浅色总览 2](./design/web-complete/overview-contact-light-2.jpg)。

### 12.1 浅色主题设计基准

| 原型 | 状态 |
|---|---|
| [浅色桌面主页面](./design/web-complete/light/01-global-shell-desktop.png) | 已确认 |
| [浅色移动主页面](./design/web-complete/light/03-global-shell-mobile.png) | 已确认 |

其余浅色页面必须沿用这两张图的白色表面、淡蓝背景、蓝色主操作、低饱和功能色、细边框、轻阴影和留白体系。完整浅色生成提示词保存在 [Image2 浅色原型提示词](./web-design/Image2浅色原型提示词.jsonl)。

| 编号 | 原型 |
|---:|---|
| 01 | [全局桌面框架](./design/web-complete/01-global-shell-desktop.png) |
| 02 | [平板响应式框架](./design/web-complete/02-global-shell-tablet.png) |
| 03 | [移动端全局框架](./design/web-complete/03-global-shell-mobile.png) |
| 04 | [登录](./design/web-complete/04-login.png) |
| 05 | [设备配对](./design/web-complete/05-device-pairing.png) |
| 06 | [设备授权](./design/web-complete/06-device-authorization.png) |
| 07 | [设备离线](./design/web-complete/07-device-offline.png) |
| 08 | [工作台空状态](./design/web-complete/08-workbench-empty.png) |
| 09 | [工作台执行中](./design/web-complete/09-workbench-running.png) |
| 10 | [工作台审批](./design/web-complete/10-workbench-approval.png) |
| 11 | [工作台执行失败](./design/web-complete/11-workbench-error.png) |
| 12 | [工作台 Diff](./design/web-complete/12-workbench-diff.png) |
| 13 | [项目概览](./design/web-complete/13-project-overview.png) |
| 14 | [项目详情](./design/web-complete/14-project-detail.png) |
| 15 | [Worktree 管理](./design/web-complete/15-worktree-management.png) |
| 16 | [文件浏览器](./design/web-complete/16-file-browser.png) |
| 17 | [文件搜索](./design/web-complete/17-file-search.png) |
| 18 | [Git 工作区](./design/web-complete/18-git-workspace.png) |
| 19 | [历史列表](./design/web-complete/19-history-list.png) |
| 20 | [历史详情](./design/web-complete/20-history-detail.png) |
| 21A | [AI Replay 长页参考](./design/web-complete/21-ai-replay.png) |
| 21B | [AI Replay 桌面版](./design/web-complete/21-ai-replay-desktop.png) |
| 22 | [Prompt Library](./design/web-complete/22-prompt-library.png) |
| 23 | [分析看板](./design/web-complete/23-analytics.png) |
| 24 | [请求日志](./design/web-complete/24-request-logs.png) |
| 25 | [设备中心](./design/web-complete/25-device-center.png) |
| 26 | [设备资源详情](./design/web-complete/26-device-detail-resources.png) |
| 27 | [供应商、Hook 与状态栏](./design/web-complete/27-provider-hook-statusline.png) |
| 28 | [备份恢复与设置](./design/web-complete/28-backup-settings.png) |
