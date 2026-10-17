# Tap 對話模式第一階段：實作清單

規格：`prd.md`、`design.md`、`.trellis/spec/backend/web-service-contracts.md`。
執行：主代理負責伺服器、桌面串接與契約；移植工作分給兩個子代理（Rust 解析器、Tap 前端），各自只動自己的目錄。

- [x] 抽出 `fetchBoundSessionSummary`（`historyRequests.ts`），`fetchLatestProjectSessionDetail` 改為呼叫它，行為與日誌不變。
- [x] 新增 `src-tauri/transcript-core`：移植 Tap-Code 的 Claude／Codex 解析與回退分支；移除依價目表的花費、`/proc`、sqlite、config 預設與啟動參數；inode 改為路徑加建立時間；每個事件欄位設上限；`read_window` 為主機端轉接，以 `web_limits()` 讀取。
- [x] `notice` 事件改為穩定代碼加英文後備，解析器不輸出介面語言文字。
- [x] 新增 `history_live_transcript_read`（`features/history/live_transcript.rs`）：沿用 `validate_session_file_ref`，檔名須含綁定的會話 ID；登記於 `lib.rs`，`Cargo.toml`／`Cargo.lock` 新增 crate。
- [x] 桌面 `webTranscriptEvents.ts`：精確綁定、路徑快取與 5 秒退避、游標驗證、讀檔後重驗、650 KiB 上限；`webManagement.ts` 登記並共用 `transcriptSession`。
- [x] 能力 `terminal.transcript_events` 同步新增於 `web_device.rs`、`web_daemon.rs`、伺服器 kinds 與能力對應。
- [x] 伺服器：新 operation 的 payload 驗證；轉錄 operation 保留期與節流（`storage/transcript_retention.rs`）。
- [x] `/tap/` 前端：移植時間軸、工具步驟、思考、計畫、命令輸出、收尾列、跳轉點、搜尋與增量輪詢；能力判斷與更新提示；notice 代碼的中英文文案。
- [x] 契約更新：新 operation、視窗與大小、保留期、錯誤矩陣、Good/Base 案例、必測清單。
- [x] TEMP changelog、功能清單、`apps/web-tap/README.md`。
- [x] 整體驗證：transcript-core、伺服器、桌面型別檢查與整合測試、Tap 型別檢查與測試、嚴格架構檢查；串接層以 stub 框架編譯與測試。
- [x] 依前端回報與真實資料檢查修正：輸出總量預算取代原始讀取上限（增量讀取分段續讀、`partial`）、`missing` 區分待寫出與對不上、notice 代碼化。
- [x] 獨立審查的 6 項發現全部修正並補測試：單行降級、位置 key、新檔強制重掃、退避計時與查詢失敗、unavailable 不歸零游標、任務項目缺狀態。
- [ ] 提交與 PR：等使用者確認後再進行。
