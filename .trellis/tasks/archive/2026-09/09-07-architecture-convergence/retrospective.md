## Bug Analysis: Migration test and import-path assumptions

### 1. Root Cause Category
- C — Change Propagation Failure: the old cursor helper was deleted in July but its source-reading test survived. Module moves also require updating test transpilation stubs and dynamic fixture paths, not just production imports.
- E — Implicit Assumption: a dot in a locale/worker basename was initially treated as a source extension. Resolution must distinguish `.zh-CN`/`.worker` from `.ts`.

### 2. Why Fixes Failed
1. Exact source-file path replacement did not cover template-built test paths or import strings embedded in transpilation fixtures.
2. Globally replacing an import specifier was ambiguous when several owners used the same old relative name; owner-specific fixture mappings were needed.
3. Initial all-scope graph detection exceeded the Git tool buffer on unstaged mass deletions. Staging complete renames allowed meaningful review without changing tool limits.

### 3. Prevention Mechanisms
| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Dependency audit | Compare every resolved edge and all non-path module bytes | Done |
| P0 | Full static baseline | Run source-contract tests before and after moves; distinguish pre-existing failures | Done |
| P1 | Spec | Record suffix, test-owner and Rust namespace rules in directory/architecture contracts | Done |

### 4. Systematic Expansion
- Checked static/dynamic/inline-type imports, worker/asset URLs, CSS, Rust embedded resources and command registry routes.
- Preserved module/load graphs instead of introducing facade barrels or moving visibility ancestry.
- Kept UI/e2e checks outside agent execution and recorded a human checklist.

### 5. Knowledge Capture
- Updated frontend directory/architecture and Markdown contracts, backend directory rules and AGENTS.md.
- No `src/templates/markdown/spec` exists in this application repository; no duplicate template tree created.
