# 根因与设计

根因：本地命令只关闭 updater 产物，Cargo 仍使用 release 的 opt-level=3、codegen-units=1 和 fat LTO；release 默认无增量。采样 rustc CPU 时间持续增加，正在编译主库，不能把耗时当死锁。

发现清单：package.json → tauri-cli.mjs → Tauri → cargo build --bins --release；beforeBuildCommand 构建桌面/Web；本地 JSON 只覆盖 updater。Windows dev proxy 预构建仅 dev 执行。GitNexus 无 scripts/tauri-cli.mjs 索引，降级契约和定向搜索。新增独立入口，不改已有函数，风险局限本地打包命令。

采用子进程环境覆盖 release 参数（LTO off、opt 2、16 单元、incremental true），复用既有 Tauri wrapper。当前 CLI 无独立 --profile 开关，避免硬塞 Cargo profile 导致 bundler 找错路径。CARGO_TARGET_DIR 默认 src-tauri/target/local；用户已有 target-dir 环境配置时在其下加 local。不修改父进程环境、不新增依赖、不改变正式配置。

场景：Windows/macOS/Linux，首次/重复构建，路径含空格，传入 target/bundles/no-bundle，已有 Cargo 环境覆盖，spawn 失败/非零退出，正式发布与 local 缓存隔离。窗口/分屏/WSL/Hook 不涉及应用运行行为。
