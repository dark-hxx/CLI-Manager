## Bug Analysis: Git 变更文件和目录无法拖放到应用内终端

### 1. Root Cause Category

- **Category**: C — Change Propagation Failure, with a D — Test Coverage Gap.
- **Specific Cause**: File Explorer already produced the terminal file-drag payload, while GitChangesTree / GitTreeNode only handled click, context-menu, stage, and discard interactions. The target terminal contract was correct, but Git file and directory rows never entered it.
- **Confidence**: High. Source inspection found the complete target drop-zone and path-resolution chain, and no Git file/directory-row pointer producer. After the change, both sources use the same producer Hook.

### 2. Why Fixes Failed

No prior implementation attempt was present. A terminal-side Git special case would have been a surface fix because a terminal cannot receive a payload that the Git source never creates.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | Extracted one useTerminalFilePointerDrag producer lifecycle for File Explorer and Git Changes. | DONE |
| P0 | Contract documentation | Documented source-root, payload, target-resolution, button exclusion, and test rules in frontend component guidelines. | DONE |
| P1 | Regression coverage | Added static assertions for shared Hook use, Git row binding, action-button exclusion, payload creation, and terminal commit. | DONE |
| P1 | Reuse guardrail | Added a code-reuse guide pattern that prohibits per-panel terminal-drag lifecycles. | DONE |
| P1 | Boundary guardrail | Added cross-layer guidance that the source provides metadata while the terminal target resolves relative versus absolute text. | DONE |

### 4. Systematic Expansion

- **Similar Issues**: Search shows pointer lifecycle calls now live in the shared Hook; FileExplorerSidebar retains only its legacy browser DataTransfer path for OS/browser compatibility. Any future file-path source must use the shared Hook.
- **Design Improvement**: Source-specific behavior is limited to the item descriptor and optional non-terminal callback. This prevents Git, search results, or a future panel from duplicating terminal focus, click suppression, or drag cleanup.
- **Process Improvement**: Feature and bug discovery should enumerate all UI producers of a shared target contract, not only the component where the target behavior was first implemented.

### 5. Knowledge Capture

- [x] Updated frontend component-guidelines.md with the executable shared source contract.
- [x] Updated code-reuse-thinking-guide.md with the source-panel interaction lifecycle pattern.
- [x] Updated cross-layer-thinking-guide.md with source metadata versus target path-resolution ownership.
- [x] Confirmed src/templates/markdown/spec does not exist, so no template mirror needs synchronization.
- [x] Added focused static regression coverage.
- [x] Expanded the same source contract to Git directory rows, including compressed-chain display paths and directory trailing separators.
- [ ] Commit the specification updates: intentionally not performed because the current user authorization covers implementation, not a commit.
