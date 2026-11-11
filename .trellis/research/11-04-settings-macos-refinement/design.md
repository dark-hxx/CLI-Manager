# 设计

- 桌面侧栏 220px；小于 760px 使用顶部分类 Select，仍调用同一个 onTabChange。
- 固定标题栏、正文独立滚动。普通内容最大 880px、复杂页面最大 1200px；边距 24px/16px。
- SettingsSection / SettingsRow 为无状态分组与标签-控件布局；小于 560px 可用宽度上下排列。
- 设置专用 MantineThemeProvider 继承现有主题，用组件 classNames 覆盖控件与 Portal 浮层，不更改全局默认值。
- Radix 的通用确认弹窗通过共享 DialogPresentationProvider 的可选上下文继承设置样式与关闭标签；设置外保持默认。原有显式作用域类继续兼容。
- 设置样式通过 components.css 有序导入，以 settings-scope 和控件类约束影响范围。
- 表面、文字、强调色继承用户主题；10px 分组圆角、8px 控件圆角、淡单边框；普通卡片无阴影。
- 导航选中浅填充/500 字重，主题选项细边框+勾选；焦点独立 2px 环。
- 控件最小 34px、图标按钮最小 32px，跟随字号。菜单/弹窗柔和投影；150ms 过渡并遵守 reduced-motion。
- 保持 IPC/store/导航 ID、关闭拦截、焦点和折叠状态；隐藏的状态栏及命令提示入口继续隐藏。
- 场景：窄窗口、工作区背景、明暗、中英文、11–18px 字号、键盘/鼠标、空/忙/错/禁用；WSL/SSH/Worktree/Hook 操作语义不变。
- GitNexus 已刷新；MCP 可能仍持有旧分支索引，空或 UNKNOWN 用当前源码核对。跨域扩展共享组件靠局部样式隔离。
- 可整体回退任务改动，无数据迁移。

## 实施中发现的焦点问题

- 根因：`getFocusableElements` 只读控件自身的 computed display。侧栏被响应式 CSS 隐藏后，后代按钮仍报告 display:block，从而进入初始焦点和 Tab 回绕集合。
- 触点：`useFocusTrap` 的候选过滤 → `SettingsModal` 焦点边界 → 桌面侧栏 / 顶部分类选择器。入口和每次 Tab 都按布局矩形与 visibility 重新过滤。
- 修复保留原有监听生命周期、Tab 回绕和无控件时的容器回退，不调整页面保存或弹窗关闭回调。
- 回归：真实 hook 在最小 DOM 边界上执行，验证初始焦点、正反 Tab、断点后的可见性重算、空集合回退和卸载清理；实际桌面焦点与 Portal 交互另列人工验收。
