# 动态注入 R2 发布域名

## Goal

以 GitHub Actions Repository Variable `R2_PUBLIC_BASE_URL` 作为发布域名的唯一配置源，在构建时注入桌面更新器、SSH Agent 更新源、安装命令和发布产物，消除更换 R2 自定义域名时的全仓库硬编码维护。

## Background

- 当前 R2 发布清单已部分使用 `R2_PUBLIC_BASE_URL`，但工作流仍校验固定域名 `https://github.bwm.de5.net`。
- Tauri updater、Rust SSH Agent 默认清单、前端安装命令和安装脚本仍包含固定域名。
- 构建时注入与静态硬编码具有相同的运行时安全边界；Tauri 更新公钥不得动态配置。
- 已发布旧客户端仍携带旧域名，因此旧域名需要保留或重定向。

## Requirements

- R1：桌面正式发布工作流必须在构建前读取、验证并注入 `R2_PUBLIC_BASE_URL`。
- R2：仅接受无凭据、查询参数、片段和额外路径的 HTTPS Origin，统一移除末尾 `/`。
- R3：Tauri updater 的 R2 首选端点、Rust SSH Agent 默认清单地址和前端 SSH Agent 安装脚本地址必须由构建变量派生；GitHub Release 地址继续作为固定备用源。
- R4：上传至 GitHub Release 和 R2 的安装脚本必须写入本次构建的 R2 地址。
- R5：独立 SSH Agent 发布工作流必须复用同一验证与产物生成逻辑。
- R6：本地开发及未设置构建变量的非发布构建继续使用当前 R2 域名作为兼容回退；正式发布缺少变量必须失败，不得静默回退。
- R7：更新签名公钥保持静态，不通过 Actions Variable 注入。
- R8：新增或调整测试，覆盖合法域名、非法协议/凭据/路径，以及生成产物中的动态 URL。

## Scenario Coverage

- 桌面发布：Windows、macOS、Linux 矩阵构建使用同一 R2 Origin。
- SSH Agent 独立发布：tag 发布时使用同一 R2 Origin。
- 配置状态：变量有效时成功；缺失或非法时在构建/上传前失败。
- 更新来源：R2 为首选，GitHub Release 保持备用。
- 开发环境：本地构建无需配置变量，仍可工作。
- 兼容性：旧版客户端继续访问旧域名；部署方负责保留旧域名或 HTTP 重定向。
- 运行环境、窗口、分屏、Worktree、Hook 安装状态：本需求不改变这些行为，确认无关。

## Discovery List

- `.github/workflows/release.yml`：桌面构建、SSH Agent 产物、R2 上传与验证。
- `.github/workflows/ssh-agent-release.yml`：独立 Agent 构建、R2 上传与验证。
- `.github/scripts/prepare-r2-release.mjs` 及测试：R2 清单 URL 重写。
- `src-tauri/tauri.conf.json`：本地默认 updater endpoints。
- `src-tauri/src/ssh_agent_supply_chain.rs`：编译时 SSH Agent 默认清单与测试。
- `src/components/settings/pages/SshCliIntegrationDialog.tsx`：编译时安装脚本 URL 和官方清单识别。
- `scripts/install-ssh-agent.sh` 及测试：发布安装脚本内的默认 R2 Origin。
- `CHANGELOG.md`：记录 V1.3.3 开发者发布流程变更。
- `docs/功能清单.md`：不改变产品能力，确认无需更新。

## Acceptance Criteria

- [x] GitHub Actions 只需设置一次 `R2_PUBLIC_BASE_URL`，所有新发布产物和客户端更新入口都使用该 Origin。
- [x] 工作流不再以 `github.bwm.de5.net` 作为发布域名正确性的硬编码判断。
- [x] 非法或缺失的发布域名在正式构建前明确失败。
- [x] GitHub fallback 和静态签名公钥保持不变。
- [x] 相关 Node、TypeScript、Rust 检查通过；Ubuntu Actions 在上传前执行生成安装脚本的 `sh -n` 和内容校验。
- [x] `CHANGELOG.md` 的 `V1.3.3` 记录本次变更。

## Changelog Target

`V1.3.3`
