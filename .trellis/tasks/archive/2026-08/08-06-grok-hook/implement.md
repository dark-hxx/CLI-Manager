# Implementation Plan

1. 更新 Grok scope snapshot/manifest：保存 Base URL 与模型，不生成临时 Home。
2. 更新后端 PTY 环境注入：设置 `GROK_MODELS_BASE_URL`、`XAI_API_KEY`，不设置 `GROK_HOME`。
3. 更新前端 snapshot/launch DTO 与旧快照失效判断。
4. 增加 Grok `--model` 安全命令 helper，并接入新建及恢复会话路径。
5. 更新 provider domain contract 与 `[TEMP]` Changelog。
6. 验证：Rust 定向/provider 测试、前端 helper 测试、`npx tsc --noEmit`、`cargo check`，最后运行 GitNexus `detect_changes`（不可用则报告并以 git diff/grep 复核）。

## Risk Points

- 命令参数注入：只接受无控制字符/危险 shell 元字符的模型值。
- 旧快照恢复：必须强制重建，不能继续使用 `generatedHome`。
- resume 路径：必须与新建会话应用同一模型覆盖。
- WSL/Bash：环境变量由现有 PTY 环境边界传递，不再转换或注入 Windows Grok Home 路径。
