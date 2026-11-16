# 实施与验证

用户已要求“更新代码 修复”；按本设计直接实施，无未决产品问题。

- [x] 编写真实 PowerShell 打包夹具测试，先确认旧脚本在无 release 资源副本时失败。
- [x] 独立解析二进制、resources 和 Web dist 输入；先校验，再复制到现有布局。
- [x] 运行打包测试，覆盖 ZIP 内容、嵌套路径、参数及失败不破坏输出。
- [x] 将定向回归接入 Windows 发布构建，并验证工作流顺序。
- [x] 更新 V1.5.1 CHANGELOG、Windows 功能板块及打包契约。
- [x] 运行既有本地打包配置测试与严格架构检查；分析 graph 变更，记录验证结果和限制。

验证命令：

- `node --test scripts/package-portable.test.mjs`
- `node .github/scripts/release-workflow.test.mjs`
- `node --test scripts/tauri-build-local.test.mjs`
- `npm run check:architecture -- --strict`
- `node .gitnexus/run.cjs detect-changes --scope all --repo .`

不需要应用 i18n 检查或 Rust 全量构建：此次不修改产品文案或 Rust；PowerShell 回归直接运行实际打包入口，并逐项核对 ZIP 文件内容。
