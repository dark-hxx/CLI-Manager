# Implementation plan

- [x] 规划审核获准后 task.py start，按 trellis-before-dev 加载相关规范。
- [x] 针对待改符号运行 GitNexus impact，报告调用者、流程和风险。
- [x] 复现映射失焦和双模型冲突，核对预览与 materialize 的值来源。
- [x] 修复行身份及模型投影；隐藏全局指纹，保留内部校验。
- [x] 定向前端回归测试和 npx tsc --noEmit；涉及 Rust 时定向 cargo test 与 cargo check。
- [x] 独立运行 npm run check:architecture -- --strict；trellis-check 跨层核验。
- [x] 实际验证中英文、连续输入和预览；用户在交付后确认“验证通过”。
- [x] 更新 CHANGELOG.md（V1.4.0）、docs/功能清单.md 供应商板块及必要契约。

## Validation record

- 前端 13 项定向测试通过：nativeProviderEditing、nativeProviderConfigView、nativeProviderGlobalView、nativeProviderDetailView。
- npx tsc --noEmit 通过。首次因本地缺少已声明的 html-to-image 失败，补齐已有依赖后通过；package.json/package-lock.json 无改动。
- cargo check 通过。Rust 文档回归 12/12、既有 Codex 写入回归 5/5 通过；覆盖模型投影、未知字段、密钥保护和无效文档。模型投影保留行内注释，前导注释以公共合并后文档为保留基线。
- 最终严格架构检查通过（980 文件、零超限、零违规）；git diff --check 通过。
- 桌面人工验收：2026-09-11 用户确认“可以提交，验证通过”；代理未启动 Tauri。
- 所有测试使用虚构配置，不应用供应商或改写用户真实 CLI Home。
- 代码实现、自动化检查与用户验收完成，已获准提交和收尾。
- 提交前 GitNexus detect_changes 已执行；旧路径索引未映射到变更符号，因此以当前 Git 文件范围和已完成的定向测试复核，不将零符号解释为零影响。
