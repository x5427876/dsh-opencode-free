# OpenCode CLI 協定分析與 Zen 准入

本插件目前的實作依據來自維護者分析 OpenCode CLI 原始碼，並以官方 CLI
請求與本插件 provider 做差分驗證。本文區分原始碼依據、實測結果與未驗證推論；
它不是上游公布的第三方存取契約。

使用與設定見[使用指南](usage.zh-TW.md)；術語見 [CONTEXT.md](../CONTEXT.md)。

## 證據如何閱讀

| 證據 | 能證明什麼 | 不能證明什麼 |
|---|---|---|
| 官方原始碼 | 指定版本的 CLI 如何組出身份、工具與請求；仿照依據為 v1 線（[ADR-0006](adr/0006-opencode-v1-as-payload-reference.md)） | 未公開 inference 服務的完整准入規則 |
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

## 已觀察到的上游行為

2026-10-14、Windows、Node 原生 fetch、匿名 `public`、Responses 通道的差分診斷：

| 對照 | 當輪結果 |
|---|---|
| 同一官方請求，`/zen/v1` → `/inference/v1` | `403` → `200` 並收到回覆 |
| hash session 時間區段 → 官方演算法生成的時間區段，同步親和欄位 | 拒絕 → provider 收到非空文字 |
| 完整 `read`／`bash` → 只將描述改成 `stub` | `200` → `403` |
| 完整 `read`／`bash` → 只將 parameters 改成空 object schema | `200` → `403` |

結論：工具必須以官方描述與 schema 宣告，session 時間區段必須符合官方演算法。
那一輪 Node 成功，不代表 Node 一律被接受；TLS 密碼套件清單也是准入訊號，見下節。

## 官方 CLI 對照：免費層看什麼

2026-10-30、OpenCode CLI 1.19.5、台灣兩個不同出口 IP、模型 `deepseek-v4.1-flash-free`、
乾淨的資料目錄。每格一次請求，結果可能隨時間與額度改變。

| 官方 CLI 的請求內容 | 結果 |
|---|---|
| 預設 `build` agent | 通過 |
| 自訂系統提示，工具全開 | 通過 |
| 預設提示，工具全關 | 被擋：`429 free_tier_limit`，CLI 持續重試 |
| 只宣告 `read` | 通過 |
| 只宣告 `bash` | 被擋 |
| 宣告 `read` 與 `bash` | 通過 |
| 只宣告 MCP 工具（`host_read`、`host_bash`） | 被擋 |
| 以自訂工具覆寫 `read`，描述與 schema 取自官方 | 通過，且使用覆寫的結果 |

- 同一個 IP 上，官方 CLI 正常的請求與被擋的請求只差工具宣告；系統提示不影響結果。
  這與上表「工具描述或 schema 換成空殼即 `403`」一致：准入看的是 `read` 是否以官方形式宣告。
- `free_tier_limit` 回應的重試時間是 UTC 日界線，但它也出現在額度未用盡的請求上，
  不能單憑這個欄位判斷是額度問題。
- 插件自己的匿名請求在同一個 IP 被 `429`，而官方 CLI 通過；差異已定位，見下節。

### 同一個 IP：官方請求通過、插件請求被擋的差異

2026-10-30、同一個出口 IP、`deepseek-v4.1-flash-free`，每格一次請求。底稿是從官方 CLI 1.19.5
擷取的主請求，一次只改一項，再以 Bun 1.3.14 或 Node 送出；通過的請求每項至少重複過一次。

| 改動 | 結果 |
|---|---|
| 位元組相同的請求，Bun（`fetch`、`node:https`） | 通過 |
| 位元組相同的請求，Node `https`、`curl` | 被擋 |
| Node，只把 TLS 密碼套件清單換成 Bun 的 17 項 | 通過 |
| Node，ALPN 只留 `http/1.1`、或密碼套件清單少於那 17 項（含去掉 CBC-SHA 套件） | 被擋 |
| 系統提示換成一句話，或只留 OpenCode 基底提示 | 被擋 |
| 系統提示只有 `You are a helper.` 加官方 `<env>` 區塊 | 通過 |
| `<env>` 內只有 `Working directory:` 一行（值任意） | 通過 |
| `<env>` 內沒有 `Working directory:`，或沒有 `<env>` 標籤 | 被擋 |
| 不宣告工具（其餘不變） | 被擋 |
| 只宣告 `read`＋`bash`、`max_tokens` 改小、端點改 `/inference/v1`、改 User-Agent、加 `x-stainless-*` 標頭、去掉 `x-opencode-session-id` | 不影響 |

