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

## 1.4.2 Home 状态所有权与 Hook 查询修复（2026-10-10）

根因：非凭据配置不等于供应商拥有的运行参数；旧供应商/公共 TOML 的 hooks.state、notice、tui.model_availability_nux、projects.<path>.trust_level 等被复制到新 profile，回放过期信任和确认。另一个独立生产端是 Hook 状态查询自动重建信任并删除 enabled=false，公共同步也凭计算哈希生成信任。

- 用户授权追加原任务、沿用 1.4.2；复用 fix/codex-statusline-config-precedence（基线 master 02cd6cd7，工作区干净，与记录的 upstream 0/0）。GitNexus 不可用，使用 codebase-memory 调用图 + 契约/源码，公共生成器、快照读取、代理展开和 Hook 状态入口为 HIGH/CRITICAL 影响。
- 单一来源清理规则排除根级 hooks.state、notice、tui.status_line/model_availability_nux、windows_wsl_setup_acknowledged、项目 trust_level；只剔除路径信任，不删 projects 中的其他选项。保留实际 Hook 定义、features、TUI 偏好、desktop、权限/沙箱、模型目录/超时/MCP/Skills/未知运行参数、显式用户命名 profiles。screen_reader_detection_done 无充分归属文档且未发现源污染，不擅自过滤。
- 目标 Home 的已有状态（含 false/空数组）不变；不修改供应商原始库或用户 Home，不注入 Windows 状态到 WSL/远程。新旧快照使用同一规则。代理展开旧受管 profile 时依据生成名称和内容双重识别，用户自定义 profile 不变。
- Codex 状态查询纯只读，不自动信任/启用/去重。用户明确安装时才允许去重旧托管重复块，不新增 trusted_hash。旧 CC Switch 兼容同步只复制实际已保存、匹配当前定义的信任，并保留 enabled=false；不计算后直接信任。
- 发现清单：global/materialize 与 scope manifest、proxy 文件展开、Hook 查询/显式安装/公共同步需改；runtime、仓储 common 合并、global plan/preview、project_policy 和 cc-connect 复用生成器需链路测试；状态栏页、PTY/渲染/模型网络发现无关。供应商编辑器的原始生效文档展示不是目标 Home 写入预览，不迁移存储。
- 场景：Home 已有/缺失状态、已信任/禁用/变化/未安装 Hook、普通/内联/点路径 TOML、公共配置开关、全局/项目/Worktree/恢复新进程/扩展组合、新旧快照/代理；焦点/分屏/最小化不改变后端生成，SSH 不注入本机供应商，WSL 使用自身 Home，运行中进程不会热更新。
- 验收以临时配置/数据库夹具为主，同时验证运行参数不丢失和本机状态不被覆盖。重复新建 profile 应无旧信任，已确认状态不变；实际变更的 Hook 仍需用户审核。不承诺本轮解决模型发现超时或未知未来 Codex 状态键。
- 调用方补齐：terminalLaunch 的 shouldEnableHookEnv 为完整但未审核的安装准备桥接环境（只准备，不执行或信任），避免审核后本次进程没有通知上下文；缺模块/关特性/应用桥接关闭时保持原有关闭行为。旧代理识别覆盖项目 marker 的 LF/CRLF 和 UUID 供应商的自定义 env_key；名称/内容无法证明受管的用户文件保持原样，新建正常进程则由统一生成入口清理。
