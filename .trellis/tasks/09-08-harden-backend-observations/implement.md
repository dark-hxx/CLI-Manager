# Implementation Plan

- [x] 从源观察文档生成逐项 ledger，映射到工作流、符号、GitNexus 风险和验证方式。
- [ ] 批次 A：脱敏、日志、路径、symlink、身份/权限与备份恢复安全（除需身份/权限契约项外完成）。
- [ ] 批次 B：子进程、WSL、daemon、SSH、Hook 和订阅生命周期的 deadline/cancel（公共 deadline 与高置信调用点完成）。
- [ ] 批次 C：文件/HTTP/协议缓冲、pending map、Live Server 和候选集合容量限制（除 Live Server/SSH 全局容量外完成）。
- [ ] 批次 D：原子持久化、跨 Home 补偿、import/issue 部分提交语义和状态准确性（snapshot/global apply 完成）。
- [ ] 批次 E：平台行为统一、配置就绪语义和测试真实性/隔离（本地可安全验证项完成）。
- [x] 每批遵循 impact → 失败测试 → 实现 → 定向检查 → ledger 更新，不并行编辑重叠符号。
- [x] 完成所有受影响 crate 编译/测试、脚本测试、改动文件格式化和严格架构检查。
- [x] 汇总无法在 Windows 安全验证的 Unix/真实环境项目，保留为明确未完成项。
