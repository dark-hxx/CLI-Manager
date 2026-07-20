# SSH Config 导入实施清单

## 1. Backend Persistence and Launch

- [x] Migration 22 增加 `ssh_hosts.config_file` 并覆盖迁移测试。
- [x] 前后端 SSH Host DTO 增加配置文件字段和默认值。
- [x] `buildSshConnectionSpec` 传递 `configFile`。
- [x] `SshConnectionSpec` 的测试/目录查询参数统一添加 `-F`。
- [x] `SshLaunchPlan` 的 PTY/daemon 启动参数统一添加 `-F`，补 serde default。
- [x] 缺失、自定义非绝对路径和控制字符返回稳定错误。

## 2. Config Discovery

- [x] 新增 `commands/ssh_config.rs`。
- [x] 实现默认 `.ssh` 目录解析。
- [x] 实现目录/config 校验、大小/深度/文件数限制。
- [x] 实现 Host token 解析和 pattern 过滤。
- [x] 实现 Include 的 tilde、环境变量、相对路径、glob 和循环检测。
- [x] 注册 Tauri commands。
- [x] 补齐 parser 单元测试。

## 3. Frontend Import

- [x] `sshHostStore` 增加事务化 `importConfigHosts`。
- [x] 新增 `SshConfigImportDialog`，支持默认目录、目录选择、预览、全选、分组和错误状态。
- [x] SSH 主机设置页增加导入入口。
- [x] 重复 alias 不覆盖，事务内再次确认。
- [x] 补齐 zh-CN/en-US 文案和错误映射。

## 4. Documentation

- [x] 更新 SSH remote terminal contract。
- [x] 更新 `docs/功能清单.md`。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.0`。

## 5. Validation

- [x] `npx tsc --noEmit`
- [x] `cd src-tauri && cargo check`
- [x] `cd src-tauri && cargo test --lib`
- [x] `npx gitnexus detect-changes`；全工作区并行变更风险为 critical，SSH 任务按目标文件、契约和精确引用单独复核。
- [x] 检查 git diff，确认 SSH 任务未修改已知并行任务文件。
