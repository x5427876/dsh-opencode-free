# Pi 插件作者如何仿冒 OpenCode CLI 身份：逆向考據

本文件考據 `pi-opencode-direct` 作者是怎麼把 OpenCode CLI 的行為
逆向出來、再逐一仿冒的，以及每一項仿冒在 `dsh-opencode-free`
的對應位置。所有斷言都對著第一手來源驗過（見文末）。

術語：技術段落一律用「仿冒 CLI 身份」，立場段落用「bypass」；
不用「模仿」（見 `CONTEXT.md`）。

> ⏳ 時效：本文件初版是 2026-09-22 的快照，2026-09-27 補上工具名稱閘門
> （§8）與踩雷紀錄。上游無第三方合約，行為隨時會變；
> 若 `scripts/reverify.sh` 出現非預期燈號，先重跑腳本確認，仍異常則按
> 「方法：MITM 錄封包 + 差分」重驗並更新本文件與 ADR。

## 方法：MITM 錄封包 + 差分

作者不是猜的。CHANGELOG 自述了兩次關鍵發現手段：

- `0.1.3`：從 `within OpenCode` 閘門恢復——靠送 `Bearer public`、
  OpenCode `User-Agent`、`ses_` 結構會話 id。
- `0.1.6`：匿名壓縮 403——靠「diffing a working vs failing capture」
  發現 Zen 閘的是 developer 內容，進而從 CLI binary 抽出逐字節一致的
  compaction system prompt；`x-client-request-id` 缺失導致 403——靠
  「found via MITM」。

也就是：錄下真 CLI 的成功請求，跟失敗請求逐字節對，比出差異。

### 可重跑的做法（2026-09-27 實際用過）

不需要 MITM 憑證。只要本機有一個**能成功**的客戶端（例如 Pi）：

1. **先確認對照組真的成功。** 用 `PI_OPENCODE_DIRECT_DEBUG=1 pi -p --no-session "Reply with OK only."`
   看 stderr 是否有 `fetch <- 200`，並確認 `auth=Bearer public`
   （`~/.pi/agent/auth.json` 若存有 key，Pi 可能不是匿名）。
2. **擷取完整 body。** 用 `NODE_OPTIONS=--import=<hook.mjs>` 注入一個 hook。
   Pi 啟動後會重新指派 `globalThis.fetch`，所以 hook 要用
   `Object.defineProperty(globalThis, 'fetch', { get, set })`，在 setter 裡
   把之後指派的 fetch 也包起來；直接覆寫 `globalThis.fetch` 抓不到任何請求。
   寫檔時刪掉 `authorization`。
3. **逐項重播。** 用擷取到的 body 直接 `fetch` Zen，每次只改一個欄位
   （拿掉 system prompt、拿掉 tools、只留部分 tools、換成假工具……），
   每次用新的 `ses_` id。收到狀態碼就 `abort()`，節省額度。
4. **最後用目標客戶端的真實組合驗證**（例如 DSH 在 Windows 的工具清單），
   確認差異就是它。

## 踩雷紀錄（避免再犯）

2026-09-22 到 09-27 之間，我們把 403 誤判成「出口 IP 匿名額度被閘」，
還把錯誤訊息寫成「掛 key 即解」。實際原因是 §8 的工具名稱閘門。
走錯的原因：

- **探針和真實請求形狀不同。** `reverify.sh` 和 `test-live.mjs` 只送短訊息，
  不帶 `tools`，`reverify.sh` 還沒有 `stream: true`。這種請求**永遠** 403，
  所以「連極小 request 都失敗」不是 IP 被閘的證據，而是探針本身不合格。
  探針必須符合所有已知閘門條件，否則它只能證明探針錯了。
- **對照組也用了同樣不合格的探針。** 官方 OpenCode（`--pure`）和
  `pi-opencode-direct` 的 `streamSimple()` 對照都送不帶工具的短訊息，
  所以也 403。這讓錯誤結論看起來被「多方證實」。
  對照組要用**完整的真實使用方式**（例如 `pi -p` 走完整 agent），不要只呼叫底層函式。
