## Bug Analysis: file explorer context menu edge clipping

### Bayesian update

| Hypothesis | Prior | Evidence after the first fix | Posterior |
|---|---:|---|---:|
| H1: nested transformed/overflow-hidden Portal ancestor clips the fixed wrapper | 45% | Source inspection supported it, but clipping persisted after the host moved under `document.body` | 5% as the sole cause |
| H2: fixed Radix content leaves the Popper wrapper with the wrong measured size | 45% | Radix source places fixed coordinates on a wrapper while `.context-menu` fixes its child; the new right/bottom screenshots match missing width/height collision data | 90% |
| H3: menu height/content or an unrelated panel z-index causes the loss | 10% | The visible loss changes with both horizontal and vertical edge position and is not covered by z-index behavior | 5% |

Confidence is above 90% for the combined two-boundary root cause. The discriminating evidence was the user's runtime screenshot after the body-level Portal change: it contradicted ancestor clipping as a complete explanation while preserving the exact failure predicted by an unmeasured Popper child.

### 1. Root Cause Category

- **Category**: B/E - Cross-layer contract plus implicit assumption
- **Specific Cause**: The application reused one `.context-menu` visual/positioning class for both manually positioned menus and Radix content. Radix owns fixed positioning on its Popper wrapper and assumes the content child participates in normal-flow sizing. The fixed child violated that undocumented boundary; the file panel's transformed clipping ancestor added a second independent boundary violation.

### 2. Why Fixes Failed

1. **Body-level Portal only**: incomplete scope. It removed ancestor clipping but left the Popper wrapper unable to measure the fixed child.
2. **Static Portal test**: test coverage gap. It proved DOM ownership from source text but did not assert Radix's wrapper/content positioning contract.
3. **Initial mental model**: focused on the visible panel clipping layer and did not inspect which Radix node actually owns floating coordinates until runtime evidence contradicted the first hypothesis.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | Give Radix root/submenu content a dedicated normal-flow positioning class while leaving manual menus fixed | DONE |
| P0 | Test coverage | Assert body-level Portal ownership, both Radix content classes, their relative positioning, and the unchanged base fixed style | DONE |
| P1 | Documentation | Record both Portal containing-block and Popper measurement contracts in frontend quality guidelines | DONE |
| P1 | Code review | Require longest-menu checks at all viewport edges and both dock directions for floating-menu changes | DONE |

### 4. Systematic Expansion

- **Similar Issues**: All consumers of the shared Radix wrapper—file editor tabs, Git tree, history Diff/file changes and terminal tabs—shared the measurement violation even if their usual trigger position did not expose it.
- **Design Improvement**: Keep visual styling shared, but separate library-owned positioning from manual coordinate positioning with a semantic class at the wrapper boundary.
- **Process Improvement**: A source-level Portal assertion is not sufficient evidence for floating geometry; verify both the containing block and the element that participates in size measurement.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/frontend/quality-guidelines.md` with the two positioning contracts.
- [x] Added corrected implementation and regression-test steps to this task.
- [x] Checked for `src/templates/markdown/spec/` and `.trellis/templates/markdown/spec/`; this repository has no matching template to synchronize.
- [x] Human runtime re-verification at all viewport edges before commit.
