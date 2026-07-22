# 修复 Web Server 迁移校验漂移

## Goal

修复 Windows 工作区中 SQL 迁移文件被检出为 CRLF 后，Web Server 因 SQLx 迁移校验和与数据库中的 LF 校验和不一致而无法启动的问题。

## Requirements

- 启动时仅修复能够确认是同一迁移内容 LF/CRLF 差异造成的校验和漂移。
- 修复前必须确认迁移已成功执行且对应数据库结构完整。
- 修复后继续使用 SQLx 原生迁移校验，不绕过其他迁移错误。
- 固定 Web Server SQL 迁移文件使用 LF，避免新数据库记录 CRLF 校验和。
- 不删除或重建现有数据库，不修改业务表结构。
- 按用户要求不更新 `CHANGELOG.md`。

## Acceptance Criteria

- [x] 当前 `data/cli-manager-web.db` 可通过迁移校验。
- [x] 全新内存数据库仍可执行全部迁移。
- [x] 非已知校验和漂移仍返回原始迁移错误。
- [x] Web Server 后端测试通过。

## Technical Approach

- 在 `Storage::open` 的 SQLx 迁移执行前调用窄范围修复逻辑。
- 对第 2 号迁移同时计算当前原始字节和规范化 LF 字节的 SHA-384；仅当数据库记录匹配规范化值、当前文件匹配另一换行变体且目标列均存在时更新校验和。
- 在 `.gitattributes` 为 `apps/server/migrations/*.sql` 指定 `eol=lf`。

## Root Cause

根因位于 Git 工作区换行转换与 SQLx 字节级迁移校验的边界：迁移 2 在数据库中以 LF 字节执行并记录校验和，但 Windows 工作区当前为 CRLF，SQLx 因字节校验和变化拒绝启动，因此修复应落在 Web Server 的迁移初始化层。

## Out of Scope

- 通用迁移历史重写工具。
- 自动修复内容真实发生变化的迁移。
- 数据库重建或数据迁移。