- **沒有先問「哪個客戶端現在能用」。** 使用者的 Pi 其實一直能匿名使用。
  只要先擷取它的成功請求來比對，一小時內就能定位。
- **平台差異。** 同一個 DSH，在 Linux／macOS 送 `bash`，在 Windows 送 `pwsh`
  （`dsh-base/cordis.patch.yml` 依 `process.platform` 開關 `tool-bash`／`tool-pwsh`）。
  在一個平台上成功，不代表另一個平台也成功。
- **不要把上游錯誤翻譯成確定的原因。** `FreeTierError ... within OpenCode`
  是上游對多種條件的同一個回應。錯誤指引只能寫「上游拒絕」，不能寫「IP 被閘」或「加 key 即解」。

## 仿冒對照表

### 1. 傳輸：Zen 原生端點，不經中轉

真 CLI 直接打 `https://opencode.ai/zen/v1`（Responses / Chat Completions，
SSE）。插件同樣直連，不裝 OpenCode、不起 server、不用 LiteLLM。

- Pi 版：`BASE_URL` + `openAIResponsesApi()` / `openAICompletionsApi()`
- 我們：`src/zen-provider.ts` 的 `BASE_URL`、`zenProvider()`（同名同值）

### 2. 身份四件套：仿冒 CLI 身份

| 欄位 | 真 CLI 的值 | 插件做法 |
|---|---|---|
| `Authorization` |（匿名時）字面 `Bearer public` | `compatRequestOptions()` 從有效 key 重建，杜絕 stale header 錯配 |
| `User-Agent` | `opencode/<版本> ai-sdk/provider-utils/<版本> runtime/bun/<版本>`（洩漏了 CLI 跑在 Bun 上） | `OPENCODE_USER_AGENT` 照抄格式，只把尾段換成自家插件名（⚠️ 未驗證，見下） |
| `x-opencode-client` | `cli` | `OPENCODE_CLIENT = "cli"` |
| `x-opencode-project` | `global` | `OPENCODE_PROJECT = "global"` |

