# Diff Generation Options Design

## Contract

```ts
type GitDiffWhitespaceMode = "exact" | "ignore-eol" | "ignore-all";
interface GitDiffOptions {
  whitespace: GitDiffWhitespaceMode;
  contextLines: 3 | 10 | 20;
}
```

Transport 边界负责默认值和归一化。后端再次验证枚举，不能信任 TypeScript。

## Local Mapping

- exact：不设置 ignore flag。
- ignore-eol：libgit2 `ignore_whitespace_eol`；CLI 路径使用 `--ignore-space-at-eol`。
- ignore-all：libgit2 `ignore_whitespace`；CLI 路径使用 `--ignore-all-space`。
- contextLines：libgit2 `context_lines`；CLI 路径使用 `--unified=<N>`。

Desktop Diff 构造从巨型 `commands/git.rs` 抽到专用 `commands/git_diff.rs`；Tauri command 名保持 `git_get_file_diff`。

## SSH Compatibility

保留 `gitDiff` 作为 exact+3 legacy 请求。新增 `gitDiffWithOptions` 和 capability `gitDiffOptions`，Agent 基线从 `0.1.4 / protocol 1.7` 升到 `0.1.5 / 1.8`。Desktop 只在非默认选项时使用新请求；缺少 capability 时返回可翻译的升级错误。

Agent Diff 构造进入 `ssh-agent/src/git_diff.rs`，现有 `git.rs` 只保留 dispatch 和共享 Git runner。

## Revert Safety

忽略空白后的 patch 不再代表完整工作区差异，因此后端 payload 必须强制 `canRevertHunks=false`。前端 capability 与后端结果同时约束入口，不能只做视觉隐藏。
