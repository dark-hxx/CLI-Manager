# 实施记录

- 已接入侧栏头尾、项目树（含折叠/拖拽）、项目操作菜单、同步入口、终端标签与拖拽浮层、终端工具栏、侧面板标签、窗口按钮及布局菜单。
- 命令模板与后台任务仅替换工具栏触发图标；面板内部不扩展。
- 默认项目/分组图标通过 homeStyle 选择新版；自定义 mark、品牌图片、CLI 图标优先分支保留。
- 更新中英文开关说明、TEMP 日志与功能清单。
- 场景检查：折叠/左右停靠已定向测试；主题颜色使用 currentColor；WSL/SSH/Worktree/Hook 业务分支及状态色不改。分屏/全屏尺寸和原处理器保留。

## 验证
23 项定向测试、npx tsc --noEmit、npx vite build、npm run check:architecture -- --strict、git diff --check 均通过。构建提示混合静态/动态导入和大分包。
桌面浅深主题、中英文切换、实际分屏/拖拽视觉待人工验收；遵循规约未启动应用。

## 第二版视觉预览

用户要求重设计为苹果风并先看 HTML。新增 docs/design/home-icons-apple-v2.html，包含 24 个原创 SVG、首页示意、尺寸切换、明暗主题和中英文。仅设计预览，未替换产品图标。已通过 Chrome 打开本地文件，验证切换和 390px 窄屏无横向溢出。

### 预览迭代

按反馈重绘项目、终端、文件三枚图标：去掉多余结构线与底板，改为简化多色造型（蓝色文件夹、深色终端 + 绿色提示符、白色文档 + 蓝色折角与内容线）。随后为全部 24 枚图标加入统一苹果色板的单主色配色，并用无头 Chrome 校验明暗主题与 24px 网格显示。

## 第三版：多色图标上线

- 按 HTML 设计稿重写 `src/shared/ui/homeIcons.tsx`：`createHomeIcon` 改用 `{ color, wash, detail, body }` 规格；精致模式通过内联 `color` 应用苹果色板，调用方 `style.color` 仍可覆盖（同步状态云图标依赖此行为）。
- 项目/终端使用 `var(--node-accent, …)` 保留项目自定义色；代码文件、终端方形、命令 ⌘ 提供多色实体图形。警告、勾选、同步、关闭、筛选、链接等状态图标不做固定着色。
- `CommandTemplatePanel` 工具栏触发图标由 TerminalSquare 改为新增的 Command。
- 补充多色断言（文件夹/终端使用 accent 变量，状态图标不写死颜色）。
- 验证：`node --test scripts/homeIcons.test.mjs` 5 项通过、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`npx vite build` 通过；无头 Chrome 渲染 53 枚明暗预览确认造型可辨。

## 第四版：对齐设计稿

- 按 `docs/design/home-icons-apple-v2.html` 的 `<symbol>` 原始路径逐枚重画 24 个功能图标；修正上一版手写路径与设计稿不一致的问题。
- 恢复 Folder/FileCode/Terminal 的渐变填充；历史会话、系统资源、布局、分屏、搜索、刷新按设计稿补齐；设置改为滑杆、运行改为实心三角、复制改为双卡片、同步云补箭头。
- Folder 渐变按实例生成唯一 id（`useId`），避免多个不同 `--node-accent` 项目共用第一份渐变导致串色；新增回归测试。
- 状态类图标（Cloud/AlertTriangle/CircleStop/Check/Filter/Link2/X）继续继承 currentColor，以保留同步与危险状态语义。
- 验证：`node --test scripts/homeIcons.test.mjs` 6 项通过，`npx tsc --noEmit`、`npm run check:architecture -- --strict` 通过；88px 无头 Chrome 细节图与设计稿逐枚比对一致。

## 第五版：侧边栏图标尺寸统一

- 侧边栏项目行、置顶项目行、新建分组行统一 17px；分组行由 16px 调整为 17px；折叠态项目（15→17）、折叠态分组（16→17）与浮出分组（13→15）同步。
- 保持 `.ui-tree-leading-icon` 22px 容器与 12px 箭头不变，仅放大图形本体。
- 验证：图标测试 6 项、`npx tsc --noEmit`、`npm run check:architecture -- --strict` 通过。

