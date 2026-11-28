# V1.5.3 · 全局 / Agent / 项目三级代理配置与终端环境注入（PRD）

## 背景与目标

为 CLI-Manager 增加集中式的终端网络代理配置能力，用户在启动 Claude Code、Codex 等 CLI 项目或普通终端时，无需在每个项目的自定义环境变量 JSON 中重复填写 `HTTP_PROXY` / `HTTPS_PROXY`，即可由应用按优先级自动注入代理环境。

## 确认需求与边界

1. **三层配置与优先级**
   - 优先级：**项目级 > Agent 级 > 全局级**（同时保留项目手写 `env_vars` JSON 中显式代理键覆盖代理配置的兼容行为，以及 `CLI_MANAGER_*` 系统保留键最高优先级）。
   - **全局配置**（设置 → 代理配置）：支持启用/关闭开关、单个代理地址（`http://` / `https://` / `socks5://` / `socks5h://`）、可选 `NO_PROXY` 绕过列表，以及连通性测试。
   - **按 Agent 配置**（设置 → 代理配置）：Agent 列表复用新建项目时的「CLI 类型」单一事实源。每个 Agent 支持三态模式：
     - `inherit`（默认，跟随全局）
     - `custom`（独立代理地址 + 可选 `NO_PROXY`）
     - `direct`（显式直连/不使用代理，可覆盖全局代理并清除继承自宿主环境的代理变量）
   - **项目级配置**（新建/修改/克隆项目弹框）：新增「代理配置」折叠区，**默认收起**，头部展示当前生效摘要；展开后支持三态模式 `inherit | custom | direct`。

2. **环境变量注入与运行边界**
   - 统一注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（在 Unix/WSL/Git Bash/SSH 等大小写敏感环境同时注入小写 `http_proxy`、`https_proxy`、`all_proxy`、`no_proxy`）。
   - 注入代理时自动将 `localhost,127.0.0.1,::1` 合并进 `NO_PROXY`，保护 CLI-Manager 本地 Hook 回调与本地路由不被误代理。
   - `direct` 模式下在进程创建阶段清除继承自宿主/用户环境的代理变量，确保“直连”真正生效。
   - **WSL**：通过 `WSLENV` 将非空代理变量转发进入 WSL 子系统，并在设置页提示 WSL2 NAT 模式下 `127.0.0.1` 的指向差异。
   - **SSH 项目**：默认不继承本机全局/Agent 代理；仅当 SSH 项目显式配置 `custom` 代理时才注入远端启动环境（与 `SshHost.proxy_type` 隧道代理独立）。
   - **外部终端（`useExternalTerminal`）**：本期不注入外部终端。
   - **会话恢复**：不在持久化的 `TerminalSession.envVars` 中固化解析后的代理，每次启动/恢复按最新配置动态解析注入。

3. **连通性测试**
   - 提供后端 TCP 连通性检测能力，前端设置页和本地项目自定义代理区可点击测试代理端口可达性与延迟，严禁在日志或返回中明文输出代理凭据。

4. **数据安全与同步**
   - `settings.json` 中的 `proxySettings` 在 `SETTING_BACKUP_POLICY` 中标记为 `excluded`（本机代理地址与凭据不跨设备同步）。
   - 项目 `proxy_config` 随工作区 SQLite 备份与恢复，但备份导出与恢复前均剥离代理 URL 中的 `user:pass@` 凭据。
