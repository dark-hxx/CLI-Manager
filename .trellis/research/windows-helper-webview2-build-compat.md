# Windows helper WebView2 构建兼容

## 范围与授权

- 2026-11-12：用户授权从最新主干 `91012b69` 建独立修复分支，只修 Windows 构建阻断；沿用 1.5.0，验证后先本地提交再构建 NSIS，不安装、不推送。
- 分支：`fix/windows-helper-webview2-compat`，无远程上游。

## 根因与决定

桌面和 helper 是两个 Cargo 根，分别使用自己的锁文件；新增的内存优化代码直接依赖 WebView2 0.38/windows-core 0.61，而 helper 的 Tauri 2.12/Wry 0.57 返回 0.39/0.62 的 COM 类型，导致同一份库代码只在 helper 构建时出现 E0599。修复落在依赖解析边界，不修改 COM 调用或业务运行逻辑。

- 以桌面已验证的锁文件为解析基线重新解析 helper，保留 helper 自身根包及其构建依赖约束。
- 两根使用 Tauri 2.10.3、tauri-runtime/tauri-runtime-wry 2.10.1、Wry 0.54.3、WebView2 0.38.2；不新增平台依赖或修改 Cargo.toml。
- 不引入跨版本裸指针转换，不移除内存优化，不跳过三个 helper 构建。
- `scripts/tauri-build-local.test.mjs` 比较两份锁文件的六个宿主包版本，防止后续只更新一侧而回归。

## 发现清单与边界

- 已确认：`src-tauri/helpers/Cargo.lock` 是构建差异来源；`src-tauri/Cargo.lock` 和两份 manifest 保持不变。
- 已确认：`set_webview_memory_target` → blocking 调用 → optimize → IPC/信息栏存在 HIGH/CRITICAL 影响链；不改这些运行时函数。
- 已确认：正常 `beforeBundleCommand` 构建并复制 daemon、web-daemon、codex-proxy；保持该入口。
- 已确认无关：主程序/Web/Tap 源码、用户配置、数据库、Hook、孤儿进程判定与回收逻辑。
- 场景：Windows 主程序及独立 helper 必须都编译；旧 WebView2 Runtime 跳过不支持的接口语义不变；Linux/macOS 未在本机验证，不改平台条件分支。

## 验证与既有问题

- 原始主干：桌面/Web/Tap 类型检查和生产构建通过；Windows 主程序 release 通过，helper 在 `app_memory.rs:616` 的 COM cast 编译失败。
- 修复后：`cargo build --locked --manifest-path src-tauri/helpers/Cargo.toml --target-dir src-tauri/target/local/helper-binaries --release` 通过，三个 helper 均为真实构建产物。
- 构建回归测试及最终 NSIS 解包核验在交付时记录于本地 `.codex/master-20261112-*`。
- 上游既有问题不在授权范围：settingsStore.ts 2063 行、设置页跨域私有导入导致严格架构检查两项违规；图标测试仍期待 19 项而实际已为 20 项（原 52 项测试通过 51 项）。不得声称这些检查已全部通过。

## 工具降级

- GitNexus MCP/本地 runner 不可用，使用已刷新 codebase-memory 调用图、构建契约、两份真实锁文件和 Windows 编译错误/成功结果复核，不将空图结果视为安全证明。
- 离线 cargo metadata 在解析后因未缓存的其他平台 aes 包下载失败；随后直接以生成锁文件在 Windows 运行 `cargo build --locked --release` 成功，未依靠离线 metadata 的成功作为验收证据。
