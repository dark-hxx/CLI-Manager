# 设计：桌宠 ID 路径组件校验

## 根因陈述

`valid_pet_id` 只检查长度和字符集合。因为字符集合允许点号，单独的 `.` 和 `..` 会通过校验；这些值进入 `installed_root(...).join(pet_id)` 后具有当前目录或父目录语义。卸载路径随后执行递归删除，安全边界在共享 ID 校验处已经失效。

## 发现清单

- `valid_pet_id`：根因位置；改为同时要求输入恰好解析为一个 `Component::Normal`。
- `validate_manifest` / `validate_catalog`：安装和远程目录入口共用该校验，将继承修复。
- `newest_installed_pet` / `list_managed_pets`：读取路径入口共用该校验，将继承修复。
- `desktop_pet_uninstall`：高风险递归删除消费者；保持 IPC 与错误码不变，更新注释以反映已建立的边界。
- `valid_codex_pet_id` / `raw_codex_pet_id`：Codex 外部 ID 规则更窄，不接受点号或路径分隔符，无需修改。
- 前端设置页：已处理稳定错误码 `pet_id_invalid`，无需新增文案或契约。

## 行为与边界

- 接受：`official.pixel-fox` 等现有合法 ID。
- 拒绝：空值、`.`、`..`、带首尾空白后等价于 `.` / `..` 的值、路径分隔符和既有非法字符。
- 不改变 IPC 名称、参数、错误码、持久化结构或安装目录布局。
- 不通过真实卸载验证，避免触碰用户文件；使用纯校验单元测试覆盖危险输入。

## 影响分析

GitNexus 索引缺少 `.gitnexus/lbug`，对 `valid_pet_id`、安装/导入/卸载命令及回归测试的上游影响查询均返回 `UNKNOWN`。降级检索确认共享校验的直接消费者仅限桌宠清单、目录读取和卸载路径；修复会收紧这些入口的非法 ID，不影响合法 ID。
