# 修复 KNX 项目文件路径目录跳转：实施计划

1. 在 `shell.rs` 增加受 Windows 条件编译保护的 Explorer 路径归一化并接入 command。
2. 添加该归一化的 Rust 单测，确保文件和目录调用复用同一原生路径。
3. 扩展终端文件链接脚本测试，锁定 `/F:/.../project.knxproj` 的前端契约。
4. 运行 focused tests、`cargo check` 与 `npx tsc --noEmit`。
