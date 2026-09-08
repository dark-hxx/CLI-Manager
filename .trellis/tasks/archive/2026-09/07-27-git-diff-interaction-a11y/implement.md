# Implementation Plan

1. 为选择范围和 side 规则建立纯函数测试。
2. 扩展 Controller selection model，替换数组线性查找为 Set + 稳定顺序映射。
3. 将 gutter 交互改为可聚焦控件并接入 Enter/Space/Shift+Arrow。
4. 用项目 Dialog 基础设施替换手写 Portal/全局 keydown，保留遮罩点击和 Esc 行为。
5. 增加 live region、focus/selected 非颜色提示和双语 aria 文案。
6. 手工验证键盘、IME、屏幕缩放、亮暗主题和窄窗口。
