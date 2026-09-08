# Desktop Pet File Safety Contracts

## 1. Scope / Trigger

适用于 `src-tauri/src/features/desktop-pet/commands.rs` 中把桌宠 ID、清单字段或压缩包条目拼接到应用管理目录的读取、安装、导入、查询和卸载操作。即使参数名是 ID，只要进入 `Path::join`，仍按不可信路径片段处理。

## 2. Signatures

- 共享校验：`fn valid_pet_id(value: &str) -> bool`
- 删除入口：`desktop_pet_uninstall(pet_id: String) -> Result<(), String>`
- 相关入口保持既有 IPC 名称、参数和返回结构；本规则不允许仅靠前端校验替代 Rust 边界校验。

## 3. Contracts

- `valid_pet_id` 先修剪首尾空白，再要求长度不超过 80、字符属于小写 ASCII 字母/数字/`.`/`-`/`_`，并且 `Path::components()` 恰好得到一个 `Component::Normal`。
- 清单、目录查询、安装和卸载必须复用该共享校验，禁止各自维护不一致的点号或分隔符规则。
- 通过校验的 ID 才能传给 `installed_root(root).join(id)`；卸载只递归删除该受管理子目录。
- 非法卸载 ID 返回稳定错误码 `pet_id_invalid`，不改变 IPC 或前端错误映射。

## 4. Validation & Error Matrix

| 输入/状态 | 结果 |
| --- | --- |
| `official.pixel-fox` | 通过 ID 校验 |
| `.`、`..` 或修剪后等价值 | 拒绝；卸载返回 `pet_id_invalid` |
| 含 `/`、`\\`、大写或白名单外字符 | 拒绝 |
| 空值或超过 80 字节 | 拒绝 |
| 合法 ID 的受管理目录不存在 | 卸载保持幂等并返回成功 |
| ID 只对应外部 Codex 桌宠 | 返回 `pet_uninstall_external_unsupported` |

## 5. Good / Base / Bad Cases

- Good：在共享校验处同时验证领域字符和单个普通路径组件，所有文件操作消费者自动继承边界。
- Base：合法含点 ID 继续安装、查询和卸载，不改变已有数据布局。
- Bad：只用允许点号的字符白名单，或仅在 `desktop_pet_uninstall` 内特判 `..`，导致其他 `join(id)` 消费者仍可绕过。

## 6. Tests Required

- 纯单元测试断言合法含点 ID 通过，`.`、`..`、空白包裹的 `..` 和带分隔符输入失败。
- 桌宠模块测试继续覆盖内置包提取、Codex 包导入、目录扫描和缓存替换，确认共享校验收紧未破坏合法流程。
- 文件系统测试必须使用临时目录；禁止以真实用户桌宠根执行破坏性卸载测试。

## 7. Wrong vs Correct

Wrong：`allowed_chars(id) && installed_root.join(id)`，因为 `.` 和 `..` 可能都由允许字符组成。

Correct：`allowed_chars(id) && exactly_one_normal_component(id)`，之后才允许把 ID 拼入受管理根目录。
