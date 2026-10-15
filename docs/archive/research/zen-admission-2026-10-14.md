# Zen 准入拒絕：2026-10-14 UTC 的差分診斷

> 帶日期的診斷證據；「正式修復」「未驗證」描述當時狀態，不是目前待辦清單。
> 現行實作與後續驗證界限見[協定分析紀錄](../../protocol-notes.md)。

## 結論

已在 **Node 原生 fetch + 本套件的真實 provider** 上取得匿名非空回覆，不需要改 TLS 指紋、HTTP 客戶端或使用真實 API key。

這次失敗不是單一條件：套件仍使用舊端點、session 的時間區段是雜湊而非時間編碼，且無工具呼叫的補位工具只有空 schema 與佔位描述。這三項舊假設在本次測試中各自造成拒絕。只換端點不足以修復套件。

這是特定時間與模型的觀察，不是上游公開的准入契約。沒有取得新 inference 的准入原始碼；不能宣稱已知道它的完整判斷式。

## 範圍與安全

- 時間：2026-10-14 UTC（紀錄完成時為本地 2026-10-15，UTC+8）。
- Windows、Node `v24.13.0`、OpenCode `1.19.0`、本機 Bun `1.3.13`、插件 `0.3.4`。
- 唯一實測模型：`muse-spark-1.3-contributor-free`，Responses 通道。
- 認證：只有字面匿名 `public`，不讀取使用者憑證。
- OpenCode 使用隔離的 HOME、USERPROFILE、XDG 目錄與空工作目錄，停用外部插件、自動更新與專案設定。
- 真實請求只問短訊息；多數成功對照收到標頭就取消串流。最終 provider 驗證則讀取完整結果，要求非空文字與正常停止。
- 診斷程式共嘗試 25 個上游模型請求；其中一次對照遇到傳輸逾時，不列為任何原因的證據。沒有重試該逾時。
- 標頭與 body 只在診斷程式記憶體中傳遞，沒有保存或輸出原始內容。輸出只有 allowlisted 狀態、欄位名稱、工具名稱、布林與大小。
- 未安裝、更新、啟停 DSH，未改 profile、憑證、正式 provider 或已存在的相容性報告。

## 第一手來源

