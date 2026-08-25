# 设计：Grok 兼容 Hook 的可逆所有权

## 根因陈述

问题位于 SSH Agent 的 `config.toml` 持久化边界：Grok 安装直接覆盖 Claude/Cursor 兼容 Hook 值而未记录所有权或原值，卸载路径也未调用恢复逻辑，因此修复必须在 `hook_config.rs` 的计划生成层保存并消费受控 marker，而非在 SSH UI 或调用端增加兜底。

## 边界与数据流

`hook-config install|uninstall` → `plan_files` → Grok `config.toml` 的 `PlannedFile` → 事务性写入。

本修复只替换 Grok 的 TOML 计划生成：安装生成带 marker 的受控 `false`，卸载按 marker 恢复。JSON Hook 文件计划、报告、事务和远端命令接口保持不变。

## 方案

复用 Codex `features.hooks` 的 marker 原则，并为 `compat.claude.hooks` 和 `compat.cursor.hooks` 建立路径级辅助函数：

1. 读取现有值及 TOML 装饰（注释/空白）并识别缺失、`true`、`false` 或非法类型。
2. 对 `true` 或缺失值写入 `false`，在 suffix 添加 Agent 所属 marker，记录 installation、原值与本次创建的表层级。
3. 已为 `false` 的值视为非本次所有，不附加 marker，也不在卸载时修改。
4. 卸载仅匹配相同 installation 且仍为 `false` 的 marker；恢复旧值/移除缺失键，并仅清理本次创建后已空的表。
5. 非法或不可归属 marker 返回既有 TOML 配置错误，不猜测恢复值。

## 兼容性与安全性

- 旧版本已经写入的无 marker `false` 无法安全推断原值，升级/卸载时保持原样。
- 手动移除 marker、换为其他值、或另一安装实例写入时均不覆盖用户状态。
- 每个 vendor 独立处理，允许一个由第三方预先隔离、另一个由 Agent 管理。
- 现有 TOML 格式读取兼容性（嵌套/点号形式）不能因本修复退化；新写入遵从现有 `toml_edit` 标准表格式。

## 回滚

代码回滚仅影响未来安装/卸载计划；已存在的无 marker `false` 保持安全不变。带 marker 的文件可由同版本卸载恢复。
