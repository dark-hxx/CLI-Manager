# Windows Codex 启动器空格路径修复设计

## 命令构造

- 新增 Windows 路径规范化助手，将 `\\?\D:\...` 还原为 `D:\...`，将 `\\?\UNC\server\share` 还原为 `\\server\share`；只用于必须交给 CMD/PowerShell 解析的脚本路径。
- `.cmd/.bat` 改为 `cmd.exe /d /s /c call <launcher> <args...>`。`call` 作为 `/c` 后固定的首命令，使 Rust 对后续路径参数的引用在空格目录下仍被 CMD 识别，并保留批处理返回码。
- `.ps1` 继续使用 `powershell.exe -NoProfile -File <launcher>`，但同样使用无扩展前缀路径。
- `.exe` 保持直接 `Command::new`，Windows API 原生支持空格与扩展路径。

## 安全

- shell 脚本路径及参数在进入 CMD/PowerShell 前继续拒绝已有元字符，并补充双引号、CR/LF，防止打断参数边界。
- Provider secret 仍只在环境变量，命令字符串和错误日志不包含密钥。

## 输出编码

- `cc_connect::output_text` 先使用 `crate::text_encoding::decode_text`；其 UTF-8 快路径无额外猜测，非 UTF-8 使用已有 chardetng/encoding_rs 支持，失败才使用 `from_utf8_lossy`。
- 保持 stdout 优先、stderr fallback 的原行为。

## 发现清单

- `codex_app_server_proxy::codex_command`：根因和主要修改点，影响 app-server 与 passthrough。
- `codex_launcher_from_environment`：提供真实启动器路径，复核、不修改。
- `cc_connect::probe_remote_codex_app_server`：捕获代理失败，复核、不改变 fail-closed。
- `cc_connect::output_text`：本地化诊断乱码修改点，同时服务版本/help/update 输出。
- `shell_resolver::silent_command`：仅设置无窗口 flag，复用。
- `scripts/codexAppServerProxy.e2e.test.mjs`：改为真实空格目录和 verbatim 路径，验证代理二进制。
- cc-connect 源码、Provider、会话/Hook、SSH 远端启动：确认无关，不修改。

GitNexus MCP/CLI 未暴露且离线 npm 无缓存，使用 cc-switch 契约、`rg`、源码调用链与 E2E 降级。`codex_command` 影响全部本地 Codex 远程托管，风险 HIGH，必须保留 EXE/脚本、app-server/透传和注入防护测试。
