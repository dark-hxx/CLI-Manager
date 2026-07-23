# 实施步骤

1. 在 Workspan 纯状态模块增加单 Pane 还原转换及单元测试。
2. 在 `terminalStore` 暴露原子还原动作并保持活动 mirror 语义。
3. 调整 `TerminalTabs` 的 Pane Tab 栏显示条件、Workspan 右键入口和边缘判定阈值。
4. 调整 Pane 投放区 CSS，并同步中英文文案。
5. 更新前端状态契约、功能清单和 `[TEMP]` Changelog。
6. 运行 TypeScript、相关 Node 测试与 diff 检查，复核未覆盖现有未提交修改。