1. [官方 provider 改名與端點更換，PR #54767](https://github.com/anomalyco/opencode/pull/54767)：2026-10-12，`/zen/v1` 改為 `/inference/v1`。
2. [現行公開 proxy](https://github.com/anomalyco/opencode/blob/fe1717b3090d181624338e41457da49a4250135e/packages/console/app/src/lib/inference-proxy.ts)：認證、免費層存取等責任交給新 inference。
3. [Zen 路由改成轉發，PR #54563](https://github.com/anomalyco/opencode/pull/54563)：2026-10-11，包含匿名免費模型。
4. [官方 identifier 實作，固定到 v1.19.0 對應 commit](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/schema/src/identifier.ts)：時間乘以 `0x1000` 加計數，descending 取反後抽取 6 bytes，再加 14 個 base62 字元。
5. [models.dev API](https://models.dev/api.json)：本次讀取的 `opencode.api` 是 `https://opencode.ai/inference/v1`。這是活資料，並非永久快照。
6. 本地 [provider 原始碼](../../../src/zen-provider.ts)：`BASE_URL` 仍為 `/zen/v1`；`sessionHeader()` 的前 6 bytes 來自 SHA-256；匿名空工具請求由 gate 補位。

## 方法

先用本機 HTTP 接收器接收隔離官方 CLI 生成的請求，回覆本機診斷錯誤，**不向上游轉發**。完整請求留在記憶體中，再交給 Node 子程序做上游對照。

成功與失敗對照均由同一個 Node fetch 實作送出。所有變化逐項指定；交換 session 時同步 `x-opencode-session`、`x-opencode-session-id` 和 `prompt_cache_key`，避免把親和欄位不一致誤判成 ID 的問題。

早期整份標頭/body 交叉交換得到兩個 403，但同時破壞了 session/cache 一致性，**不拿它證明標頭與 body 各自有問題**。後面的單項對照才是有效證據。

## 差分結果

### 1. 端點

同一份官方請求、同一個 Node 客戶端，只替換 URL 路徑：

| 路徑 | 結果 |
| --- | --- |
| `/zen/v1/responses` | 403，FreeTierError |
| `/inference/v1/responses` | 200，收到回覆 |

因此，之前「官方 CLI 直連成功，Node 轉發失敗」不能單獨證明 TLS 差異；本次舊、新路徑本身就能改變結果。不能據此宣稱所有歷史差異都已被解釋。

### 2. Session ID

基準為新端點的成功官方請求。

| 唯一變更或一致性變更組 | 結果 |
| --- | --- |
| 改套件 UA | 200 |
| 加套件 `x-stainless-*` | 200 |
| 改套件 request ID | 200 |
| 改套件 session ID，同步 session-id 與 cache key | 403 |
| 套件 session/request ID 尾段不變，使用官方時間前綴並維持欄位一致 | 200 |
| 套件標頭，使用一致的官方 session/request/project 身份與 cache key | 200 |

套件的 hash 前綴只是滿足字元格式，不是官方時間編碼。這個差異是可致拒絕的，而不是猜測。

最後又用本機依官方演算法生成的 **descending 時間前綴**，保留套件 session 尾段，在真實 provider 路徑取得回覆。因此成功不是依賴複製某個官方已登記 session 的隱藏證明。

**界限：** 尚未測量允許的 ID 時間範圍，也未分別測試 ascending、過期時間、未來時間或長會話；不能推廣為完整的時間驗證規格。request ID 的時間前綴不需要修正即可成功。

### 3. 工具定義

基準為新端點的成功官方請求，身份與親和欄位保持不變。

| 變更 | 結果 |
| --- | --- |
| 官方 11 個工具 | 200 |
| 只保留官方完整 `read` + `bash` | 200 |
| 改成套件補位工具清單 | 403 |
| 完整 `read` + `bash`，只把描述改為 `stub` | 403 |
| 完整 `read` + `bash`，只把 parameters 改為空 object schema | 403 |
| 只把官方 input 換成套件的短訊息 input | 200 |

因此不是必須送 11 個工具，也不是必須帶官方完整系統提示詞。**單有工具名稱已不足以通過這次准入；描述與 schema 的改變都會改變結果。**

尚未逐字縮減描述或逐欄刪除 schema，因此不能聲稱上游要求完整逐字匹配、不能列出最小必要字串或 schema 欄位，也不能據此推定 DSH 原生工具定義一定被拒絕。

## 真實套件路徑驗證

沒有替換 provider 的序列化或串流解析器。使用既有 `zenProvider().streamSimple()`：

1. 原本的空工具短訊息請求，舊端點：403。
2. 同一份序列化請求只換新端點：仍是 403。
3. 提供官方完整 `read`／`bash` 定義，只換新端點，仍用套件 hash session：403。
4. 在暫存 fetch 診斷接縫中換新端點與 session 時間前綴，同步 cache key：200，provider 收到非空文字，`stopReason: stop`。
5. 改為本機自行生成時間前綴：再次 200、非空文字、`stopReason: stop`。

最後一次經 allowlist 輸出的訊號：

```json
{"label":"fresh-session-prefix","direction":"descending","timestampGeneratedLocally":true}
{"label":"real-provider-real-read-bash","status":200}
{"label":"real-provider-real-tools-result","status":200,"replied":true,"stopReason":"stop"}
```

本機診斷工具留在忽略版本控制的 `.artifacts/zen-admission-2026-10-14/transport-check.mjs`。它包含本機絕對路徑，不是發布用或跨平台腳本。**會消耗匿名額度，只能明確授權後執行**：

```powershell
bun .artifacts/zen-admission-2026-10-14/transport-check.mjs --fresh-ids-check
```

該命令先在本機擷取一次官方請求，然後以 Node 在 provider 路徑發出一次上游請求；不是實際 DSH host 驗證。

## 修復範圍與未驗證事項

- 正式修復至少要更新端點、session 的時間區段與穩定親和策略，以及無工具請求的補位策略。
- 端點更換需同時處理模型目錄、main/compat、fetch/Node HTTP 守衛的作用範圍與既有快取記錄，不能只改某一個呼叫 URL。
- 不能把官方工具定義盲目塞給 DSH：模型看到的參數與執行端語意必須一致；尤其 Windows 的 `pwsh`／`bash` 改名。
- 長 session 是否過期、所有免費模型、Chat Completions、真正 DSH adapter、工具執行往返、標題與壓縮均未驗證。
- 沒有修改正式程式碼，也沒有完成回歸測試或發布；成功是 **provider 診斷接縫** 的成功，不是已安裝套件已修好。
- 本次未調整 TLS 指紋即可成功，排除了它作為這個已重現案例的必要修復；不等於證明上游永遠不使用 JA3／JA4 或其他風控訊號。