第三方佐證：匿名免費層只認 `opencode/<version>` UA
（[opencode#42500](https://github.com/anomalyco/opencode/issues/42500)），
`x-opencode-client`/session headers 解不了 UA 這道鎖。

> ⚠️ 推論（部分驗證）：UA 尾段插件名（`dsh-opencode-free/0.1.3`，Pi 版是
> `pi-opencode-direct/0.1.7`）不影響閘門。2026-09-27 帶 `dsh-opencode-free`
> 尾段的請求已匿名 200，所以這個尾段目前可以通過；尚未測試其他尾段字串。
> 之前寫的「匿名全死、無法差分」是 §8 的誤判，現在可以用重播做 A/B。

### 3. 會話 id：結構逐字節對，生成方式是近似

真 CLI 的格式來自
[`packages/opencode/src/id/id.ts`](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/id/id.ts)
（已逐字驗證）：

```ts
const prefixes = { ..., session: "ses", message: "msg", ... }
const LENGTH = 26
return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
// => ses_ + 12 hex（6 timestamp bytes）+ 14 base62
```

插件的 `sessionHeader()` 輸出符合 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，
與上式完全同構。但有一個誠實的差異：

- 真 CLI：時間戳 + 單調計數（同毫秒內遞增，可排序、可反解時間）。
- 插件：`sha256("opencode-zen-free:<pi/dsh session>")` 取前 6 bytes 當 hex、
  後段當 base62——**結構合法、每會話穩定、會話間不同**，但不含真實時間。

上游閘的是「結構非法」（64 hex、裸 base62 會被拒），不是「時間是否真實」，
所以這個近似能過。同理 `requestHeader()` 仿 `msg_` 做純隨機（上游不驗證，
只求像）。

> ⚠️ 推論（未驗證）：「只驗結構、不驗時間真實性」是推論——已證結構非法
> 會死（64 hex / 裸 base62 被拒）。2026-09-27 重播時每次都用純隨機的
> `ses_` id（不含真實時間），請求都通過，所以時間造假目前可以通過。

親和三處同值：`x-opencode-session` ＝ `x-client-request-id` ＝
`prompt_cache_key`（body 欄位）。`x-client-request-id` 是 MITM 發現的：
Pi core 壓縮時強制 `cacheRetention: "none"`，pi-ai 會吞掉自己的親和 header，
而缺了它 Zen 就 403——所以插件顯式補上。

### 4. 免費目錄：公開端點 + Pi 元數據

- 活目錄：`GET https://opencode.ai/zen/v1/models`（免認證公開端點，
  本機實測回 200）取 `data[].id`。
- 過濾：只收錄 Pi 內建 `opencode` 目錄中 `api ∈ {openai-responses,
  openai-completions}` 且 `cost` 全零的模型——能力與限額沿用 Pi 官方
  元數據，不自己猜。
- 對應：`freeModels()` + `zenProvider().refreshModels()`；
  我們原樣移植（`src/zen-provider.ts`）。

### 5. 加密重播：後端輪轉的 400 重試

`reasoning.encrypted_content` 綁定發行的後端實例；Zen 閒置過期或長任務
後把會話搬到別台機器，帶舊加密內容的重播會 400
（`was not issued to this caller` / `could not be verified`）。
插件包一層 fetch：命中特徵字串就丟掉 `reasoning` 項（連帶丟掉孤兒
`function_call` id，否則配對校驗再 400），當新會話重發一次。
特徵字串來自真實失敗報文。

- 對應：`isEncryptedContentError()`、`stripStaleReasoning()`、
  `withEncryptedContentFallback()`（我們原樣移植）。

### 6. 壓縮提示詞：逐字節抄 CLI binary

匿名壓縮 Pi 自家提示詞 403、OpenCode 原文 200——差分定位到 developer
內容後，作者從 CLI binary 抽出原文。已驗證與
[`packages/opencode/src/agent/prompt/compaction.txt`](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/agent/prompt/compaction.txt)
逐字一致（`You are a context summarization agent…` 開頭）。

插件只在「短、獨立、匿名」的壓縮請求上替換，絕不碰對話內容與有 key
請求：`swapCompactionPrompt()`（我們移植時去掉了 0.86 專屬的 transcript
分支，只留 0.85.1 的 `{ systemPrompt }` 形狀——DSH 的 `PiAiAdapter`
餵的就是這個形狀）。

> ⚠️ 未重驗：2026-09-27 的重播顯示 system prompt 內容不影響閘門（§8）。
> 「Pi 壓縮提示詞 403」可能其實是壓縮請求不帶 `read`／`bash` 工具造成的。
> 現在 §8 會替不帶工具的請求補上空工具，所以這個替換可能已經不需要；
> 刪除前先用重播方法確認。

### 7. 旁路全覆蓋：三層守衛

主路徑（`stream()` 包裝）之外，作者發現記憶體插件的 direct transport
走 `pi-ai/compat completeSimple`，根本不經過包裝——於是：

1. 靜態身份掛在 `provider.headers` / `model.headers` / `auth.resolve()`
   headers（`STATIC_ZEN_HEADERS`）；
2. 補動態身份：patch 全域 compat registry（`patchCompatDirectTransport`）；
3. 兜底：包 `globalThis.fetch`（`patchGlobalFetchForZen`，嚴格限定 Zen
   網域）與 `node:http/https`（`patchNodeHttpForZen`，給 axios 風格呼叫）。

三層都 reload-safe（pristine-original stash，不疊包裝）。我們三層全移植，
僅把 debug env 改名 `DSH_OPENCODE_DIRECT_DEBUG`、stash key 加 `dsh` 前綴。

### 8. 工具名稱閘門：必須有 `read` 與 `bash`

2026-09-27 擷取 Pi（Windows）的成功請求後逐項重播發現：匿名層還檢查
請求本體。缺一即 `403 FreeTierError`：

- `stream: true`；
- `tools` 同時含名稱**剛好是** `read` 與 `bash` 的工具（大小寫敏感；
  描述與 schema 不看，空 schema 的假工具也過）。

重播結果（同一個 Pi body，匿名 `Bearer public`，每次只改一項）：

| 變化 | 結果 |
|---|---|
| 原樣（13 個工具，12.5K 字 developer prompt） | 200 |
| 拿掉 developer prompt／換成一句短 prompt | 200 |
| 拿掉 `tools`／`tools: []` | 403 |
| 只留 `read`，或只留 `bash` | 403 |
| 只留 `read` + `bash`（原始定義） | 200 |
| 假工具 `read` + `bash`（空 schema、描述 `x`） | 200 |
| 大寫 `Read` + `Bash` | 403 |
| 13 個假工具 `foo0`…`foo12` | 403 |
| 不帶工具，把工具 JSON 塞進 prompt 補足大小 | 403（不是大小門檻） |
| DSH Windows 組合 `read, write, edit, glob, grep, pwsh` | 403 |
| DSH Linux 組合 `read, write, edit, glob, grep, bash` | 200 |
| 最小請求 + `read`/`bash`，不串流 | 403 |
| 最小請求 + `read`/`bash` + `stream: true` | 200 |

system prompt 不影響結果。Pi 在 Windows 送 `bash` + `powershell`，所以通過；
DSH 在 Windows 用 `dsh-base` 的 `tool-pwsh` 取代 `tool-bash`，送出的是
`pwsh`，所以被擋。這才是「Pi 能用、DSH 不能用」的原因。
（Pi 能用，只是因為它剛好有名為 `bash` 的工具。Pi 版插件並不知道這個閘門。）

插件對策（`applyAnonymousToolGate`，只在匿名 `public` 時生效）：缺 `bash`
但有 `pwsh` 時，送出前把 `pwsh` 改名為 `bash`（含歷史訊息的 `toolCall.name`
與 `toolResult.toolName`），回傳的 `bash` 呼叫在串流事件（`partial`、`toolCall`、
`message`、`error`）與 `result()` 裡原地改回 `pwsh`；仍缺 `read`／`bash`
（標題、壓縮等不帶工具的請求）時補上不可用的空工具。帶 key 的請求原樣送出。
主路徑（`zenProvider().stream*`）與 compat 路徑都套用。`stream: true` 由 pi-ai
保證，插件不用處理。

2026-09-27 DSH rc.2（Windows、`web` profile、無 key）實測：7 個免費模型都能對話；
`pwsh` 與 `read` 工具往返都完成（軌跡記錄顯示 DSH 收到 `pwsh`）；
除錯記錄 18 個請求全部 `200`、全部 `Bearer public`。

維護注意：

- 若 DSH 改名 shell 工具（不再叫 `pwsh`），改名對映會失效，只剩空的 `bash`
  補位；模型呼叫它時 DSH 會回報未知工具。改 `SHELL_ALIAS` 即可。
- 若上游改成檢查其他工具名（例如 OpenCode 的 `glob`／`grep`／`edit`），
  用上面的重播方法找出新的必要集合，再改 `GATE_TOOLS`。
- `pwsh` 在 DSH 裡執行 `Get-Date` 曾花 1 分 22 秒，這是 DSH PowerShell 沙盒的耗時，
  不是插件問題；插件在模型回傳工具呼叫時就已完成工作。

## 我們相對 Pi 版的改編（非仿冒部分）

- **DSH 化**：Pi 的 `pi.registerProvider()` → DSH 的
  `ctx.llm.registerAdapter([PROVIDER_ID], new PiAiAdapter(...))`
 （`src/index.ts`），profile 欄位抄 `dsh-claude-subscription`。
- **key 優先順序**：Pi 版是 stored credential → `OPENCODE_API_KEY` →
  匿名；v1 無持久登入，改為 `config.apiKey` → `OPENCODE_API_KEY` → 匿名。
- **pi-ai 0.85.1**：DSH 鎖版，不用 0.86 的 transcript API（見上 §6）。

## 上游閘門現況（實測 + 第三方佐證）

- 本機實測（2026-09-22）：Zen 目錄端點 200；但匿名 `hi`（Pi 官方原版
  身份一字不改）回 `403 FreeTierError ... only be used from within OpenCode`。
  此回應只證明上游拒絕請求；先前歸因為出口 IP 額度並排除 header 差異，證據不足。
  重驗用 `scripts/reverify.sh`（紅綠燈，不耗額度外的人力）。
- 2026-09-27 對照：DSH rc.2 的 `web` profile 對 7 個免費模型均收到
  HTTP 403，沒有對話回覆。直接呼叫插件的 `big-pickle` 取得原始
  `FreeTierError`，訊息為 `OpenCode's free tier can only be used from within OpenCode`。
  同一台主機使用官方 OpenCode 1.18.16 與 1.18.32，以隔離設定、
  `--pure`、匿名 `public` 和 `opencode/big-pickle` 測試，也收到相同 403。
  因此失敗不限於 DSH；上游拒絕的具體條件仍未確認。未測試 Zen key。
- 同日加做原專案對照：隔離安裝 npm `pi-opencode-direct@0.1.7`，
  使用它自己的 `pi-ai@0.86.1` 與 `zenProvider().streamSimple()`，
  對 7 個免費模型各送一次匿名短訊息（不重試）。7 個均回
  `403 FreeTierError`，沒有文字回覆。這排除了僅 DSH 移植版本失敗的假設，
  但不能據此判定 IP 額度或 key 是否能解決。
  本插件可用 `node scripts/test-live.mjs` 重跑；先執行 `pnpm run build`。
  此命令會發送實際請求，任一模型未回覆便以非零退出碼結束。
- 2026-09-27 更正：以上 403 的共同原因是請求不帶 `read`／`bash` 工具
  （短訊息測試都不帶工具；DSH 在 Windows 只有 `pwsh`），見 §8。
  加上工具閘門對策後，`test-live.mjs` 7 個免費模型全部匿名回覆，
  `reverify.sh` ②號燈轉綠。先前的 IP 額度推論不成立。
- 第三方說法（本專案未驗證）：免費額度是整出口 IP 共用的 trial bucket。
  就算屬實，也不是本次 403 的原因（見 §8 與「踩雷紀錄」）。近期多方回報
  收緊：LiteLLM 帶 header 也被拒、Hermes 靠補 session header 修復、
  Go 要求 `x-opencode-session`（[pi#9230](https://github.com/earendil-works/pi/issues/9230)）。
- 誠實註記： keyless 層沒有官方第三方合約，200 不代表被允許
  （見 opencodex 的立場說明）。本插件是社群 workaround 性質，
  上游一改就可能再壞——壞了就回來按 §1 的方法重錄封包差分。

## 來源

- Pi 插件本體與逆向日誌：https://github.com/Aymendje/pi-opencode-direct
- `id.ts`（dev 分支，已逐字對）：https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/id/id.ts
- `compaction.txt`（已逐字對）：https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/agent/prompt/compaction.txt
- UA 閘（第三方驗證）：https://github.com/anomalyco/opencode/issues/42500
- Go session header 要求：https://github.com/earendil-works/pi/issues/9230 ；`pi-ai` 從不送該 header：https://github.com/earendil-works/pi/issues/9326
- 免費層無第三方合約（opencodex 立場）：https://github.com/lidge-jun/opencodex/blob/main/docs-site/src/content/docs/guides/providers.md
- 官方 Zen 說明：https://opencode.ai/docs/providers ；中繼實作分析（含 IP 級限額）：https://zenn.dev/7shi/scraps/29e1a588442d3b
- Hermes 修復例：https://www.reddit.com/r/hermesagent/comments/1w9x0on/fix_opencode_freetier_models_working_in_hermes/
- DSH 同類插件（只加 session header）：https://dshmp.com/en/plugins/dsh-opencode-session
- OpenClaw 的同樣做法（`OPENCODE_API_KEY` 別名、`x-opencode-session`）：https://docs.openclaw.ai/providers/opencode
