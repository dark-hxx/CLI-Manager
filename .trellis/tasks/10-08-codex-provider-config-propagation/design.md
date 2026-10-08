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
