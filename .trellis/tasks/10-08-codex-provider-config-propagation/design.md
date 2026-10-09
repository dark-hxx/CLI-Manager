# 根因与修复边界

供应商到运行配置边界有两次有损投影：global/materialize.rs 只复制三个顶层键；scope.rs 的 routing-only overrides 又被 extensions/project_policy.rs 当作完整供应商配置。修复应落在配置生产与组合层，不在 /model 或终端显示处兜底。

1. 复用现有 TOML 合并器，将来源文档全部非凭据配置合入真实 Home；三个旧连接归属键仍按既有替换语义处理，其他未声明设置继承。
2. 独立 profile 复用同一 materializer。快照保存该次启动的完整已清理 TOML，组合配置不读取可被下一次启动覆盖的 provider-named 文件。
3. 项目扩展按 TOML 结构覆盖供应商配置（标量/数组替换、表递归），不拼接重复键。
4. 前端有 profile 的回退仍保留完整 profile，只追加项目覆盖；旧快照无 profile 时保持历史兼容，不放宽 shell 输入校验。

场景：全局/项目/Worktree/显式供应商；公共配置开关；普通启动/恢复新进程；本机组合 profile/扩展 profile 生成失败回退；多个会话不同快照。SSH 不使用本机供应商配置，保持现有行为。WSL 的既有 Home/路径选择不在本轮改造范围，覆盖参数拼接逻辑但不宣称真实 WSL 验收。

触点：供应商仓储公共合并和预览、global materializer/runtime、scope 快照、project_policy 组合、terminalLaunch 回退、codex-proxy 现有完整 profile 读取。密钥注入/PTY/网络发现/桌面渲染不改。

影响：全局应用会让以前被漏掉的显式配置真正生效（包括用户显式填写的权限和功能设置）；未指定字段不删除，真实 Home 不替换。纯临时夹具验证，不自动应用到用户环境。

工具：GitNexus MCP 不可用，采用 codebase-memory（已在分支切换后刷新）、契约及源码交叉复核。旧图谱中不存在的 profile.rs 路径已通过刷新纠正。

## 1.4.2 状态栏所有权回归修复

根因：完整供应商配置传递把供应商历史文档中的 `tui.status_line` 一并写入运行 profile；它覆盖设置页单独维护的 Home 配置，导致预览与实际终端读取不同数组。真实 Amz profile 的输入/输出 Token 顺序与用户截图吻合，不是 Codex 0.162.0 丢失显示项。

- 所有权：根级 `tui.status_line` 属于 Codex Home 的全局界面设置，不属于供应商。生成全局应用计划时保留目标 Home 的该字段（包括空数组），生成供应商 profile 时不写它，交给 Codex 继承自己的 Home；未配置时使用 Codex 默认行为。不回写/删除供应商数据库中的原始文档。
- 仅过滤供应商来源这一条路径；保留 `tui.theme`、通知及其他未知字段。显式用户命名 profiles 不迁移，其他运行参数仍完整传递。不要读取本机 Home 去填进 WSL 或远程 Home。
- 老供应商快照在已存在的配置读取入口做同样的字段归属清理，以免项目 MCP/Skills 组合重新带回旧值；不修改其他快照字段或重读供应商数据库。
- 场景：普通表/内联表/点路径；Home 已配置/空数组/未配置；全局应用/项目/Worktree/恢复新进程/扩展组合；新旧快照；WSL 使用自身 Home，SSH 无本机供应商注入；运行中进程不热更新。
- 发现清单：global materializer（需改）、runtime builder（复用同一生成器，增加真实入口测试）、scope manifest 读取（需改）、project_policy 组合（增加链路测试，业务无需改）、statusline 保存/预览（确认读取全局配置，无需改）、Codex proxy（已有完整 profile 展开，不新增配置覆盖）。
- GitNexus 未暴露；刷新 codebase-memory 后按调用图与源码复核。公共生成器和快照读取影响分类 CRITICAL/HIGH，已告知用户。使用纯临时夹具，不改真实配置、不关闭终端，不声称示例预览是 Codex 实际渲染。
