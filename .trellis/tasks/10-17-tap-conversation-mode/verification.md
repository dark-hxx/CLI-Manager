# Tap 對話模式第一階段：驗證紀錄

環境：作者機器為 Linux aarch64，Rust 1.99（`~/.cargo/bin`）、Node 24.19、npm 11.17，依 `package-lock.json` 以 `npm ci` 安裝。沒有 GTK／WebKitGTK，`src-tauri` 主 crate 無法在本機編譯。

## 已在本機確認

| 項目 | 指令 | 結果 |
|---|---|---|
| 解析器 crate | `cargo test --manifest-path src-tauri/transcript-core/Cargo.toml` | 51 通過（35 個移植自 Tap-Code，16 個新增：上限、高階 API、回應契約、rewinds 身分、輸出預算與續讀、單行降級（含審查重現的 Codex 大修補情境）、位置 key） |
| 解析器格式與 lint | `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` | 皆無問題；子代理另以 `x86_64-pc-windows-msvc` 目標跑 clippy 無問題，crate 內沒有任何 `std::os::unix` 或平台條件編譯 |
| 伺服器 | `cargo test --manifest-path apps/server/Cargo.toml` | lib 60、reconnect 5、tap_static 1，全數通過；新增 5 項：新 operation 的位元組位置驗證、能力對應、保留期刪除範圍、節流、只清轉錄種類 |
| 伺服器格式 | `cargo fmt --manifest-path apps/server/Cargo.toml --check` | 本次改動的部分無差異；`config.rs`、`lib.rs`、`ws.rs`、`tests/reconnect.rs` 與 `api.rs`、`storage.rs` 的既有段落有上游原本就存在的格式差異，未擴大重排 |
| 伺服器 clippy | `cargo clippy --all-targets -- -D warnings` | 3 項錯誤皆為上游既有程式碼（`upsert_device_hello`、`validate_device_hello` 參數過多，`load_file_config` 參數型別），與本次改動無關 |
| 桌面型別檢查 | `npx tsc --noEmit` | 通過 |
| 桌面整合測試 | `node --test src/features/terminal/lib/*.test.mjs` | 22 通過；新增 11 項（精確綁定與路徑快取、未綁定與不支援、cwd 不符與退避、查詢慢時退避從結束起算、查詢失敗回報錯誤、待寫出的新對話、檔案消失後重查、游標驗證、跨專案拒絕、讀檔期間換綁定、讀檔失敗後重查） |
| 歷史查詢重構 | `node --test src/features/history/lib/historyRequests.boundSummary.test.mjs` | 4 通過；其中詳情查詢的斷言也對上游原始版本執行並通過，確認抽取前後行為一致 |
| Tap 型別檢查與測試 | `npm run tap:typecheck`、`npm run tap:test` | 通過；74 測試通過（時間軸、頁面驗證與合併、unavailable 不歸零游標、任務缺狀態、ANSI、diff、跳轉點、搜尋） |
| Tap 打包 | `vite build`（輸出到 `/tmp`，不覆寫 `apps/web/dist`） | 通過 |
| 架構檢查 | `node ./scripts/architecture.mjs --strict` | 1445 檔，0 個超過 2000 行，0 違規 |

## 以替代方式確認

- **桌面串接層（`live_transcript.rs`）**：以 stub 框架（`history_roots` 與 `validate_session_file_ref` 換成簽名相同的替身）實際編譯原檔（只去掉 `#[tauri::command]`），並端到端測試：檔名帶綁定 ID 時能讀出事件、游標之後無新內容時為空、ID 不符或空白時回 `transcript_session_mismatch`；新檔不在目錄快取時強制重掃一次即可讀到，其他驗證錯誤照常拋出。`Cargo.lock` 以 `cargo metadata` 更新，只新增此 crate 一筆。
- **真實資料契約檢查**：以本機 Claude Code 與 Codex 自己的紀錄（Claude 73 份、Codex 29 份，最大 569 MB 與 304 MB），經 `read_window` 輸出每頁，再交給 Tap 前端的 `parsePage` 與 `buildTimeline`，只輸出統計：
  - 最新一段加往前 5 頁：Claude 140 頁、Codex 46 頁；0 個形狀錯誤、0 頁超過 650 KiB（最大 512 KiB）、建立時間軸 0 錯誤。審查修正（位置 key、單行降級）後重跑，結果相同。
  - 從較早位置以游標增量讀到底（最大各 3 份）：Claude 9 頁中 3 頁、Codex 8 頁中 2 頁因事件總量上限分段（`partial`），每頁游標都前進。
  - 前端只略過 `cost`（Claude 累計花費）與 `mode`（審批模式）事件；Tap-Code 也只把它們用在選項列與用量，屬於第三階段，屬刻意不顯示。
- **Tap 介面**：前端子代理以假資料頁加無頭 Chromium 檢查淺色、深色、手機、中英文，以及摺疊、diff、ANSI、搜尋、跳轉點、讀取更早、未對上、舊版主機、失敗重試；執行中輪詢間隔 1200ms，終端輸出不使請求重疊。此為協定 fixture，不等於真實 CLI。

## 獨立審查

送出前另以子代理做唯讀審查（安全、競態、契約一致性、規範），確認路徑驗證無法繞過、沒有 XSS（無 `dangerouslySetInnerHTML`，react-markdown 不解析原始 HTML 且擋 `javascript:`）、清理 SQL 只刪已結束的轉錄 operation 與其事件、`fetchBoundSessionSummary` 抽取前後行為一致。實驗重現並已修正 6 項：單一行事件超過上限時讀取卡住、Codex 事件以流水號為 key 導致錯位、新會話紀錄檔不在 60 秒目錄快取、退避在查詢很慢時失效與查詢錯誤被當成新對話、unavailable 頁面把游標歸零、任務項目缺狀態被丟掉；每項都補了測試。

## 需要維護者在 Windows 上驗收

1. `src-tauri` 主 crate 編譯與 `history_live_transcript_read` 的實際路徑驗證（本機只以 stub 驗證）。
2. Windows 本機與 WSL 的真實 Claude Code／Codex：hook 綁定後對話頁出現時間軸、`/clear` 後跟上新對話、WSL 紀錄經歷史索引的 UNC 路徑讀取。
3. 長時間使用時伺服器資料庫不再增長（轉錄 operation 兩分鐘後清除）。
4. 安裝包與 portable 含新的 Tap 前端；真實手機瀏覽器操作。

## 已知限制

- 未安裝 CLI Hook 的新會話無法綁定，對話頁維持「還沒對上」提示（設計如此，不加 `--session-id`）。
- `rewinds` 以路徑加建立時間辨識檔案；NTFS 在 15 秒內刪除再建立同名檔時會沿用建立時間，若新檔更長可能沿用舊的分支掃描結果（機率低）。
- Codex 圖片相關邏輯仍指向 Tap-Code 的 `.tap-code/uploads/`，第一階段不顯示圖片，第四階段處理。
