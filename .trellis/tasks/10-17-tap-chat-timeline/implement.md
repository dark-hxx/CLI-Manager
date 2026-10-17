# Tap 對話時間軸：實作清單

規格：`prd.md`、`design.md`、`.trellis/spec/backend/web-service-contracts.md`、`.trellis/spec/backend/history-index-contracts.md`。

- [x] 依使用者決定關閉 #288（另起協定的做法），改在維護者 `63bae0f`／`a6aeb76` 的方向上重做；新分支基於 `a6aeb76`。
- [x] 前端純函式：工具摘要與詳情推導（`tools.ts`）、diff（`diff.ts`）、Codex 修補解析（`patch.ts`）、ANSI（`ansi.ts`）、搜尋比對（`chatFind.ts`）、跳轉點（`turnRail.ts`）、捲動定位（`chatScroll.ts`），各有單元測試。
- [x] 前端元件：`ConversationStep`（步驟列與展開詳情，預設收起、刷新保留展開）、`ChatSearch`、`TurnRail`，接進維護者的 `Conversation`；收尾列加上完成時刻、用時與本輪 +N −M。`groupTurns` 不變；`ConversationActivity` 只加搜尋用的 `hit`。
- [x] 修正維護者對話頁讀取更早內容失敗後殘留閱讀錨點的問題並補測試。
- [x] 新增程式碼只標示來源，不寫授權說明（依使用者要求）。
- [x] 伺服器：`terminal.transcript` 結果兩分鐘保留期與節流（`storage/transcript_retention.rs`），依被刪 operation 的 ID 刪事件。
- [x] 歷史目錄快取：全量掃描後清除同一根目錄的依來源快取（`discovery.rs`），新增 `tests/session_file_cache.rs`。
- [x] 契約、TEMP changelog、功能清單、`apps/web-tap` 的 README／DESIGN。
- [x] 驗證：見 `verification.md`。
- [x] 推送到 fork 並開 [PR #289](https://github.com/dark-hxx/CLI-Manager/pull/289)（簡體中文說明、不含授權說明）；Windows 驗收交由維護者。