## 第六版：品牌与功能图标视觉尺寸归一

- 问题：精致功能图形在 24 画布内只占约 18px，而 CLI 品牌图标（OpenAI/Claude 等）几乎铺满画布；同为 17px 时文件夹视觉宽约 13px，品牌 Logo 约 17px。
- `NodeAppearanceIcon` 在 `homeStyle && refined` 时补偿：功能图形 +2（19px），品牌/CLI 图标 -2（15px）；自定义 emoji 与图片、经典模式保持原尺寸。
- 置顶区标题文件夹改用 19px，浮出分组 17px。
- 新增尺寸断言与图形隔离测试（比较品牌图标时忽略宽高）；无头 Chrome 渲染 17px 行对照，文件夹/终端/OpenAI/Claude 视觉尺寸一致。
- 验证：图标测试 7 项、`npx tsc --noEmit`、`npm run check:architecture -- --strict` 通过。

## 第七版：品牌 Logo 安全区（移除尺寸补偿）

- 撤销上一版按场景做的 19/15px 视觉补偿，`NodeAppearanceIcon` 所有分支恢复为同一 `size`。
- `CliToolIcon` 增加 18/24 安全区包装：外框 24 viewBox，内嵌 18×18 视口承载原始品牌 SVG，Logo 不再铺满画布，与设计稿功能图形同视觉尺寸；所有调用点（侧栏、历史、统计）自动一致。
- Kimi 由 Color 切换为 Mono，修复白底 Logo 在浅色主题只剩一个点的问题。
- 设计稿新增“AI 标识”区：12 个 Logo 使用与产品完全相同的 18/24 结构，支持明暗主题；同步更新方向说明与预览注记。
- 验证：图标测试 7 项、`npx tsc --noEmit`、`npm run check:architecture -- --strict` 通过；无头 Chrome 对照 17px 侧栏行与 24px 设计稿，文件夹/终端/OpenAI/Claude/Kimi 视觉尺寸一致。

## 第八版：侧栏项目树图标再放大两档

- 项目行、分组行、置顶项目行、置顶标题文件夹、新建分组行、折叠态项目/分组统一 17→19px。
- 浮出分组 17→19px，浮出项目 13→15px，拖拽浮层 14→16px。
- 安全区结构不变，Logo 与功能图形仍同视觉尺寸。
- 验证：图标测试 7 项、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、无头 Chrome 19px 对照通过。

## 第九版：侧边栏头部/底部图标 +3

- 头部：折叠箭头 14→17、筛选 14→17、新建分组 14→17、新建 13→16。
- 底部：统计 14→17、设置 14→17、协作 14→17；同步云 14→17，行内同步云 12→15。
- 28px 操作按钮容器与布局不变；项目树图标维持上一版 19px。
- 验证：图标测试 7 项、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`npx vite build` 通过。

## 第十版：分层渲染（Icon Study 03）

- 重写 `src/shared/ui/homeIcons.tsx` 图形：新增 `Solid`（实心 + 顶部白色高光，按实例 `${uid}-sheen` 渐变）、`rect`、`panel` 辅助；对象类实心剪影 + 白色镂空，次级部件 40–60% 透明度，面板类外框 + 实心内嵌区，动作类线性几何统一圆角。
- 终端/终端方块共用 `terminalBody`，渐变 id 改为按实例生成；文件渐变同理。
- Copy 去掉固定蓝色（标题栏还原按钮与其他窗口按钮一致），Handshake 重画，Filter 改递减横线，Palette 四色颜料点。导出名与 props 不变，18 个导入点无需改动。
- 新增 `docs/design/home-icons-apple-v3.html/.png`：由产品组件 `renderToStaticMarkup` 生成，稿件即产品。
- 验证：`node --test scripts/homeIcons.test.mjs` 8 项通过（新增按实例渐变 id 测试，状态继承列表补 Copy/Minus/Square）、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`git diff --check` 通过；无头 Chrome 13/15/17/19/24/44/64px 明暗对照检查。桌面实际视觉待人工验收。
