# Codex provider configuration propagation

## Goal

Fix complete Codex configuration propagation and verify 1.4.1 NSIS.

## Requirements

- 修复供应商生效 TOML 到全局配置、独立 profile、项目扩展组合 profile 的字段丢失。
- 保留用户未覆盖的真实 Home 配置；供应商凭据仍由独立 auth/子进程环境注入。
- 项目 MCP/Skills 覆盖优先，但不得丢弃其他供应商选项。
- 不修改运行中的终端、用户配置或供应商数据库；不包含模型列表请求超时修复。
- 1.4.1，提交后仅构建 NSIS，不推送。

## Acceptance Criteria

- [x] reasoning、service_tier、instructions、features、嵌套传输参数、新增非凭据配置保留。
- [x] 配置预览与实际生成在上述字段上一致，明确模型/端点投影仍优先。
- [x] 组合 profile 不出现重复键，保留非覆盖字段；旧快照兼容。
- [x] 定向 Rust/前端测试、类型与严格架构检查通过。
- [x] 提交代码，生成可核对的 1.4.1 NSIS 包及验证记录。

## Notes

- 特殊启动兼容范围及安装版人工验收见 verification.md；不把自动测试通过等同于用户环境已验证。

## 1.4.2 Home 状态与 Hook 查询追加验收（2026-10-10）

- [x] 供应商/公共配置、global/runtime、新旧快照和代理旧受管 profile 不回放 Home 信任/确认，其他完整运行配置保留。
- [x] Codex Hook 查询不写配置、不自动信任/启用；明确安装才去重旧托管块，兼容同步只复制已保存且匹配当前定义的信任并保留禁用状态。
- [x] 完整但待审核的 Codex 启动仍准备通知桥接环境，实际运行由 Codex 信任审核决定。
- [x] 临时夹具的缺失/过期/禁用信任、普通/内联/点路径 TOML、公共配置开关、项目组合与参数保留回归通过。
- [x] 先提交修复，再仅生成 1.4.2 NSIS；不推送、不自动安装或重启用户终端。
