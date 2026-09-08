# Service extraction checkpoint

- History: 33 named production modules; 117 tests in 9 responsibility groups plus shared fixtures. Original Tauri handlers stay in history.rs.
- cc-connect: 16 named production modules; 65 tests in 6 groups plus shared fixtures. CcConnectManager process orchestration stays in the facade; public command/type entry points retained.
- Windows desktop full library regression: 1237 passed, 1 existing ignored, zero failed, final run without warnings.
- Relevant Node source contracts: 29 passed. They now inspect actual moved modules; CRLF normalized for the existing smart-title command marker.
- AST audit against 33916085: 1604 production and 630 test/fixture function bodies across 18 owners matched after formatting/relative-path normalization. Production literals retained. Earlier test extraction dedented multiline fixtures; that test-only indentation is excluded from comparison. New test extraction preserves literal indentation.
- Unix wrapper string uses Rust line continuations and explicit escaped indentation; content comparison preserves the original text. Unix-only branches were inspected but not compiled on a Unix target in this Windows environment.
- Architecture: 894 handwritten source files, 6 oversized files (all frontend), no new violations. Rust layer relocation and strict zero-debt acceptance remain parent work.
- GitNexus lacks most Rust history symbols and may resolve same-named frontend types. Source/contract analysis supplemented the index; public history shape and high-risk cc-connect path facades remain unchanged.
- Cleanup makes test-only imports explicit. sqlx traits needed by request_logs/route_usage are now imported at their actual use sites, not inherited from the former large parent.
