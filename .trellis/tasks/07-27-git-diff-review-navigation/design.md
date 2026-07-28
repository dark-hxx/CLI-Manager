# Review Navigation Design

## Ownership

`GitDiffReviewDialog` 拥有目标列表和 active target；`useGitDiffController` 拥有 active target 内的 Hunk 索引。`GitChangesPanel` 只传入筛选结果、初始 target 和动作回调。

## Navigation Rules

- F7：当前 Hunk +1；若已到末尾，则选择下一文件并在加载后定位第一个 Hunk。
- Shift+F7：当前 Hunk -1；若已到开头，则选择上一文件并定位最后一个 Hunk。
- 没有 Hunk 的 fallback Diff 只参与文件导航。
- target 列表更新后优先保留相同 id；不存在时选择原索引处的相邻项。

每个 Hunk 的 Decoration Header 提供稳定 DOM anchor，Controller 调用 `scrollIntoView`，不通过脆弱的 CSS 文本查询定位。

## Preferences

新增 `gitDiffViewMode: "split" | "unified"`，默认 `split`；迁移非法值回默认，并加入 `syncSettings` preferences 域。
