# 实施计划

## 1. 后端数据根目录

- [x] 在 `app_paths.rs` 增加纯函数分发识别、默认路径、Bootstrap 路径与配置解析。
- [x] 在 GUI `run()` 数据层初始化前应用 pending switch，并固定本进程数据根目录。
- [x] 保持 `CliManagerDataPaths` 现有字段兼容以及 dev/install 文件名隔离。
- [x] 增加 Bootstrap 原子写入、启动错误与上次迁移错误记录。

## 2. 切换与迁移命令

- [x] 新增 app-data command 模块，提供 status / inspect / prepare switch IPC。
- [x] 校验绝对路径、canonical path、可写性、空目录、根目录和父子目录关系。
- [x] 后端确认 daemon 无 alive session并关闭 idle daemon。
- [x] 实现临时目录复制 + rename 的完整目录迁移；失败不切换 active root。
- [x] 覆盖恢复默认目录和自定义目录两种目标模式。

## 3. 路径消费者与安全 scope

- [x] Hook 失败日志统一走 `app_paths::logs_dir()`。
- [x] Tauri setup 动态允许当前数据根下的 `pets` 目录。
- [x] 移除静态 `$HOME/.cli-manager/pets/**` scope，保留 `$HOME/.codex/pets/**`。
- [x] 桌宠设置页展示实际托管路径。

## 4. 通用设置 UI

- [x] 新建独立 `DataStorageSection`，只在 Windows 显示并挂到通用页底部。
- [x] 展示分发、模式、当前路径和默认路径。
- [x] 使用现有目录选择器与应用内 Dialog，不使用原生 `window.confirm`。
- [x] 空目录提供迁移/不迁移/取消；非空目录只提供直接使用/取消。
- [x] 检查前端后台操作，并正确展示后端 daemon/task 错误。
- [x] 所有新增文案同步 `zh-CN` 与 `en-US`。

## 5. 更新策略

- [x] 后端版本信息识别 portable marker，返回 `distribution=portable`。
- [x] update store 扩展 portable 类型，保留检查但禁用下载/安装。
- [x] About 更新区为 portable 显示“查看 Release / 下载便携版”。
- [x] 保持 standalone 与 AUR 现有行为。

## 6. 便携产物

- [x] 添加 Windows PowerShell 组包脚本，复用 release 目录中的主程序、proxy 和 resources。
- [x] 生成 `portable.flag` 与版本化 x64 ZIP。
- [x] Release workflow 上传/校验 portable artifact，并更新 Release 安装表格。

## 7. 文档与交付

- [x] 更新 `CHANGELOG.md` 的 `V1.3.5`。
- [x] 更新 `docs/功能清单.md`。
- [x] 更新 App Data Persistence、App Startup、Tauri Updater 契约。
- [ ] 提交信息关联 `Refs #199`。

## 8. 自动验证

- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml app_paths --lib`
- [x] 增加并运行数据根解析、Bootstrap、迁移、非空目标、父子目录、失败回滚测试。
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`
- [x] `npx tsc --noEmit`
- [x] 运行 portable 组包脚本测试，检查 ZIP 含主程序、proxy、marker 和 resources。
- [x] 不主动运行 `npm run build`、`npm run dev`、`npm run tauri build` 或 `npm run tauri dev`。

## 9. 人工验证

- [ ] 安装版默认目录仍为 `%USERPROFILE%\\.cli-manager`。
- [ ] 便携版默认目录为程序旁 `data`。
- [ ] 安装版和便携版选择自定义空目录：分别验证迁移与不迁移。
- [ ] 非空目标无自动合并选项。
- [ ] 存在终端/后台任务时切换被阻止。
- [ ] 迁移后项目、模板、设置、会话、日志、缓存、附件、备份、桌宠可读。
- [ ] Hook 与 daemon 使用新目录；外部 `.claude` / `.codex` 路径不变。
- [ ] 便携程序与 `data` 整体移动后可继续使用。
- [ ] 安装版与便携版不能同时运行。
- [ ] 便携版更新按钮打开 Release，安装版仍可下载安装。
- [ ] 切换 `zh-CN` / `en-US` 后新界面文案完整，时间格式不变为 12 小时制。