- 准入至少看三件事：系統提示含 `<env>` 區塊且其中有 `Working directory:` 行、宣告了官方形式的 `read`、
  TLS 密碼套件清單與官方 CLI（Bun／BoringSSL）相同。三項缺一不可，值與其他標頭不影響。
- Node 預設送出 52 項密碼套件、ALPN 為 `http/1.1` 與 `h2`；Bun 送出 17 項、ALPN 只有 `http/1.1`。
  只換密碼套件清單即可通過，說明上游不要求完整的 TLS 指紋（擴充順序仍不同）。
- 插件的探測請求原本沒有系統提示，也沒有 `<env>` 區塊，且在 Node 上用預設密碼套件；
  在 Bun 上也被擋，因為缺少 `<env>`。這兩個缺口各自獨立，現已由上節「目前插件採取的調整」補上。
- 真實 DSH 的第一輪請求（25 個工具）在對齊上述三項後仍被擋，原因是**工具名稱**：
  - 官方 CLI 的完整 10 個工具（`bash edit glob grep read skill task todowrite webfetch write`）通過。
  - DSH 工具集中，`subagent_fork` 與 `working_directory` 兩個名稱各自讓整組請求被擋；
    只把這兩個名稱改成 `agent_fork`、`cwd_tool`，25 個工具原樣（含 DSH 自己的描述與 schema）即通過，
    只改其中一個仍被擋。改名與工具描述、session、系統提示無關；以 `dsh_` 加前綴的整批改名也被擋。
  - 規則的完整形式未查明（同樣的名稱在較小的組合中有時通過），所以這是對 DSH 0.2.1-rc.5 工具集的實測結果，
    不是上游公布的名單。DSH 新增工具時需重新驗證。
- 差分實驗本身會耗盡該 IP 的額度：約八十次非官方請求後，官方 CLI 與 Bun 在同一個 IP 也被擋。
  重跑差分需換 IP，也不能把被擋歸因於單一訊號。
- OpenCode CLI 預設會把全域 `~/.claude/CLAUDE.md` 與技能清單放進系統提示，轉發或重放它的請求前要先確認內容。

### 官方 CLI v2 線的請求內容（漂移觀察，非仿照依據）

2026-10-31、OpenCode CLI 2.2.5（GitHub 發行的 macOS arm64 二進位檔，SHA-256 已核對）、
`opencode run --standalone`，請求導向本機擷取伺服器，沒有送到 Zen。v2 線（v2.2.0 起）在
GitHub 發行，npm 套件為 `@opencode/cli`；`opencode-ai` 最新仍是 1.19.5（v1 線）。
插件仍以 v1 線為仿照依據（[ADR-0006](adr/0006-opencode-v1-as-payload-reference.md)），本節只記錄 v2 的差異與放行結果。

| 項目 | 1.19.5 | 2.2.5 |
|---|---|---|
| 主請求的工具 | `bash edit glob grep read skill task todowrite webfetch write`（10 個） | `edit glob grep question read shell skill subagent webfetch websearch write execute`（12 個） |
| TLS 密碼套件 | 17 項 | 相同 17 項、相同順序 |
| 系統提示的 `<env>` | `Working directory:` 一行起 | 仍有 `<env>`，且有 `Working directory:` |
| 識別標頭 | `x-opencode-*` | 仍有，另有 `x-session-id`、`x-session-affinity`、`b3`、`traceparent`；User-Agent 為 `opencode/latest/2.2.5/cli` |

同一個出口 IP 上，把 2.2.5 的 12 個工具原樣以插件的傳輸層送到 `/inference/v1`，閘門放行（`200`）。
插件自己的 User-Agent 仍是 1.18.31 的形式，也被放行，所以這個欄位不是准入訊號。
v2 把 `bash` 改名為 `shell`、`task` 改名為 `subagent`，並移除 `todowrite`；
閘門目前接受新舊兩種形狀。尚未查明閘門日後是否只接受 v2 的形狀；若發生，依 ADR-0006 重新檢討仿照依據。

### 經官方 CLI 中繼（原型，未採用）

