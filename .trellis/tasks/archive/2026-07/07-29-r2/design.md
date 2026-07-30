# 技术设计

## 配置边界

GitHub Actions Repository Variable `R2_PUBLIC_BASE_URL` 是发布配置唯一来源。工作流在构建前调用 Node 脚本完成规范化和校验，并通过 `$GITHUB_ENV` 导出：

- `TAURI_CONFIG`：覆盖 updater 的 R2 首选 endpoint，保留 GitHub fallback。
- `VITE_R2_PUBLIC_BASE_URL`：编译进前端安装命令和官方清单识别逻辑。
- `CLI_MANAGER_R2_AGENT_MANIFEST_URL`：通过 Rust `option_env!` 编译进 SSH Agent 供应链默认清单地址。

本地构建没有这些变量时使用现有域名作为源码回退。发布工作流不允许缺失变量。

## 产物生成

新增一个小型 Node 工具统一校验 Origin、导出构建环境和渲染 `install-ssh-agent.sh`。源脚本保留明确占位符/默认值，发布到 GitHub 和 R2 前生成带本次 Origin 的副本，避免修改工作区源文件。

`prepare-r2-release.mjs` 继续负责把 `latest.json` 和 Agent manifest 中的版本化下载地址改写为 R2 地址，不承担构建环境配置。

## 安全与兼容

- 仅允许 HTTPS Origin，禁止用户名、密码、查询、片段和额外路径。
- updater 公钥保持在 `tauri.conf.json`，不进入动态变量。
- GitHub fallback 不变。
- 旧二进制的域名不会被追溯修改，旧域名需保留或重定向。
- 变量是公开域名，不应存为敏感密钥；仓库发布权限仍是构建链信任边界。

## 风险与回滚

- `savedManifestInput` 位于设置页组件链，GitNexus 评估 HIGH；仅替换官方主机判断来源，保持函数输入输出契约不变。
- 若动态注入失败，可移除构建配置步骤并恢复源码固定域名，不影响签名密钥或已发布产物。
