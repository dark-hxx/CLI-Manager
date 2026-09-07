# 实施计划

1. 为 daemon 输出聚合提取可测试的有界批处理逻辑，补充 40 KiB + 40 KiB 回归测试。
2. 在 `useTerminalDisplay.ts` 增加模块级公平调度器，替换每 display 独立 RAF。
3. 扩展 `terminalReplay.test.mjs` 的 manager stub 和 display 工厂，覆盖跨终端单帧限流、公平性、commit 顺序和取消。
4. 更新 `CHANGELOG.md` 的 `[TEMP]`。
5. 运行 Rust 定向测试、Node 终端测试、TypeScript、fmt、cargo check 和 GitNexus 变更检测。
