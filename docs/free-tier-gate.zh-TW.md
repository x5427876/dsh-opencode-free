# OpenCode Zen 免費層檢查什麼

[English](free-tier-gate.md) | **繁體中文**

這是一份實測記錄：OpenCode Zen 的匿名免費層如何決定要不要服務一個請求。
讀者是其他用戶端與插件的作者，以及正在排查 `/inference/v1` 回傳 `403` 或
`429 free_tier_limit` 的人。

本文是 [dsh-opencode-free](../README.zh-TW.md) 維護者的觀察，不是上游的契約。
上游沒有公布第三方用戶端的准入規則，也可能不經通知就改變。引用任何一列之前，
請先讀[可信度的限制](#可信度的限制)。

## 摘要

以匿名 `public` key 送出請求時，免費層只在下列條件全部成立時放行：

1. 系統提示含有 `<env>` 區塊，且其中有 `Working directory:` 一行。值不影響結果。
2. 請求宣告官方的 `read` 工具，且描述與參數 schema 都是官方形式。同時宣告 `read` 與
   `bash` 會通過；只宣告 `bash` 會被擋。
3. TLS ClientHello 提供的密碼套件清單與官方 CLI 相同（Bun 的 BoringSSL 送出的 17 項，
   順序也相同）。

另有一條範圍較窄的規則，只在一組工具中觀察到：DSH 宿主的兩個工具名稱
`subagent_fork` 與 `working_directory`，各自會讓請求依名稱被擋。

其餘我改過的項目都沒有改變結果：User-Agent、額外的 `x-stainless-*` 標頭、
`x-opencode-session-id` 標頭、`max_tokens`，以及 `<env>` 區塊存在時系統提示的措辭。
同一個官方請求用舊路徑 `/zen/v1` 被擋、用 `/inference/v1` 通過
（2026-10-14、Windows、Node `fetch`），請使用 `/inference/v1`。

## 方法

每格是一次請求，與底稿只差一項，從同一個出口 IP、對同一個模型
（`deepseek-v4.1-flash-free`）、在同一天送出。

- **底稿：** 從官方 OpenCode CLI 1.19.5（npm `opencode-ai`）擷取的主請求。CLI 指向本機擷取
  伺服器，由它記錄標頭與內容。一次執行的第一個請求是標題請求、沒有工具；第二個才是主請求。
- **送出端：** Bun 1.3.14 或 Node，請求位元組固定不變。
- **密碼套件清單：** 以原始 TCP 監聽器讀取 ClientHello，所以數字是實際送上線的內容，
  不是函式庫文件上的說明。
- **重複：** 每項改動中通過的請求至少重複一次。
- **結果：** 「通過」表示請求得到服務並收到回覆。本專案不把單純的 `200` 當成成功的證據。

除非該列另註，量測日為 2026-10-30 與 2026-10-31。工具：OpenCode CLI 1.19.5（仿照依據）與
2.2.5（漂移觀察）、DeepSeek Harness 0.2.1-rc.5、插件 0.4.0。

## 結果

### 請求內容

| 與底稿的差異 | 結果 |
|---|---|
| 無，由 Bun 送出（`fetch` 或 `node:https`） | 通過 |
| 無，由 Node `https` 或 `curl` 送出 | 被擋 |
| Node，只把 TLS 密碼套件清單換成 Bun 的 17 項 | 通過 |
| Node，ALPN 只留 `http/1.1`，或密碼套件清單少於那 17 項（含去掉 CBC-SHA 套件） | 被擋 |
| 系統提示換成一句話，或只留 OpenCode 基底提示 | 被擋 |
| 系統提示是 `You are a helper.` 加官方 `<env>` 區塊 | 通過 |
| `<env>` 內只有 `Working directory:`（值任意） | 通過 |
| `<env>` 內沒有 `Working directory:`，或沒有 `<env>` 標籤 | 被擋 |
| 不宣告工具 | 被擋 |
| 只宣告 `read` 與 `bash` | 通過 |
| `max_tokens` 改小、端點改 `/inference/v1`、改 User-Agent、加 `x-stainless-*`、去掉 session 標頭 | 不影響 |

### 工具宣告

除最後一列另行量測外，每列都是官方 CLI 1.19.5 宣告不同的工具組合。

| 宣告的工具 | 結果 |
|---|---|
| 預設 agent（全部工具） | 通過 |
| 全部工具、自訂系統提示 | 通過 |
| 不宣告工具、預設提示 | 被擋（`429 free_tier_limit`） |
| 只宣告 `read` | 通過 |
| 只宣告 `bash` | 被擋 |
| 宣告 `read` 與 `bash` | 通過 |
| 只宣告 MCP 工具（`host_read`、`host_bash`） | 被擋 |
| 以自訂工具覆寫 `read`，描述與 schema 取自官方 | 通過 |
| 官方 `read`／`bash` 只把描述、或只把參數 schema 換成空殼（2026-10-14、Windows、Node `fetch`） | 被擋（`403`），完整宣告則通過 |

所以檢查的是 `read` 宣告的形式，不是系統提示；單靠工具宣告就足以造成拒絕。

### 工具名稱

真實 DSH 的第一輪請求帶 25 個工具。三項訊號都對齊後仍被擋，原因是工具名稱：

- 官方 CLI 的 10 個工具（`bash edit glob grep read skill task todowrite webfetch write`）通過。
- DSH 工具集中，`subagent_fork` 與 `working_directory` 各自單獨就會被擋。兩個都改成
  `agent_fork`、`cwd_tool`，其餘 23 個工具的描述與 schema 不變，即通過；只改其中一個仍被擋。
  幫每個名稱加上 `dsh_` 前綴也被擋。
- 同樣的名稱在某些較小的組合中有時通過。完整規則未查明，所以這是針對一組工具的結果，
  不是上游公布的拒絕名單。

### v2 線

OpenCode 有兩條發行線：v1（npm `opencode-ai`，預設安裝器）與 v2（GitHub 發行，npm `@opencode/cli`）。
最新的 2.2.5 在主請求送出 12 個工具，把 `bash` 改名為 `shell`、`task` 改名為 `subagent`，
移除 `todowrite`，新增 `question`、`websearch` 與 `execute`。它送出相同的 17 項密碼套件、
順序相同，也保留 `<env>` 區塊。把它的 12 個工具以插件的傳輸層重放，通過了，
所以量測當時閘門接受新舊兩種形狀。日後是否仍接受 v1，尚未查明。

## 可信度的限制

- **有日期。** 每一列只代表一個時間、一個模型、一個 IP。上游可能在兩次請求之間改變閘門，
  之後的結果可能不同。
- **受額度干擾。** 實驗本身會耗盡該 IP 的額度。約八十次非官方請求之後，官方 CLI 與 Bun
  在同一個 IP 也被擋。重跑需要換 IP；沒有一次剛通過的對照組，就不能把被擋歸因於單一訊號。
- **不是完整規則。** 這幾輪中三項訊號是必要的，但沒有證明它們對每個模型都充分，
  `403 FreeTierError` 背後的完整判斷式也未知。
- **`free_tier_limit` 不能證明額度用盡。** 它也出現在仍有額度的 IP 的請求上。
- **`200` 不是授權。** 它只表示請求得到服務，不代表上游承諾支援第三方用戶端。

## 重現方式

請在隔離的設定與全新的 IP 上進行，並把請求數控制在少數幾次。

1. 讓官方 CLI 對一個記錄每個請求的本機 OpenAI 相容伺服器執行，並給它專屬的
   `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`HOME` 與 `OPENCODE_DISABLE_AUTOUPDATE=1`：
   `opencode run --standalone --auto -m <provider>/<model> "say hi"`。
   2.x 不加 `--standalone` 會啟動背景服務，可能卡住。
2. 把 provider 指向 `https://127.0.0.1:<port>`，用原始 TCP 監聽器讀取 ClientHello
   與密碼套件清單。
3. 每次只改一項，用你能控制 TLS 設定的用戶端送出擷取到的位元組，記錄狀態與回覆。

官方 CLI 預設會把全域 `~/.claude/CLAUDE.md` 與技能清單放進系統提示。重放或分享擷取的請求前，請先檢查內容。

## 插件怎麼處理

[dsh-opencode-free](../README.zh-TW.md) 會補上 `<env>` 區塊、宣告官方形式的 `read` 與 `bash`
工具、替兩個被擋的名稱加別名，並在 Node 下提供官方 CLI 的密碼套件清單。帶 key 的請求不改寫。
實作在 [`src/zen-provider.ts`](../src/zen-provider.ts) 與 [`src/zen-tls.ts`](../src/zen-tls.ts)，
工作筆記在[協定分析](protocol-notes.md)，插件仿照哪一條 CLI 線見
[ADR-0006](adr/0006-opencode-v1-as-payload-reference.md)。

## 引用

> dsh-opencode-free maintainers. *What the OpenCode Zen free tier checks.*
> Measured 2026-10-30 to 2026-10-31 with OpenCode CLI 1.19.5 and 2.2.5.
> https://github.com/x5427876/dsh-opencode-free/blob/main/docs/free-tier-gate.md

要引用特定列時，請在網址中固定 commit，因為重新量測時本頁會更新。更正與較新的觀察歡迎透過
[issue](https://github.com/x5427876/dsh-opencode-free/issues) 提供。
