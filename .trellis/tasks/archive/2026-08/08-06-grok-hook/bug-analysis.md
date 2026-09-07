# Bug Analysis: Grok 供应商替换完整 Home

## 1. Root Cause Category

- **Primary: C — Change Propagation Failure**：Codex 已修复为保留真实 Home，但同一供应商 scope 机制中的 Grok 分支仍沿用“生成配置目录并替换 Home”的旧实现。
- **Secondary: E — Implicit Assumption**：实现把 `GROK_HOME` 当作供应商配置路径；实际上它同时拥有 Hook、MCP、sessions、skills、plugins 和其他用户状态。
- **Boundary: B — Cross-Layer Contract**：后端返回 `generatedHome`，前端 DTO 强制要求它，PTY 再注入环境；任何单层修补都会保留身份分裂。

## 2. Why Earlier Fixes Were Incomplete

1. Codex 修复只覆盖 `CODEX_HOME`：虽然识别了完整 Home 不能被替换，但没有横向审计 Grok 的同构分支。
2. 旧 Grok 单元测试只断言临时配置包含 endpoint/key，没有验证真实 Home 中 Hook/history 是否仍可见，因此错误行为被测试固化。
3. 历史与 Hook 消费层本身工作正常；若在各自读取处增加临时目录 fallback，只会制造更多不一致根目录。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | Grok scope 只保存 manifest/key，通过 env + CLI 参数覆盖；不再生成或注入 Home | DONE |
| P0 | Compile-time | DTO 将 Grok `generatedHome` 要求替换为 `grokModel`，迫使前后端调用点同步 | DONE |
| P0 | Tests | 断言快照不创建 Grok Home、环境保留 `GROK_HOME`、模型替换拒绝注入字符 | DONE |
| P0 | Executable spec | 在 provider domain contract 增加 Grok real-Home 七段式合同 | DONE |
| P1 | Runtime probe | 使用已安装 Grok 的 `inspect` 验证进程覆盖下真实 Hook/MCP/skills 仍被发现 | DONE |
| P1 | Graph review | GitNexus impact/detect-changes | BLOCKED: LadybugDB shadow-page recovery failure; used contract + `rg` fallback |

## 4. Systematic Expansion

- **Similar Issues**：任何 `*_HOME` 环境变量都必须先判定它是完整运行时身份还是单一配置路径；Codex/Grok 已覆盖，Claude 使用官方 `--settings` 不替换 Home。
- **Design Improvement**：供应商隔离应发生在 provider-owned endpoint/key/model 字段，而不是完整 CLI Home。
- **Process Improvement**：修复一个 CLI Home 后必须横向检查所有供应商分支，并把 Hook 已安装/未安装、历史存在/不存在、项目/Worktree/全局纳入场景矩阵。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/backend/ccs-provider-domain-contracts.md`。
- [x] 更新 `CHANGELOG.md` 与 `docs/功能清单.md`。
- [x] 增加 Rust/TypeScript 回归测试。
- [x] 检查模板同步目标；本仓库不存在 `src/templates/markdown/spec/`，无可同步副本。
