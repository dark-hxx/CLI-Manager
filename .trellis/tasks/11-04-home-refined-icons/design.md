# 设计

共享 `homeIcons.tsx` 以显式导出的功能图标封装读取 settingsIconStyle，原样转交经典分支参数；精致分支使用 24 网格双色 SVG 和 currentColor。

仅替换首页调用处导入。品牌图标不接入此入口；NodeAppearanceIcon 使用可选 homeStyle 参数，仅默认图形按首页偏好呈现。共享层不引用任何功能域，不新增持久化字段。

影响分析：多数侧栏入口 LOW；TreeNodeItem 为 CRITICAL；终端部分入口因索引滞后 UNKNOWN，已通过源码引用核对。仅调整图标导入和 fallback 呈现，未修改进程、交互事件和业务状态。
