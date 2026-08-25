# 实施计划

1. 添加 Windows shell 路径规范化及脚本值安全校验。
2. 用 `cmd /d /s /c call` 修复 `.cmd/.bat` 空格路径，保持其他启动器分支。
3. 为 cc-connect 进程输出接入现有多编码解码。
4. 扩展 Rust 单测与真实代理 E2E，覆盖空格、verbatim、透传、退出码和危险字符。
5. 更新 `[TEMP]` 发布记录、契约和 verification。
6. 完成全量验证并复用缓存仅构建 NSIS。
