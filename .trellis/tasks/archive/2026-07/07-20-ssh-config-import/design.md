# SSH Config 导入技术设计

## 1. Design Summary

导入只创建 SSH Config 引用型主机。应用解析配置文件用于枚举具体 `Host` 别名；实际连接仍由系统 OpenSSH 解释完整配置。

默认目录为原生系统用户目录下的 `.ssh`。用户可选择其他目录，应用读取其中的 `config` 文件，并把该绝对文件路径作为机器本地 `config_file` 保存到导入主机。所有 OpenSSH 调用在 `config_file` 非空时统一添加 `-F <config_file>`。

## 2. Data Model

新增 SQLite 字段：

```sql
ALTER TABLE ssh_hosts ADD COLUMN config_file TEXT NOT NULL DEFAULT '';
```

- 空字符串：使用 OpenSSH 默认用户配置。
- 非空字符串：使用指定绝对配置文件，并在所有 OpenSSH 进程参数中添加 `-F`。
- 字段只存在于本机 `ssh_hosts` 表；当前同步/备份不导出 SSH 主机，因此不进入跨设备数据。

前端 `SshHost`、`CreateSshHostInput`、`SshConnectionSpecPayload` 增加 `config_file/configFile`。Rust `SshConnectionSpec` 和 `SshLaunchPlan` 增加 `config_file`，并使用 `#[serde(default)]` 保持旧请求和 daemon 帧兼容。

## 3. Import Boundary

新增 Tauri 命令：

```rust
pub fn ssh_config_default_directory() -> Result<String, String>;
pub async fn ssh_config_import_preview(config_dir: String)
    -> Result<SshConfigImportPreview, String>;
```

返回结构：

```text
SshConfigImportPreview
  configDir: string
  configFile: string
  isDefault: boolean
  hosts: [{ alias, sourceFile }]
  warnings: [{ code, sourceFile }]
```

路径规则：

- 前端目录选择结果视为不可信输入。
- 拒绝空值、NUL、CR、LF 和非绝对路径。
- canonicalize 目录和 `config` 文件；必须分别是目录和普通文件。
- 单文件大小上限 1 MiB，最多读取 256 个 Include 文件，最大递归深度 16。
- 通过 canonical path 维护递归栈和已访问集合，循环 Include 直接失败。

## 4. Parser Scope

解析器只理解发现主机所需的语法：

- 忽略 UTF-8 BOM、空行和注释。
- 指令名不区分大小写，兼容空格和 `keyword=value`。
- `Host` 支持多个 token 和引号。
- 只返回不含 `*`、`?`、`[`、`]`、`!` 的具体别名。
- 支持顶层、`Host *` 和 `Match all` 中的 Include。
- 条件 Host/Match 内的 Include 不展开，返回 warning，避免产生实际不可达的别名。
- Include 支持绝对路径、`~`、`${ENV}`、相对路径和 glob；相对路径按 OpenSSH 用户配置规则从 `~/.ssh` 解析。
- glob 使用现有 `regex` 依赖和 `std::fs::read_dir` 按路径组件展开，结果按路径字典序处理，不新增依赖。

不调用 `ssh -G`，避免批量预览触发 `Match exec`。

## 5. Data Flow

```text
目录选择
  -> ssh_config_import_preview
  -> Rust 路径验证/Include 解析
  -> 候选 Host 别名
  -> 前端重复标记/勾选/目标分组
  -> sshHostStore.importConfigHosts
  -> BEGIN IMMEDIATE
  -> authoritative duplicate query
  -> INSERT ssh_hosts
  -> COMMIT + fetchHosts
```

连接链路：

```text
SshHost.config_file
  -> buildSshConnectionSpec
  -> ssh_test_connection / ssh_check_path / ssh_list_directories
  -> SshLaunchPlan
  -> in-process PTY or daemon
  -> ssh [-F config_file] alias
```

## 6. Bulk Import

`sshHostStore` 新增 `importConfigHosts`：

- 输入为选中 aliases、`config_file`、目标 `group_id/group_name`。
- alias trim 后按不区分大小写去重。
- 事务内重新查询数据库中的非空 `config_alias`，避免预览后的状态变化造成覆盖。
- 每条记录复用 `buildSshHost` 和 `validateSshHost`，写入同一事务。
- 任一 INSERT 失败执行 ROLLBACK；成功后只刷新一次 hosts。
- 返回 imported/skipped 数量。

## 7. UI

SSH 主机页顶部在“新建 SSH 主机”前增加带 Lucide Import 图标的“导入”按钮。

导入弹窗包含：

- 配置目录输入和目录选择按钮，打开时填充系统默认 `.ssh`。
- 扫描/重新扫描命令。
- 目标 SSH 分组选择，默认根级。
- 可滚动候选列表、全选复选框、单项复选框。
- alias、来源文件、已存在状态。
- warning、读取错误和导入进度。

重复项禁用且不进入全选集合。没有候选项或没有选中项时禁用导入按钮。

## 8. Compatibility

- Migration 22 为旧数据库填充空 `config_file`，旧 SSH 主机行为不变。
- `SshLaunchPlan.config_file` 使用 serde default；新 daemon 可接收旧帧。
- 旧 daemon 默认忽略 JSON 未知字段；若 daemon 创建失败，现有 in-process PTY fallback 保持有效。
- 地址型主机构建时强制清空 `config_file`，避免错误应用 `-F`。
- 自定义配置文件失效时 Rust 返回稳定错误，不回退默认配置。

## 9. Discovery / Impact Analysis

GitNexus 索引落后且重建因本机缺少 `tree-sitter-kotlin` 失败，因此按项目规约使用 SSH contract、fast-context 和精确引用检索降级分析。

风险级别：**HIGH**，因为字段跨越终端启动和 daemon 边界。

- `SshHost` / `CreateSshHostInput`：设置页、项目配置页、terminal store、TerminalTabs 消费；字段默认值必须补齐。
- `buildSshConnectionSpec`：直接影响设置页测试连接、远程路径浏览和终端启动。
- `SshConnectionSpec`：影响 `ssh_test_connection`、`ssh_check_path`、`ssh_list_directories`。
- `SshLaunchPlan`：影响 PTY manager、daemon protocol/server 和兼容测试。
- `sshHostStore`：新增批量入口；现有 create/update/delete 行为必须保持。
- `migrations()`：新增版本 22，并补迁移测试。
- `syncStore`：当前不导出 `ssh_hosts`，确认无需修改。
- 本地/WSL 项目启动：确认不消费 SSH DTO，与本功能无关。

## 10. Verification

- Rust parser 单元测试：BOM/CRLF、多 alias、pattern 过滤、Include/glob、顺序、循环、条件 Include、目录/文件错误。
- Rust SSH 参数测试：默认配置不带 `-F`；自定义配置在 probe 和 launch 中都携带 `-F`；缺失文件失败；serde default 兼容。
- Migration 测试：旧 ssh_hosts 表迁移后字段存在且默认空。
- 前端 TypeScript 检查：所有 DTO 和构造器完整。
- 手动代码检查：同步/导出无 `config_file`。
