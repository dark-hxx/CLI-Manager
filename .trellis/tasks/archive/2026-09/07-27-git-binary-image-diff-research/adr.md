# ADR: 保持 Git Diff 文本文件类型边界

- 状态：Accepted
- 日期：2026-07-28
- 决策：No-Go

## Context

现有 Git Diff 契约是有界文本 payload。图片预览则是按工作区路径读取当前文件，两者的数据来源、安全边界和生命周期不同。扩展图片或通用二进制比较需要同时修改 Desktop、WSL、SSH Agent、Transport 和前端 Viewer，风险远高于本轮文本审阅优化的目标。

## Decision

- 保持 `GitFileDiffPayload` 为文本契约。
- 保持现有 `Binary files ... differ`、`binary_file`、raw fallback 和超限语义。
- 不增加图片、SVG、PDF、Office、压缩包、视频、音频、3D、hex 或一般二进制 Diff。
- 不复用文件预览 data URL 作为 Git 对象契约。
- 不增加 Git blob 内容句柄、二进制 RPC、SSH capability、缓存层或依赖。
- 不创建本父任务下的实现切片。

## Consequences

### Positive

- 本地、WSL、SSH 和旧 Agent 契约不变。
- 不引入双侧对象内存、解码炸弹、不可信 SVG 和远程大帧风险。
- 共享 Diff Viewer 继续专注文本审阅，职责和文件规模可控。

### Negative

- 用户无法在 CLI-Manager 内比较图片像素或查看二进制元数据差异。
- Desktop 与 SSH 对部分 untracked 二进制提示仍存在现有差异。

这些缺口是明确接受的产品边界，不在本任务中用临时 UI 或协议兜底。

## Rejected Alternatives

1. 文本 payload 内嵌 base64：扩大 JSON 和 WebView 内存，类型语义错误。
2. 直接复用文件图片预览：只有当前路径，没有 Git revision 双侧对象。
3. 只做前端图片并排：无法安全取得 HEAD/index/SSH 旧侧内容。
4. 只显示通用二进制 metadata：仍需新增跨环境对象探测契约，且不属于本轮价值目标。
5. 预先加入判别联合或 capability：无实现消费者的预埋接口是无效复杂度。

## Revisit

未来只有在用户明确指定单一格式、对象读取安全契约和跨环境硬限制后，才通过新的父任务重新决策。本 ADR 不授权任何隐式实现。
