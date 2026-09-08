# 研究图片与二进制 Diff

## Goal

核对当前 Git Diff 的文件类型边界，并形成是否扩展图片、Office、视频、音频和一般二进制比较能力的架构决策。本任务只产出研究文档，不修改产品代码。

## Confirmed Decision

本轮 **不实现** 任何新的非文本 Diff 能力，文件类型支持保持现状。图片预览与 Git Diff 继续是两个独立能力，不创建后续实施任务。

## Requirements

- 记录 Desktop、WSL、SSH 对 tracked/untracked 二进制文件的实际返回行为。
- 说明现有图片预览为什么不能直接复用为 Git old/new 对象比较。
- 明确不新增 Diff payload 判别联合、图片内容句柄、二进制传输、SSH capability 或依赖。
- 明确不支持图片、SVG、PDF、Office、压缩包、音视频、3D、十六进制和专有格式 Diff。
- 保留现有文本 Diff、二进制错误/文本标记、只读 fallback 和整文件操作边界。
- 输出 No-Go ADR、风险、场景矩阵和未来重新评估的前置条件。

## Acceptance Criteria

- [ ] `research.md` 包含当前支持/降级/拒绝矩阵及代码依据。
- [ ] Desktop、WSL、SSH、tracked、untracked 和快照行为均有说明。
- [ ] ADR 明确保持 `GitFileDiffPayload` 文本契约，不新增文件类型能力。
- [ ] 现有图片预览的路径、revision、传输和安全差距已说明。
- [ ] 风险和未来重启条件明确，但不创建实施切片。
- [ ] 本任务只产生 Trellis 文档，不修改 `src/`、`src-tauri/`、依赖或产品文档。

## Out Of Scope

- 图片并排、叠加、滑块、像素热区或动画逐帧比较。
- SVG、PDF、Office、压缩包、音频、视频、3D 或专有格式查看/比较。
- 通用十六进制 Diff、二进制编辑和二进制 Patch。
- Git blob 内容句柄、二进制 RPC、SSH 能力扩展和缓存服务。

## Risk

研究变更风险为 LOW。被拒绝方案本身风险为 HIGH：双侧大对象、远程传输、解码炸弹、不可信 SVG 和 WebView 内存峰值均需要独立安全设计，不能作为文本 Diff 的顺带扩展。
