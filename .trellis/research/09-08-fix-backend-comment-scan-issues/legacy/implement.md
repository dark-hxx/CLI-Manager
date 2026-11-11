# Implementation Plan

- [x] 建立逐项观察台账，标注归属子任务、证据、严重度、符号和验证命令。
- [x] 先完成确认缺陷子任务，避免与广泛加固交叉修改同一符号。
- [ ] 按安全/数据完整性、进程边界、协议/资源、测试真实性四批实施加固。
- [x] 每批运行 GitNexus 影响分析、失败测试、最小实现和定向验证。
- [x] 汇总运行受影响 crate checks、脚本测试、`npm run check:architecture -- --strict`。
- [x] 运行 GitNexus detect changes 或记录不可用原因及替代审查。
- [x] 更新 `CHANGELOG.md` 与 `docs/功能清单.md` 的 `TEMP` 条目并完成父任务验收。
