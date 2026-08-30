# 设计

`Select` 增加禁用选项点击回调，仍由 Radix Select 负责禁用和无障碍状态；`ConfigModal` 为继承选项传入回调，在没有 `parentBoundPath` 时显示本地化 toast。路径模式和项目数据不变。

场景覆盖：根文件夹无绑定、嵌套文件夹无自身绑定但有祖先绑定、已有绑定、创建/编辑、本地/WSL 项目；SSH 项目不显示本地路径模式。
