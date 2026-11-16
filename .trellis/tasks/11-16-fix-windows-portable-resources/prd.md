# V1.5.1 Windows 便携包资源输入修复

## 目标与背景

恢复 Windows 发布工作流的便携 ZIP 制作，让已构建的 Classic Web、Tap 及运行资源完整进入便携包。

Action 43822127758 / job 133148643340 在 Web 构建、MSI/NSIS 打包与更新签名上传成功后，因 `scripts/package-portable.ps1:39` 要求 `src-tauri/target/release/apps/web/dist/index.html` 而失败。Web 构建输出实际位于仓库 `apps/web/dist`；打包脚本将 Cargo 二进制目录同时当作所有资源的必需输入目录。

## 需求

- R1：四个可执行文件继续从指定的 release 输入目录读取，资源目录与 Web 输出目录可独立指定，并有与现有构建链路一致的默认值。
- R2：ZIP 内保留单一 `CLI-Manager/` 根、四个可执行文件、`portable.flag`、`resources/`、`apps/web/dist/`，完整保留 Classic/Tap 的嵌套脚本、字体和其他资源。
- R3：缺少任一必需文件或目录、参数非法时明确失败，且不得先删除已有 ZIP 或 staging 输出。
- R4：发布工作流运行真实 PowerShell 打包回归，V1.5.1 变更记录与对应功能清单同步更新。

## 验收

- A1（R1/R2）：无 Cargo 资源副本的干净夹具能打包；ZIP 中每个文件的内容与指定源一致，旧 Cargo 资源副本不进入 ZIP。
- A2（R1）：相对路径、绝对路径、空格目录、自定义 release/Web/资源目录均可用；版本前缀正确规范化。
- A3（R3）：四个二进制、Classic/Tap HTML、两个 assets 目录及资源目录的缺失分别导致失败，已有输出保持原内容。
- A4（R4）：打包回归、工作流前置验证、既有本地构建配置测试通过；独立运行严格架构检查，记录既有问题。

## 范围

不调整 MSI/NSIS 资源映射、应用运行时或更新签名。用户随后明确删除远程 V1.5.1 标签并授权重新推送修复代码与发布标签；后续仅在远程标签仍指向本任务上次发布时，以精确 lease 更新 V1.5.1 并检查云端回归结果。