用 `opencode serve` 承載 DSH 的工具往返，對真實 Zen 免費模型完成過一次，沒有被擋：

- 以自訂工具檔覆寫 `read`、`bash`，描述與參數 schema 與官方逐字相同；`execute` 改為呼叫本機橋接，
  橋接把呼叫交給宿主執行，結果回來後再交還 OpenCode。
- agent 只開 `read` 與 `bash`。一個回合同時呼叫兩者，結果正確；共兩次上游請求。
- 工具結果延遲 90 秒仍正常完成。改用 MCP 橋接時，預設 60 秒會逾時
  （`MCP error -32001`），需調高 `mcp.<name>.timeout`；自訂工具沒有這個限制。
- 只有 MCP 工具過不了准入；MCP 工具還會以 `<server>_<tool>` 之名呈現給模型。

限制：只測單一模型、單一 IP、兩個工具；`opencode run` 載入自訂工具時卡在啟動，
只有 `serve` 可用，原因未查；未涵蓋 Windows `pwsh`、壓縮與長對話。OpenCode 另外注入的系統提示約
1k token，且工具實際由 OpenCode 行程呼叫橋接，DSH 的工具名稱需要轉換。

## 目前插件採取的調整

- 以 OpenCode CLI 身份標頭、時間編碼 session ID 與串流發出匿名請求；
  同一 DSH session 在行程內保留身份，沒有持久登入。
- 匿名 Windows 請求將 `pwsh` 呈現為 `bash`，並成對轉換 schema、歷史與回傳呼叫的
  工具名稱及 `file_path`／`filePath`、`timeoutMs`／`timeout` 參數。
- 缺少 `read` 或 `bash` 時補上實質宣告與不可呼叫說明；這些補位工具沒有宿主執行能力。
  呼叫不存在的工具時，在交給 DSH 前拒絕；保留呼叫端明確指定的工具選擇。
- 工具說明配合 DSH 實際的純文字讀檔與 shell 能力，不宣告 OpenCode 的額外讀取能力。
- 匿名請求在系統提示加入通用的 `<env>` 區塊（`Working directory:` 值不含宿主路徑），
  已有此區塊的提示不重複加入。
- 匿名請求把 DSH 的 `subagent_fork`、`working_directory` 以 `agent_fork`、`cwd_tool` 之名宣告，
  歷史與回傳的呼叫成對轉回原名；帶 key 的請求不改名。
- 在 Node 下，送往 Zen 的請求（`fetch` 與 `node:https`）提供官方 CLI 的 17 項 TLS 密碼套件；
  Bun 不處理。`DSH_OPENCODE_FREE_TLS_CIPHERS=default` 可關閉。
- 符合條件的匿名上下文壓縮請求替換系統提示，承載對話的使用者訊息不變。
  這是現有行為，尚不能證明提示替換是目前准入的必要條件。
- 帶 key 的請求不套用匿名工具與提示改寫。傳輸攔截範圍與隱私風險見
  [README](../README.zh-TW.md#安全與限制)。

## 未驗證事項

- 最小必要描述、schema 欄位、session 可接受的時間範圍與長 session 行為。
- 完整官方免費對話模型範圍的相容性驗收。
- 上述實測未涵蓋的 Web、Desktop、上下文壓縮與其他平台。
- `403 FreeTierError` 的完整判斷式；不能單憑此錯誤歸因為 IP、key 或模型下架。
- 免費層限額的計算單位（IP、機器、身份欄位皆未證實）；下節兩項訊號的完整判斷式與其他模型。
- 經官方 CLI 中繼的其他模型、平台與長對話行為。

## 再次診斷時

1. 先固定 DSH、插件、官方 CLI、Node 版本與模型，確認對照組真的收到非空回覆。
2. 使用隔離的設定與匿名身份；擷取時只保留必要的去敏訊號，不保存憑證或對話。
3. 每次只改一個條件；若改 session，維持 session 標頭與 cache key 一致。
4. 分開記錄 HTTP 狀態、文字回覆、工具往返與完整目標範圍，不能以 `200` 代替成功。
5. 新結果加上日期與驗證限制；真實上游請求須先取得明確授權。

`scripts/reverify.sh` 不能作為現行准入或 key 的完成驗證（見[使用指南](usage.zh-TW.md#驗證設定的路徑)）。
完整宿主驗證依[相容性驗證指南](compat-run.md)。
