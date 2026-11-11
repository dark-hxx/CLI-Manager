# 验证记录

## 范围与根因

现场 `remote-manager/data/run/api.sock` 的 Windows tag 是 `0x80000023`（AF_UNIX），不是符号链接。停止服务后磁盘节点可能保留，迁移层原先拒绝全部重解析点，导致完整数据树复制被阻断。修复只在迁移生产端区分固定应用端点，不删除源节点、不放宽通用链接保护。

发现清单已在 design.md 记录：目录复制/启动 pending 激活、端点类型与活性、cc-connect 空闲操作锁、切换 IPC、设置错误映射与双语字典。终端、供应商、Hook 与数据库结构确认无关。

## 已执行

- `cargo test --manifest-path src-tauri/Cargo.toml --lib app_paths:: --quiet`：25/25 通过，其中 9 项新回归使用真实 Windows AF_UNIX 或目录联接，覆盖残留/活动端点、普通同名文件与目录、未知路径、固定根边界、大小写和非空目标；原路径/迁移/失败根保留回归继续通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib cc_connect::tests::data_storage --quiet`：6/6 通过，覆盖空闲锁生命周期、并发/启动/锁损坏、真实测试受管进程和授权进程。不停止用户进程，夹具进程由独立测试 Job 清理。
- `node --test scripts/dataStorageMigration.test.mjs`：6/6 通过，执行实际前端错误函数，读取真实中英字典，检查持久化错误和 IPC 接入顺序/参数。
- `npx tsc --noEmit`：退出 0。
- `cargo check --manifest-path src-tauri/Cargo.toml --quiet`：退出 0。
- `npm run check:architecture -- --strict`：1298 个源码文件，0 超限、0 违规。
- `git diff --check`：通过。
- `npm run tauri:build:local -- --bundles nsis --ci`：退出 0，仅生成一个 NSIS bundle；桌面 Vite（7074 modules）与 Web Vite（2058 modules）均成功，Rust release 构建成功。大资源块/动态导入和链接器消息为非致命警告，不在本轮扩大优化范围。

## 修正与工具边界

- 首次编译发现显式模块路径及测试夹具 import/参数问题，已修复。首次原生测试 24/25 通过，剩余失败是 `mklink` 夹具的 cmd 引号，不是迁移断言；改为对随机临时路径显式引用后 25/25 通过。
- GitNexus 未暴露，按契约/源码/Git diff 降级，并刷新 codebase-memory 索引：ready，43744 nodes / 117427 edges。抽查确认新端点函数进入 copy -> migrate -> pending 链路；图谱风险标记 CRITICAL/HIGH 已告知用户。
- memory `detect_changes` 列出预期已跟踪文件，但没有返回 impacted_symbols，也未列出未暂存新文件；不把空结果当“无影响”，提交前复核所有暂存文件和实际调用链。

## 未覆盖

- 未安装程序、未调用真实数据目录切换、未修改 Bootstrap 或真实源目录、未启动或关闭用户服务。实际安装和设置页中英文切换/迁移重启由用户测试。
- 未执行 Unix 平台测试；Windows GUI 为本轮验证范围。未知或权限不明端点保守拒绝，不提供自动强制迁移。

## 提交和交付

用户已批准提交本轮修复/测试/Trellis/变更说明后构建 1.4.3 NSIS；不推送。沿用 local release 缓存，但会重新构建当前前端与包含迁移修复的后端，不复用旧版主程序。

- 实现提交：`935bc61f`，`fix(app-data): exclude stopped runtime sockets from migration`。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.3_x64-setup.exe`。
- 文件大小：30,176,989 bytes；最后修改时间：2026-10-10 15:23:20（Asia/Shanghai）。构建前同路径不存在，无旧包覆盖；旧 1.4.2 文件未改动。
- SHA256：`45301EF3976B09C15CBE4BF49F52993BB2B9689DC96431C00D0F57DDC9F534C2`。
- 只读核验四个新产物的 PE header 均为 x64、ProductVersion 均为 1.4.3；主程序包含本次端点探测错误码，前端产物包含新增映射和翻译。
- 核验实际 `release/nsis/x64/installer.nsi`：引用本次主程序及三个辅助 exe，并包含当前 Web index.html、JS/CSS 和 worker；不安装或运行安装器验证。
- 重试步骤：退出旧应用，安装本包，停止终端/远程服务/扫码授权等任务，选择独立空目录并执行迁移重启。原目录保留，不手工删除 api.sock；若仍报错保留完整路径与错误信息。
