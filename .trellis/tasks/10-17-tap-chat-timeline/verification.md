# Tap 對話時間軸：驗證紀錄

環境：作者機器為 Linux aarch64，Rust 1.99（`~/.cargo/bin`）、Node 24.19，依 `package-lock.json` 以 `npm ci` 安裝。沒有 GTK／WebKitGTK，`src-tauri` 主 crate 無法在本機編譯與測試。

## 已在本機確認

| 項目 | 結果 |
|---|---|
| `npm run tap:typecheck`、`npm run tap:test` | 通過；113 項測試，含維護者原有 67 項（`conversation.test.mjs`、`activity.test.mjs` 只補了新模組的依賴登記，斷言未改） |
| Tap 生產建置（`vite build`，輸出到 `/tmp`） | 通過 |
| 桌面 `npx tsc --noEmit` 與 `src/features/terminal/lib/*.test.mjs` | 通過；維護者的 17 項轉錄測試不受影響 |
| `cargo test --manifest-path apps/server/Cargo.toml` | lib 59、reconnect 5、tap_static 1 全數通過；新增 3 項（只清轉錄種類、保留期刪除範圍含執行中 operation 的事件保留、節流） |
| 伺服器 rustfmt | 本次改動的部分無差異（上游既有差異未重排） |
| `node ./scripts/architecture.mjs --strict`、`git diff --check` | 1433 檔、0 違規；無空白錯誤 |

## 以替代方式確認

- **歷史目錄快取（`discovery.rs`）**：把 `collect_session_files_with_force` 從原檔原樣抽出，配上簽名相同的替身型別編譯並測試（依來源快取在有效期內沿用；全量強制掃描後依來源讀取看得到新檔；別組根目錄不受影響）。同一個測試換成上游原版函式會失敗，確認修正有效。`src-tauri` 內另新增 `tests/session_file_cache.rs`，照既有 `kimi_source.rs` 的寫法撰寫，需在 Windows 上以 `cargo test` 執行。
- **真實工具參數**：以作者本機 Claude Code 與 Codex 紀錄（120 份）中的 12,783 個工具呼叫，照主機 `includeDetails` 的格式（鍵排序後排版、每段截到 4000 字）組成步驟交給 `stepView`：0 個例外；未能推導摘要的步驟全部是參數被截斷的情況（例如大檔 Write、長命令），依設計退回原本的過程卡。
- **Tap 介面**：以靜態頁面加無頭 Chromium 檢查淺色、深色、中英文、桌機與手機；搜尋只暫時展開命中的步驟，讀取更早內容時閱讀位置不跳。此為假資料，不等於真實 CLI。

## 需要維護者在 Windows 上驗收

1. `src-tauri` 編譯與 `cargo test`（含新的 `session_file_cache`）。
2. 本機與 WSL 的真實 Claude Code／Codex 會話：工具步驟摘要、diff、任務清單與收尾列；`/clear` 後對話頁立即跟上新對話。
3. 長時間開著對話頁時，伺服器資料庫不再增長。

## 已知限制（受主機匯出資料限制）

- 每段參數最多 4000 字：大的 Write／Edit 退回原本的卡片；主機依字母排序鍵，長 `content` 會排在 `file_path` 前面，被截斷時連檔名也看不到。
- 主機未匯出工具錯誤旗標與結束碼欄位：只在輸出明確寫出失敗（結束碼、錯誤標記、拒絕執行）時標示失敗。
- 修改沒有行號（主機未匯出檔案位置）；命令輸出取的是開頭而非結尾。
