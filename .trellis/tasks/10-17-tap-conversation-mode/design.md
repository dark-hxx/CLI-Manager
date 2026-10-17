# Tap 對話模式第一階段：設計

## 資料流

```
瀏覽器 /tap/ 對話頁
  └─ POST /api/operations  kind=terminal.transcript_events {projectId, worktreeId?, sessionId, cursor? | before?}
       伺服器：驗證註冊 ID 與位元組位置 → 依能力轉發 → 順便清理過期的轉錄 operation
  └─ 桌面 renderer：webManagement → webTranscriptEvents
       1. transcriptSession：專案、Worktree、本機 PTY 必須對上（與 v1 相同）
       2. 第一次：fetchBoundSessionSummary 查歷史索引取得 file_path / project_key / cwd，驗證 ID、來源、cwd；快取，查不到退避 5 秒
       3. invoke history_live_transcript_read（Rust）
            validate_session_file_ref + 檔名含會話 ID → transcript-core::read_window
       4. 讀檔後再驗一次綁定；結果 ≤ 650 KiB
  └─ 結果經 operation.updated 回到瀏覽器，前端 mergePage → buildTimeline → 時間軸
```

## 決策

1. **專用解析器，不改既有歷史解析。** 既有解析器取不到正文就整行丟棄（`history/message_content.rs:89-92`），Claude Code 一個 block 寫一行，所以思考與多數工具呼叫進不了訊息；它同時服務歷史頁與 catalog，改動影響太大。改為新 crate `src-tauri/transcript-core`，移植 Tap-Code 的 `transcript.rs`、`codex.rs`、`rewinds.rs`（純 Rust，只依賴 serde、serde_json、memchr），在 Linux 上可以編譯與測試。
2. **移除與平台或 Tap-Code 前提綁死的部分。** 依價目表算的花費（本倉庫有自己的 `model_prices`，後續階段由主機計算）、Codex 以 `/proc` 找 rollout、`state_*.sqlite`、config.toml 預設值、啟動參數解析。`rewinds.rs` 的 inode 快取鍵改成路徑加建立時間。
3. **輪詢沿用 operation，不新增推送 frame。** 推送需要改協定 crate、伺服器路由、daemon 與 in-process 兩條路徑並升 `DEVICE_PROTOCOL_VERSION`（嚴格相等），而 `web_daemon.rs`、`web_device.rs` 已接近 2000 行，且桌面 crate 無法在作者環境編譯。Tap-Code 自己也是約 1.2 秒輪詢；增量讀取後每次成本很小。保留期解決資料庫膨脹。推送留待之後評估。
4. **新 operation 而非改舊的。** 伺服器可以獨立部署，與桌面版本可能不同：舊伺服器上的舊頁面仍呼叫 v1，新桌面端保留 v1；新頁面遇到舊桌面端（沒有新能力）時明確提示更新。
5. **路徑查詢只做一次。** 抽出 `fetchBoundSessionSummary`（原本在 `fetchLatestProjectSessionDetail` 內）重用，只查 SQLite catalog，不讀會話內容；以 `PTY ID + CLI 會話 ID` 為鍵快取，`/clear` 換了會話 ID 就會重查。
6. **Rust 串接層做薄。** command 只做路徑驗證與 `spawn_blocking`，讀取與解析都在 crate 的 `read_window`；串接程式碼以樁（stub）框架做型別檢查。

7. **審查後的補強。** 獨立審查實驗重現了幾個邊界問題，修正如下：
   - 單一行的事件就超過一頁的總量（例如 Codex 一次修補許多大檔）時先降級：拿掉 diff 與彩色輸出、長文字截到 4000 字、結果標成已截斷，避免讀取永遠卡在同一個游標。
   - 有 `uuid` 欄位但沒有值的事件（Codex 的工具與訊息）補上 `pos:<行首位置>:<序號>`，前端的 key 不再用流水號，讀進更早內容時不會錯位。
   - 新會話的紀錄檔可能不在歷史模組 60 秒的目錄快取裡，驗證回報 `session_file_not_indexed` 時強制重掃一次（`validate_session_file_ref_rescanned`）。
   - 退避從查詢結束才開始算；查詢本身失敗回報錯誤，不當成新對話；unavailable 頁面不動前端手上的游標；已有內容時連續失敗顯示重試提示。

## 視窗與大小

- 上限針對「輸出的事件量」而不是原始讀取量：每頁事件序列化後最多 512 KiB（`Limits.output`）。
- 最新一段與往前一頁掃描最多 4 MiB 原始紀錄，超過事件預算時從最舊的行捨棄，`start` 落在第一個保留行的行首，往前翻頁可無縫接上。
- 增量讀取最多 8 MiB 新內容，達到事件預算就停在那一行之前並標記 `partial`，前端立即續讀；落後超過 8 MiB 才改回最新一段並要求重置。早期版本以 512 KiB 限制原始讀取，貼了截圖、數 MB 的提問行會因此觸發重置而消失，已改掉。
- 至少保留一行，讀取一定前進；單行上限 8 MiB；各類文字沿用 Tap-Code 上限，diff 另加總字元上限，單一事件最壞約 0.55 MB。桌面端最後再檢查 ≤ 650 KiB，超過回報 `transcript_too_large`。

## 情境矩陣（fix-triage-guide §5）

| 維度 | 本階段行為 |
|---|---|
| CLI Hook | 已安裝：SessionStart 綁定後即可讀；未安裝：`unbound`，提示並保留終端；只裝一個：依會話來源各自判斷 |
| 執行環境 | 本機 PowerShell/CMD/Pwsh：歷史根目錄內的 Windows 路徑；WSL：沿用歷史索引的 WSL 路徑與 UNC；Bash 同本機；SSH 與遠端接力：拒絕 |
| Worktree | 主倉庫與 Worktree 依註冊 ID 與 cwd 比對；Worktree 已遺失時 `worktree_missing`；`.git` 是檔案不影響（不讀 git） |
| 多會話 | 每個 PTY 各自綁定與快取；切換會話時前端清空並重讀 |
| `/clear`、`/resume` | hook 回報新的會話 ID 後快取鍵改變，前端看到 `agentSessionId` 改變即重讀 |
| 視窗焦點、最小化、托盤 | 由桌面主機處理 operation；renderer 在背景時的計時節流需實機確認 |
| 分屏 | 不影響：以 PTY ID 對應，與分屏位置無關 |

## 影響範圍

GitNexus 在作者環境不可用，依規範改以契約與 grep 盤點：`fetchLatestProjectSessionDetail` 的 5 個呼叫者行為不變（純抽取）；`webManagement` 的 v1 轉錄只拆出 `transcriptSession`，邏輯不變；伺服器只新增種類、驗證與保留期；`Storage` 新增節流欄位；能力清單兩處同步新增；`validate_session_file_ref` 抽出帶強制重掃旗標的內部函式，原函式行為不變（`collect_session_files` 即不強制的版本），另增 `validate_session_file_ref_rescanned` 只供即時轉錄使用。沒有資料庫遷移，也沒有改 CLI 設定或 hook。
