# Tap 對話時間軸：設計

## 決策

1. **沿用維護者的協定與元件。** 資料來源維持 `terminal.transcript` + `includeDetails`：`tool_call` 的 `text` 是完整的結構化參數（物件為排版過的 JSON，Codex 修補等字串參數保留原字串），`tool_result` 是輸出，`reasoning` 是思考摘要，以 `callId` 配對。所有新呈現都由前端從這些欄位推導，不新增 operation、不改主機匯出。
2. **在前端推導工具呈現。** 工具摘要、diff、修補分組、任務清單以純函式實作（移植自 Tap-Code 的規則），方便單元測試；參數被截斷或無法解析時退回維護者原本的輸入／輸出呈現，不猜測。
3. **保留折疊規則。** 過程與每個步驟預設折疊，即時更新不自動展開，手動展開狀態沿用維護者的保留方式。
4. **伺服器保留期。** `terminal.transcript` 的結果只是當下的快照：結束兩分鐘後刪除該 operation 與它的 `operation.updated` 事件（依被刪 operation 的 ID 選事件），等待或執行中的保留；每 30 秒最多清一次。
5. **目錄快取的根因修正。** 會話檔目錄快取依「來源＋根目錄」分別保存（60 秒），索引刷新的全量掃描只更新 `*` 那一份，驗證檔案時讀的依來源快取因此可能落後最多 60 秒：`/clear` 後 catalog 已看得到新檔，`history_get_session` 的驗證卻回 `session_file_not_indexed`。修正在 `discovery.rs`：全量掃描寫入時清掉同一組根目錄下各來源的快取。

## 已知限制

- 每段內容最多 4000 字：大修改的 diff 只顯示截斷前的部分並標示；本輪 +N −M 只計入完整的修改。
- 前端不讀取工具結果的錯誤旗標（主機未匯出），步驟不顯示成功或失敗，沿用維護者「不由有輸出推斷成功」的規則。

## 情境矩陣（fix-triage-guide §5）

| 維度 | 行為 |
|---|---|
| CLI Hook | 已安裝：精確綁定後顯示；未安裝：維持維護者的未綁定提示 |
| 執行環境 | 本機與 WSL 沿用歷史索引與主機匯出；目錄快取修正對兩者相同；SSH 維持不支援 |
| Worktree | 依註冊 ID 與 cwd 精確綁定，與主倉庫相同；不讀 git |
| 多會話／Workspan／分屏 | 前端依會話各自保存展開與搜尋狀態；不影響桌面 |
| `/clear`、`/resume` | 綁定換新會話 ID 後讀新紀錄；目錄快取修正讓新檔立即可讀 |
| UI 呈現模式、專注模式、視窗焦點與托盤 | 不影響：只與 `/tap/` 頁面本身有關 |
| 新舊主機 | 沒有 `includeDetails` 詳情的舊主機只顯示正文，新呈現自動不出現 |
| 中英文、淺色深色、手機與桌面 | 所有新文案雙語；diff 與輸出在各自區塊內捲動 |

## 影響範圍

前端只在 `apps/web-tap` 內擴充維護者的對話元件。伺服器新增 `storage/transcript_retention.rs` 並在建立轉錄 operation 時觸發清理。`discovery.rs` 的 `collect_session_files_with_force` 在全量掃描時多清除同一根目錄的依來源快取（其餘行為不變），新增 `tests/session_file_cache.rs`。GitNexus 在作者環境不可用，依契約與 grep 盤點；`collect_session_files_with_force` 的呼叫者為依來源讀取（驗證、刪除驗證、Kimi 測試）與索引刷新，修正只讓依來源讀取在全量掃描後重新掃描一次。
