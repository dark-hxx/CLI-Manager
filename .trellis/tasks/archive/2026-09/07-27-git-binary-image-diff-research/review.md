# Self Review

## Scope

- 任务仅形成当前行为研究和 No-Go ADR。
- 未修改产品代码、依赖、规格、CHANGELOG 或功能清单。

## Acceptance

- [x] 记录文本、非 UTF-8、tracked/untracked 二进制和超限矩阵。
- [x] 覆盖 Desktop、WSL、SSH、快照和旧 Agent。
- [x] 说明图片预览不能表达 Git old/new revision 的原因。
- [x] ADR 明确不新增任何图片或二进制 Diff 文件类型。
- [x] 明确拒绝 data URL 核心契约、SVG 渲染、hex editor、二进制 RPC 和新依赖。
- [x] 不创建当前父任务下的后续实现切片。

## Findings

1. 原研究稿提出了 `text/image/binary` 判别联合与三个实施切片，违背已确认的文件类型范围。
   - 修正：改为 Accepted No-Go ADR，并删除所有当前路线中的实施建议。
2. 现有图片预览看似可复用，但它只读取当前工作区路径，无法提供 HEAD/index/worktree 双侧对象。
   - 修正：明确仅视觉布局可能复用，数据与安全契约不可复用。
3. Desktop 与 SSH 对 untracked 二进制存在错误/文本标记差异。
   - 处理：作为现状和残余差异记录；本任务不改变产品行为。

## Verification

- [x] fast-context 定位 Desktop、WSL、SSH Diff 和文件图片预览触点。
- [x] 使用契约与 `rg` 核对二进制标记、文本 payload 和图片读取边界。
- [x] 文档明确本轮文件类型支持保持现状。
- [x] `git diff --check` 和 Trellis context 校验在提交前执行。
- [x] 无产品文件或依赖变更，因此无编译/运行测试要求。
