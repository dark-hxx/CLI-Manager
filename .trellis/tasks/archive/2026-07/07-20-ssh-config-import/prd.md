# 导入 SSH Config 主机

## Goal

在 SSH 主机设置中提供从用户 OpenSSH `~/.ssh/config` 导入主机别名的能力，减少重复录入，同时继续以系统 OpenSSH 配置为连接事实来源。

## Background

- 当前 SSH 主机已支持 `config_alias` 和 `auth_mode = ssh_config`，连接时直接执行系统 OpenSSH 并使用别名。
- 导入功能采用“引用型导入”，不把 `HostName`、`User`、`IdentityFile`、`ProxyJump` 等配置复制成应用自有字段。
- 用户已确认支持原生 Windows、Linux、macOS，WSL 不纳入范围。
- 用户已确认自定义目录导入后必须可直接连接，并允许执行自动化测试。

## Requirements

1. SSH 主机设置页提供“导入 SSH Config”入口。
2. 默认配置文件位置按当前原生操作系统解析：
   - Windows：`%USERPROFILE%\.ssh\config`
   - Linux/macOS：`$HOME/.ssh/config`
3. 导入界面提供配置目录选择，输入框默认填充当前系统的 `~/.ssh` 目录；后端读取所选目录下的 `config` 文件。
4. 所选目录不存在、不是目录、缺少 `config`、配置不可读或无法解析时，终止本次导入并显示本地化失败原因，不产生部分导入数据。
5. 后端读取配置并枚举具体 `Host` 别名：
   - 支持一条 `Host` 声明中的多个别名。
   - 支持递归 `Include`、相对/绝对路径、`~` 和通配符。
   - 检测循环 Include，避免无限递归。
   - 兼容 UTF-8 BOM、CRLF 和 LF。
   - 跳过包含 `*`、`?` 或 `!` 的模式项，不把 `Host *` 等规则导入为主机。
6. 导入前展示候选列表，允许多选并选择目标 SSH 分组。
7. 候选项展示别名、来源文件和状态，不执行网络连接，也不使用 `ssh -G` 展开配置。
8. 已存在的 `config_alias` 按不区分大小写比较，默认跳过且不覆盖已有名称、分组、备注或连接设置。
9. 导入记录使用以下映射：
   - `name = Host alias`
   - `config_alias = Host alias`
   - `auth_mode = ssh_config`
   - 默认 `.ssh` 目录使用空 `config_file`，由 OpenSSH 读取默认配置。
   - 自定义目录保存机器本地绝对 `config_file` 路径。
   - 地址、用户名、私钥、凭据、跳板和代理字段保持为空或默认值。
10. 批量写入使用 SQLite 事务；任一写入失败时整体回滚。
11. 不读取私钥内容，不导入密码。
12. 连接、测试连接、目录检查、目录浏览和 PTY/daemon 启动必须统一携带该主机的 `config_file`；非空时使用 OpenSSH `-F <config_file>`。
13. `config_file` 是机器本地字段，不进入 WebDAV 同步、备份导出或普通日志。
14. 所有新增用户可见文案必须同时支持 `zh-CN` 和 `en-US`。

## Scenario Coverage

- 默认 config 存在、不存在、为空、无读取权限。
- 默认目录、手动选择有效目录、无效目录、已删除目录、目录内缺少 `config`。
- 单文件、多层 Include、通配符 Include、循环 Include、重复 Include。
- 单别名、多别名、重复别名、大小写不同的重复别名。
- `Host *`、通配符 Host、否定 Host 模式、`Match` 块。
- Windows 路径分隔符及 CRLF；Linux/macOS 路径及 LF。
- 空主机库、已有 SSH Config 主机、已有地址型主机。
- 导入到根级或现有多级 SSH 分组。
- 默认配置路径与自定义配置路径的连接、测试和目录浏览。
- 自定义配置文件在导入后被移动、删除或变为不可读。
- 应用语言为中文或英文。

## Acceptance Criteria

- [ ] Windows、Linux、macOS 原生构建均能定位各自默认 SSH config。
- [ ] 导入界面默认填充系统 `.ssh` 目录，并允许选择其他目录。
- [ ] 目录或 `config` 无效时导入失败，给出本地化原因且不写入数据。
- [ ] 能从主文件和递归 Include 文件中列出所有具体 Host 别名。
- [ ] 通配符、否定模式和 `Match` 不会生成可导入主机。
- [ ] 循环 Include 不会卡死，并返回可理解的诊断信息。
- [ ] 导入预览支持全选、单选、目标分组和重复状态展示。
- [ ] 已存在别名不会被覆盖；新别名以 SSH Config 模式批量写入。
- [ ] 批量写入失败时无部分数据残留。
- [ ] 导入结果不包含私钥内容、密码或凭据引用。
- [ ] 默认配置导入主机不强制保存展开后的用户目录路径。
- [ ] 自定义目录导入主机在连接、测试和目录查询时均使用同一 `-F` 配置文件。
- [ ] 自定义配置文件失效时返回本地化错误，不回退到默认配置。
- [ ] `config_file` 不进入同步、备份或日志。
- [ ] 导入后的主机可复用现有编辑、测试连接、打开终端和远程项目绑定能力。
- [ ] 新增界面在 `zh-CN`、`en-US` 下均正确显示。

## Out of Scope

- WSL 发行版中的 `~/.ssh/config`。
- 把 SSH Config 展开复制为地址型主机。
- 自动连接或批量测试导入的主机。
- 导入私钥、密码、证书、凭据或代理秘密。
- 修改、生成或格式化用户的 SSH config 文件。

## Technical Constraints

- 实际连接继续由系统 OpenSSH 解释完整配置，应用解析器只负责发现可导入的具体 Host 别名和 Include 来源。
- 不执行 `ssh -G`，避免 `Match exec` 在导入预览阶段被重复触发。
- 文件路径在 Rust 边界使用 `PathBuf` 处理，不拼接平台专用分隔符。
- 数据库新增 `ssh_hosts.config_file TEXT NOT NULL DEFAULT ''`；旧主机为空值，行为不变。

## Changelog Target

`V1.3.0`
