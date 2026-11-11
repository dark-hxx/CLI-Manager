# Implementation

1. 统一命令与配置入口，分离 host options / app tail / explicit resume。
2. 替换 Rust Web 校验为 TUI profile 校验，加入受管理 bridge patch。
3. PTY 输出 observer 绑定 UUID，terminal restore 保持 daemon 语义。
4. 清理 Web 生产代码，定向回归、跨层验证及实际 TUI 演练。
5. 文档/契约/版本记录与交付清单。
