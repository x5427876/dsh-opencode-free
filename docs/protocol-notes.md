# OpenCode CLI 協定分析與 Zen 准入

本插件目前的實作依據來自維護者分析 OpenCode CLI 原始碼，並以官方 CLI
請求與本插件 provider 做差分驗證。本文區分原始碼依據、實測結果與未驗證推論；
它不是上游公布的第三方存取契約。

使用與設定見[使用指南](usage.zh-TW.md)；術語見 [CONTEXT.md](../CONTEXT.md)。

## 證據如何閱讀

| 證據 | 能證明什麼 | 不能證明什麼 |
|---|---|---|
| 官方原始碼 | 指定版本的 CLI 如何組出身份、工具與請求 | 未公開 inference 服務的完整准入規則 |
| 單項差分實測 | 指定時間、模型與客戶端下，某項變更是否改變結果 | 所有模型、平台與未來版本都會相同 |
| 本地 fixture | 插件改寫、串流還原與錯誤處理符合測試案例 | 真實 DSH 或匿名上游一定可用 |
| 真實 DSH 相容性驗證 | 報告所列環境與模型的實際結果 | 未列入或未完成的範圍也已通過 |

## 原始碼依據

- **端點遷移：** 官方 [PR #54767](https://github.com/anomalyco/opencode/pull/54767)
  記錄 `/zen/v1` 改為 `/inference/v1`；[公開 proxy 實作](https://github.com/anomalyco/opencode/blob/fe1717b3090d181624338e41457da49a4250135e/packages/console/app/src/lib/inference-proxy.ts)
  將驗證與免費層存取交給 inference 服務。公開 proxy 不等於完整准入原始碼。
- **Session ID：** 固定到 OpenCode v1.19.0 對應 commit 的
  [identifier 實作](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/schema/src/identifier.ts)
  使用時間與計數組成前綴，descending 取反後抽出 6 bytes，再加隨機尾段。
  僅符合 `ses_` 字元格式，不代表符合時間編碼。
- **本插件對應：** [zen-provider.ts](../src/zen-provider.ts) 的 `BASE_URL`、
  `sessionHeader()`、`applyAnonymousToolGate()` 與 `swapCompactionPrompt()`
  分別負責端點、行程內 session 身份、匿名工具調整與摘要提示。
  [index.ts](../src/index.ts) 負責 DSH adapter 註冊；工具仍由 DSH 執行。

## 已有實測結果

[2026-10-14 UTC 差分診斷](archive/research/zen-admission-2026-10-14.md)在 Windows、
Node 原生 fetch、匿名 `public`、Muse Spark 1.3 Responses 通道取得以下結果：

| 對照 | 當輪結果 |
|---|---|
| 同一官方請求，舊端點 → 新端點 | `403` → `200` 並收到回覆 |
| hash session 時間區段 → 官方演算法生成的時間區段，同步親和欄位 | 拒絕 → provider 收到非空文字 |
| 完整 `read`／`bash` → 只將描述改成 `stub` | `200` → `403` |
| 完整 `read`／`bash` → 只將 parameters 改成空 object schema | `200` → `403` |

這些對照推翻了「只有工具名稱就夠」與「session 只須符合字元格式」的舊假設。
Node 可以成功，也排除了調整 TLS 指紋作為這個重現案例的必要修復；不能據此斷言上游
永遠不使用 TLS 或其他風控訊號。完整方法、請求次數與限制保留在原診斷紀錄。

後續 [Windows 真實 DSH 報告](compat-reports/anonymous-tool-choice-2026-10-15-full/acceptance.md)
記錄 8 個選定模型通過 L0、文字、read 與 pwsh；4 個官方項目仍未分類，退出碼為 `2`。
這是本地工作樹套件的證據，早於 compat 包裝函式重構，不是 registry 套件或完整範圍的驗收。

## 目前插件採取的調整

- 以 OpenCode CLI 身份標頭、時間編碼 session ID 與串流發出匿名請求；
  同一 DSH session 在行程內保留身份，沒有持久登入。
- 匿名 Windows 請求將 `pwsh` 呈現為 `bash`，並成對轉換 schema、歷史與回傳呼叫的
  工具名稱及 `file_path`／`filePath`、`timeoutMs`／`timeout` 參數。
- 缺少 `read` 或 `bash` 時補上實質宣告與不可呼叫說明；這些補位工具沒有宿主執行能力。
  呼叫不存在的工具時，在交給 DSH 前拒絕；保留呼叫端明確指定的工具選擇。
- 工具說明配合 DSH 實際的純文字讀檔與 shell 能力，不宣告 OpenCode 的額外讀取能力。
- 符合條件的匿名上下文壓縮請求替換系統提示，承載對話的使用者訊息不變。
  這是現有行為，尚不能證明提示替換是目前准入的必要條件。
- 帶 key 的請求不套用匿名工具與提示改寫。傳輸攔截範圍與隱私風險見
  [README](../README.zh-TW.md#安全與限制)。

## 未驗證事項

- 最小必要描述、schema 欄位、session 可接受的時間範圍與長 session 行為。
- 完整官方免費對話模型範圍的相容性驗收。
- 上述實測未涵蓋的 Web、Desktop、上下文壓縮與其他平台。
- `403 FreeTierError` 的完整判斷式；不能單憑此錯誤歸因為 IP、key 或模型下架。

## 再次診斷時

1. 先固定 DSH、插件、官方 CLI、Node 版本與模型，確認對照組真的收到非空回覆。
2. 使用隔離的設定與匿名身份；擷取時只保留必要的去敏訊號，不保存憑證或對話。
3. 每次只改一個條件；若改 session，維持 session 標頭與 cache key 一致。
4. 分開記錄 HTTP 狀態、文字回覆、工具往返與完整目標範圍，不能以 `200` 代替成功。
5. 新結果加上日期與驗證限制；真實上游請求須先取得明確授權。

目前 `scripts/reverify.sh` 仍使用舊端點、隨機時間區段與空工具定義，屬歷史診斷工具，
不能作為現行准入或 key 的完成驗證。完整宿主驗證依[相容性驗證指南](compat-run.md)。

## 歷史附錄

僅在追查舊結論時閱讀[歷史比較紀錄](archive/protocol-history.md)。其中的來源歸屬、
舊端點與已被推翻的假設不代表目前實作依據。
