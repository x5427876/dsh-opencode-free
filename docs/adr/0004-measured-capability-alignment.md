# 能力對齊以實測兜底：models.dev 是聲明，不是量測

三根軸——通道、思考檔位、上下文長度——的取捨，都由同一條原則決定：
**models.dev 發布的是聲明。聲明缺席時，缺席必須被讀作「什麼都不知道」，
而不是「什麼都允許」；而每一個被採信的數字，都要能以一次請求的代價驗證。**

本文件修正 [ADR 0002](0002-catalogue-source-of-truth.md) 中「上下文多大由 models.dev 決定」
一句——該斷言已被實測證偽。

**Status**: proposed

**Context**

2026-10-06 的一輪實測在三處推翻��了當前行為。

**一、`models.dev` 與 `models.opencode.ai` 是同一份檔案。**兩者
`md5` 皆為 `f363a82e4039573e9e2eae5ea9a331ef`，5,316,417 位元組，逐位元組相同。
換來源換不到新的可信度。

**二、思考檔位的 `undefined` 不是「不宣稱」，而是「最大膽的宣稱」。**
`thinkingLevelMapFor` 在 `reasoning_options` 為 `[]` 或 `[{type:"toggle"}]` 時回傳
`undefined`；pi-ai 的 `getSupportedThinkingLevels` 把缺省讀作**全部提供**。
實測後果：10 個活躍免費模型中有 7 個，向使用者提供了 models.dev 從未發布的
`minimal`/`low`/`medium`/`high` 四檔，且因
`params.reasoning_effort = map[level] ?? level` 而原樣上線。

**三、選 Off 時的實際行為與宣稱相反。**插件的 `onPayload` 守衛讀取
`payload.reasoning.effort`（巢狀物件），但 completions 通道只產生頂層
`reasoning_effort`；該通道唯一的發送出口又要求
`thinkingLevelMap.off` 為**字串**，而 `thinkingLevelMapFor` 刻意從不寫入此鍵
（`src/catalog.ts:191`）。故選 Off 時請求不帶任何 reasoning 欄位。

實測（12 個請求，序號、間隔 ≥2s，12/12 用盡）：

| 模型 | 形狀 | 省略欄位 | `reasoning_effort:"none"` |
|---|---|---|---|
| `nemotron-3-ultra-free` | `reasoning_options: []` | **推理 49 tok** | **推理 0 tok**，答案仍返回 |
| `space-bunny-free` | 宣告 `low…max` | 推理 35 tok | **HTTP 400** |
| `ling-3.1-flash-free` | `toggle` | 3×429 上游宕機，無資料 | 同左 |

`nemotron` 的決定性對比跨兩次獨立執行重現（completion tokens 115 → 12）。
**兩種形狀需要相反處理**：無檔位者發 `none` 有效，有檔位者發 `none` 為硬 400。
因此單一的「Off 該發什麼」答案不存在，必須依宣告形狀分支。
另注意 `400` 這種失敗是**響亮的**，而省略欄位造成的持續推理是**安靜的**——
對使用者而言，後者才是真正不可接受的。

**四、上下文長度被低報 5.24 倍。**`models.dev` 對
`mimo-v2.6-flash-free` 與 `mimo-v2.5-free` 皆發布 `limit.context: 200000`；
上游以一個請求直接作答：

> `This endpoint's maximum context length is 1048576 tokens. However, you
> requested about 1048659 tokens (1048516 of text input, 79 of tool input,
> 64 in the output).`

兩個模型的報文**逐位元組相同**，故這是**過時的宣告**，不是模型變更。
針測試確認上限真實可用：埋在 4.12 MB 提示詞**末端**的唯一字串在
739,592 真實 token 處被原樣取回，無靜默截斷。

後續對懷疑名單的實測（13/14 請求，每模型一次 `E=1048576`，200 者以 2M 追問）：

| 模型 | 宣告 | 報文自述上限 | 判定 |
|---|---|---|---|
| `mimo-v2.6-flash-free`（對照） | 200000 | 1048576 | 低報 5.24× |
| `mimo-v2.5-free` | 200000 | 1048576 | 低報 5.24× |
| `big-pickle` | 200000 | —（2M 亦 200 OK） | 低報，區間 >1048576 |
| `nemotron-3.5-lightning-free` | **262144** | **1000000** | **低報 3.81×** |
| `ling-3.1-flash-free` | **262144** | **262144** | **正確** |
| `nemotron-3-ultra-free` | 1000000 | 1000000 | 正確 |
| `longcat-2.5-preview-free` | 1000000 | —（2M 200 OK） | 正確，至少 |
| `ling-3.0-flash-fin-free` | 262144 | — `Endpoint is unavailable.` | 無資料 ×2 |
| `nemotron-3-super-free` / `glm-4.7-free` | 204800 | — `ModelError: not supported` | 無資料（模型已下架） |

**「十進位宣告可疑」這條啟發式已被證偽，必須廢除。**指定的對照組就是反例：
`nemotron-3.5-lightning-free` 宣告 **262144（二進位）**卻低報至 1000000，
而 `ling-3.1-flash-free` 宣告**同一個 262144**（同樣二進位）卻完全正確。
同一個宣告對一個模型錯、對另一個模型對，故數字格式不具預測力。
這也不是 mimo 家族問題：`big-pickle` 非 mimo、共用 200000 宣告，同樣低報。

存活下來的只是**傾向**：≤262144 可測者 5 中 4 低報，1000000 者 2 中 2 正確。
**傾向指示「去哪裡量」，永不指示「答案是什麼」。**

`limit.context` 不是裝飾數字，它驅動兩處計算：

- pi-ai 的 `clampMaxTokensToContext`（`simple-options.js:4-9`）把 `max_tokens`
  夾到 `contextWindow − 估計 − 4096`，故 200K 宣告約在 196K 處夾死輸出。
- DSH 壓縮閾值為 `floor(contextWindow × 0.8)`，故 200K 宣告使對話在
  160K 而非 838K 摘要——**提前 5.24 倍丟棄已累積的工作**。

**五、兩份報文之間存在單位口徑問題，且必須靠實測而非推理定案。**
上游報文自稱 `1048516 of text input`，與我們用
`estimateContextTokens` 得到的 `1048576` 相差 60 token（0.006%）——
**上游的准入計數與 pi-ai 的估算同口徑**，而非與真實 tokenizer 同口徑。
DSH 的 `dsh-token-meter` 亦為啟發式估算，且
`dsh-compaction-basic` 的錯誤訊息自述為 `estimated tokens`。
三條鏈路同單位，故 `floor(0.8 × 1048576) = 838,860`（估算）**低於**
`1,048,576`（估算）的准入閾值，壓縮會在拒絕之前觸發，
**直接代入上游數值是安全的，不需額外安全餘量**。

**六、`toggle` 形狀不是一種行為——同一個形狀，兩個模型表現相反。**

| 模型 | 省略欄位 | `reasoning_effort:"none"` |
|---|---|---|
| `nemotron-3-ultra-free`（`[]`） | 49 tok | **0 tok**（兩次重現） |
| `ling-3.1-flash-free`（`[toggle]`） | 32 tok | **0 tok**（兩次重現） |
| `longcat-2.5-preview-free`（`[toggle]`） | 76 / 77 tok | **71 / 71 tok**（兩次重現，HTTP 200，`reasoning_content` 仍在） |
| `space-bunny-free`（宣告檔位） | 35 tok | **HTTP 400** |
| `ling-3.0-flash-fin-free`（`[toggle]`） | — | 無資料（三次 `Endpoint is unavailable.`，上游確實宕機） |

故 Off 拼寫有**四種**狀態，而非兩種：

1. **works** — 推理停止（`nemotron`、`ling-3.1`）
2. **ineffective** — 上游接受並回 200，推理**繼續**（`longcat`）。**這是無聲失敗**：
   使用者看到一個正常工作的模型，就是一直在思考，鏈路上無任何錯誤
3. **rejected** — 硬 400（`space-bunny`）
4. **unknown** — 未量測

**關鍵推論：`reasoning_options` 無法預測 `"none"` 是否有效**，因為兩個 `[toggle]`
模型結果相反。故 toggle 形狀的 R3 **必須逐模型量測並持久化**，不能由形狀推導。
`[] → works` 是目前唯一在兩個模型上重複成立的配對。

**七、泛用 400 形態在兩個軸上共用，故不可單憑自身判定。**
`big-pickle` 對上下文溢出回泛用 `invalid_request_error: invalid request`；
對 `reasoning_effort:"zzz"` 回**逐字相同**的報文；`space-bunny-free` 對
`reasoning_effort:"none"` 亦為同一形態。故「泛用 400」無法區分
「上下文溢出」與「參數非法」，必須搭配陽性對照
（上下文軸的對照＝該請求的估算值 > 本次廣告的 `contextWindow`；
檔位軸的對照＝同輪 liveness 為 ok）。

**八、低報與高報在真實部署中皆無自動恢復，但低報是唯一靜默的一個。**
`limit.context` 低報時不產生任何
HTTP 錯誤（pi-ai 的 `clampMaxTokensToContext` 在
`contextWindow − 估算 − 4096 ≤ 0` 時回傳 `MIN_MAX_TOKENS = 1`），
故沒有錯誤、沒有重試、沒有恢復路徑。本地以 pi-ai 的實際函數驗算
（`mimo-v2.6-flash-free`，`limit.output=32000`）：

| 會話估算 | 宣告 200000 下的 max_tokens | 實測真相 1048576 下的 max_tokens |
|---|---|---|
| 155,000 | 32000 | 32000 |
| 186,000 | **9904**（輸出被截 3×） | 32000 |
| **201,500 及以上** | **1** | **32000** |

**越過約 200K 後模型一個 token 都吐不出來，會話靜默死亡**，
而模型真實可承載 1M。此為 DSH 未配置壓縮策略時的預設後果。

反之高報**有恢復路徑**：`isContextWindowExceededError`
（`dsh-llm/lib/index.js:172-173`）以正則
`/\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i`
比對報文，Zen 的 `"This endpoint's maximum context length is N tokens"`
**逐字命中**，故 `dsh-compaction-basic` 的反應式壓縮重試會被觸發。
但此路徑需 `dsh-compaction-basic` 在使用者 profile 中啟用；
泛用形態 400（`big-pickle`）則正則不命中，兩種情況皆無恢復。

**不對稱性因此是本決策的決定性理由：低報＝靜默且不可逆；高報＝使用者可見的失敗。**

⚠️ **但此不對稱性的機制必須被更正的版本取代。**初稿曾主張「高報可恢復」，
理由是 `dsh-compaction-basic` 的反應式壓縮重試會被觸發。**該程式碼存在，
但在使用者實際部署中並未接線**：`@deepseek-ai/dsh-compaction-basic` 未安裝進
`~/.dsh/profiles/web/node_modules`，profile 的 `dsh.profile.bundles` 亦未列出。
故在真實部署裡**兩種失敗皆無恢復路徑**：

- 低報 → 無錯誤 → `max_tokens` 塌成 1，使用者看到模型「突然變笨」而無從歸因
- 高報 → 上游 400，使用者看到明確錯誤，可切換模型或重开会話

結論方向不變，但理由必須換成**可見失敗優於靜默失敗**，而非「系統會自動恢復」。
這也更強化了按需驗證的價值：在沒有自動恢復的世界裡，一次使用者可見的 400
是真實成本，而一次預防它的請求是一次真實投資。

**Considered Options**

- **只信 models.dev（否決）**：即 ADR 0002 現況。已被上述二、三、四項實測證偽。
- **改信 models.opencode.ai（否決）**：逐位元組相同，無新資訊。
- **全面改用手寫靜態表（否決）**：ADR 0002 已記錄兩輪手工維護的成本證據。
- **每次啟動重新實測三軸（否決）**：36 個模型 × 三軸遠超共享桶承受量。
- **按可負擔性分層：搭車 → 按需 → 拒絕（採納）**，見下。

**九、`max_tokens` 的下限已於線上觀測，靜默失敗從推導升級為實測。**

初稿僅從 pi-ai 原始碼推導出「`max_tokens` 會塌成 1」。線上實測（`max_tokens`
為 1 / 4 / 16 / 1024）：

| `max_tokens` | HTTP | `completion_tokens` | `finish_reason` | 輸出 |
|---|---|---|---|---|
| **1** | **200** | **1** | **`length`** | **零字元，無任何錯誤** |
| 4 | 200 | 4 | `length` | 截斷 |
| 16（`nemotron-3-ultra-free`） | 200 | 16 | `length` | 推理中途截斷 |
| 1024（`nemotron-3-ultra-free`） | 200 | 62 | `stop` | 完整答案 |

故 `max_tokens` 被精確遵守而非忽略，**且 `max_tokens: 1` 的失敗是 HTTP 200 加
零輸出**。低報確實產生「一輪什麼都沒說」且無錯誤可指。

**關鍵推進：此失敗對使用者靜默，但對宿主並非不可見。**響應帶
`finish_reason: "length"` 與空 content，而插件既有的 `hasAnswer()`
本就把這判為「無應答」。**故夾逼本身就是探測器**——不需要新增錯誤類別，
只需對一個早已看得見的 `stopReason` 採取行動。

由此得出一條零成本的自我糾正回路：當插件自己發出的請求其 `max_tokens`
被 `clampMaxTokensToContext` 壓低到低於該模型宣告的輸出上限時，
該條件**只可能**源於 `contextWindow` 低報。此時應記錄該事件、
在能力卡標記「宣告值疑似低報」、並提供一次性驗證入口。
**夾逼不發生即無成本，故此回路對從未接近上限的模型完全不啟動。**

⚠️ **`reasoning_tokens` 在極小預算下不可信**：於 `max_tokens: 4` 時上游回報
`reasoning_tokens: 8` 而 `completion_tokens: 4`，內部自相矛盾。
本 ADR 的檔位軸以 `reasoning_content` 的**出現與否**為判準（非其計數），
且全部量測均在 `max_tokens: 1024` 下取得，故既有結論不受影響；
但任何讀取 `reasoning_tokens` 作為依據的新程式碼必須沿用同一預算下限。

**十、`ling-3.0-flash-fin-free` 確認下架。**五次跨數小時的嘗試全部回
`Endpoint is unavailable.`，故 `toggle` 三件套無法補齊，R5 在該模型上
永久維持未量測。

**十一、兩條通道對 Off 的語義相反——上一稿把它們當成同一件事是錯的。**

先前所有檔位量測都在 `openai-completions` 通道上（經 `interleaved` 或 `toggle`
路由者）。但兩個活躍模型走 `openai-responses`，而 pi-ai 在兩條通道上
產生的是**不同結構**：completions 發頂層 `reasoning_effort`，
responses 發巢狀 `reasoning: { effort }`。

實測 `muse-spark-1.3-contributor-free`，`POST /zen/v1/responses`：

| body `reasoning` | HTTP | `reasoning_tokens` |
|---|---|---|
| **不存在** | 200 | **360**（上游預設＝最大值） |
| `{effort:"none"}` | **400** | `reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'. Supported values: [minimal, low, medium, high, xhigh, max]`，`param: "reasoning.effort"` |
| `{effort:"low"}` | 200 | 180 |
| `{effort:"minimal"}` | 200 | 68 |

四項後果：

1. **`none` 在 responses 被拒絕**，恰在其於 completions 有效的同一拼寫。
   故 R1/R3 若發 `none`，在 responses 上是硬 400。
2. **省略在兩條通道上語義相反。**completions 上省略＝上游預設；
   responses 上省略＝**最大推理**（360 tokens）。故「沒有 Off 列」在此通道
   意為「此模型盡其所能地思考」，而非「什麼都不發生」。
3. **規則結論不變，但理由必須換掉。**`channelFor` 僅在
   `reasoning_options` 含 `effort` 項時才路由至 responses，故
   **每一個 responses 模型都必然有檔位**，R2（`off:null`）已涵蓋全部，
   R1/R3 在該通道永不觸發。此點須明寫，不可僅以 space-bunny 的
   completions 觀察作為 R2 的唯一依據。
4. **該 400 自我陳述了檔位**：`Supported values: [minimal, low, medium,
   high, xhigh, max]`，與上下文軸的 `maximum context length is N tokens`
   結構相同——**兩軸皆有自述型 400 可採集**，泛用 400 盲區對這兩種
   自述形態皆不適用。

**十二、responses 通道不串流推理，偵測必須改讀 usage。**
實測幀型別為 `response.created`、`response.in_progress`、
`response.output_item.added/done`、`response.content_part.added/done`、
`response.output_text.delta`、`response.completed`、`ping`；
**不存在** `response.reasoning_summary_text.delta` 或任何推理 delta，
儘管 pi-ai 併送 `summary:"auto"`。推理**僅**經由
`usage.output_tokens_details.reasoning_tokens` 可觀察。
故任何「在流中找推理」的偵測方式在此通道會得出「沒有推理」的錯誤結論，
而該模型剛剛思考了 360 tokens。

**十三、onPayload 守衛目前正把一個響亮的 400 轉成靜默的謊。**
案例 2 證明帶 `reasoning:{effort:"none"}` 的請求會被拒。因守衛先行移除該物件，
「Off」抵達上游時變成「無 reasoning 欄位」而被接受——於是 muse-spark 的
「Off」實得 **360 tokens（最大值）**並回覆一次外觀正常的答案。
**使用者選擇關閉推理，得到的是最大推理，且全鏈路無任何告警。**
移除守衛則 muse-spark 會響亮地 400。故守衛必須保留，但其 responses 分支
**不得**在模型有宣告檔位時進行移除——那正是把拒絕轉成靜默的操作。

**十四、C4 的簽名已在生產路徑上端到端確認，但條件 2 的方向是錯的。**

實測（經 pi-ai 真實的 `streamSimple` → `buildBaseOptions` →
`clampMaxTokensToContext`，`max_completion_tokens` **自線上請求體讀出**而非推斷；
`mimo-v2.6-flash-free`，宣告 200000，未手動傳入 `max_tokens`）：

| 估算 | 夾逼計算 | 線上實際 | `stopReason` | C4 判據 |
|---|---|---|---|---|
| 150,000（對照） | 32000 | **32000** | `stop`，content `["thinking","text"]` | false |
| **198,000** | −2096 → `max(1,·)` → **1** | **1** | `length`，content `[]` | **true** |
| 201,500 | **1** | **1** | `length`，content `[]` | **false** |

**簽名成立。**但第三行暴露了條件 2 的方向錯誤：

> 夾逼在估算 **≥195,903** 即塌成 1，而條件 2（`估算 < contextWindow`）在
> **200,000** 即失效。故 C4 只覆蓋 **195,903 … 199,999**，在 **≥200,000**
> 時靜默——**而那裡發生的是完全相同的失敗**。

該排除原意是「區分夾逼與合法用盡預算」。但整份文件的前提正是
`contextWindow` 被低報，故「估算 ≥ 宣告窗口」不代表上下文真的滿了，
只代表手上的數字是錯的。**條件 2 拿一個我們正在質疑的數字，去判斷我們
質疑本身是否成立——這是循環論證，且恰好在最需要它響的區間失聲。**

**修正後的條件 2 按「是否有實測值」分流：**

- **該模型已有實測上下文** → 條件 2 = `估算 < 實測值`。此時判據成立且可稽核。
- **該模型未量測** → **僅憑簽名即觸發**。因為無法區分，而兩種失敗的
  代價不對稱：漏判是靜默的零輸出，誤判則被 `min(宣告×4, 1048576)` 的蓋
  限住，只會讓夾逼停止觸發——把靜默死亡換成一次可見的截斷。

這與 C1「未量測時永不代入宣告值」並不衝突：C1 約束的是**預設值**，
此處約束的是**偵測門檻**，兩者方向相反是刻意的。

⚠️⚠️ **上述修正已被下一輪實測推翻，不得採用。**

**十五、C4 的第一個合取項會在健康模型上觸發；救回來的是 `hasAnswer`，
而提議中的修正恰好要繞開它。**

以 `ling-3.1-flash-free`（**宣告 262144、實測 262144，完全正確**）
在懸崖之前施壓，夾逼梯度如下：

| 估算 | 夾逼 | 線上 `max_completion_tokens` | `stopReason` | content | `hasAnswer` | C4 |
|---|---|---|---|---|---|---|
| **258,000** | **48** | **48** | **`length`** | **`["thinking"]`** | **true** | **false** |
| 258,048 | 1 | 1 | `error` | `[]` | false | false |
| 258,048 | 1 | 1 | `aborted` | `[]` | false | false |

**窗口完全正確的模型，`stopReason` 依然是 `length`。**故
`stopReason === "length"` **不是**低報的判別式。
本例中被 `hasAnswer === true` 救回——模型把 48 個 token 全花在推理上、
沒有餘裕輸出文本，但 thinking 片段仍算應答。

**而提議中的「未量測模型僅憑簽名觸發」恰好會移除這個唯一的救兵。**
那會使健康模型在首次長對話中被誤判，而蓋隨即把本來正確的 262144
抬到 1048576——**設計所防範的悲劇，正是它自己製造的**。

**正確的判別式是夾逼值本身，而非估算比較：**

> **C4 條件：`wire max_completion_tokens === 1`**（而非「小於某值」，
> 亦非「估算 < contextWindow」）

依據即上表：夾逼到 **48** 時模型仍有 thinking（應答存在），
夾逼到 **1** 時 content 為空。`=== 1` 乾淨地分開兩者，且

- **線上可觀測**——`onPayload` 讀的就是發出後的數字，零推斷
- **與模型無關**——不依賴該模型是否吐 thinking 片段
- **不需要估算器**——故 §十四 所述的循環論證問題一併消失
- **不需時鐘、不需實測值**——故未量測模型同樣可用

`max_completion_tokens === 1` 只在 `估算 ≥ contextWindow − 4097` 時成立。
對一個**窗口正確**的模型，這意味著上下文真的滿了——此時抬高空窗是錯的。
但該情境下正解是壓縮而非擴窗，且沒有配置壓縮時抬窗會把靜默的 1 token
換成一次可見的上游拒絕。**可見失敗優於靜默失敗，故此殘餘誤報可接受。**
§十四 的估算條件 2 保留為**次要**防護，不得作為主判別式。

**本地回放與反事實（零配額，已核）：**

以全部四行有效觀測資料回放，新舊判別式結論一致——但這掩蓋了關鍵區別。
反事實顯示：**舊判別式在健康模型上的安全性取決於該模型當次是否吐 thinking 片段，
是運氣而非設計**：

| 健康模型（wire=48、`length`） | 舊判別式 | 新判別式 |
|---|---|---|
| 恰好吐了 `thinking` | false | false |
| **恰好沒吐** | **true（誤報）** | **false** |

新判別式的安全性是**結構性**的：`wire=48` 永遠不等於 1，與模型行為無關。

且 `wire === 1` 是夾逼的**數學必然**，只要估算越過 `contextWindow − 4097`
即成立，與估算器精度、模型、通道皆無關（本地驗算：
est=195902→clamp=2 不觸發；est=195903→1 觸發；est=200000、500000→1 皆觸發）。
**故 §十四 所述「≥200,000 靜默」的缺口由構造性關閉**——
新判別式不含估算比較，該區間不再漏判。

**十六、R5a 已由 n=1 升至 n=3，外推成立。**

`reasoning_options: []` 形狀的三個活躍模型全部測得 `none` **被接受且被遵守**
（`reasoning_content` delta 由存在轉為消失，皆無 400、無靜默空轉）：

| 模型 | 省略 | `reasoning_effort:"none"` |
|---|---|---|
| `nemotron-3-ultra-free` | 49 tok | **0 tok**（completion 115 → 12，跨兩次執行重現） |
| `mimo-v2.6-flash-free` | 37 tok | **0 tok**（completion 98 → 38） |
| `nemotron-3.5-lightning-free` | 30 tok | **0 tok**（completion 71 → 17） |

三者的效應皆顯著而非邊緣。故 `[]` 形狀下 `none` 有效已非單點推論。
此結果同時把三種形狀的分野釘死：**`[]` 接受並遵守 `none`**、
**宣告檔位拒絕它（400）**、**`toggle` 接受但忽略它**（`longcat` 71/71）。

**十七、簽名不只一種失敗模式，單靠 `length` 會漏判。**
於夾逼 `=== 1` 時，`ling-3.1-flash-free` 產生的是 `error`（3.0s）
與 `aborted`（**燒滿 300s 超時**），**從未**產生 `length`；
而 `mimo-v2.6-flash-free` 給出乾淨的 `length`。
故 `stopReason === "length"` 不是可靠主判別式——它會漏掉上述兩種形態。

> **一句話記住判別式的選擇理由：回應通道會變，請求通道不會。**
> `max_completion_tokens === 1` 有三條彼此獨立的正當性：
> (1) 精確分離觀測到的兩種情形（48-有內容 vs 1-空內容）；
> (2) 不需估算器，也不需與可能錯誤的 `contextWindow` 比較；
> (3) **與上游行為無關**——任何讀*回應*的判別式都在讀一個我們已觀測到
> 會對同一條件分別發出 `length`、`error`、`aborted` 的通道。

⚠️ **`aborted` 形態帶來真實的使用者成本**：模型停滯而非截斷時，
該請求燒滿 **300 秒**超時。使用者須等待五分鐘才有任何東西可反應；
若觸發條件只看 `length`，則可能永遠不反應。
故偵測必須以**請求側**的 `max_completion_tokens === 1` 為準，
而非等待一個可能永不到達的回應側訊號。

**誤報率的正確敘述**：不是「高」，而是**在唯一一個有效觀測點上 1/1**——
而該點之所以未構成誤報，救回它的是 `hasAnswer()` 把 `thinking` 片段算作應答，
這是一個插件因**另一個理由**（issue #3010）而有的行為，
**不是 C4 可以依賴的性質**。故「1/1 但僥倖未犯」比任何比率都更誠實。

⚠️ **R5a 的 n=3 並非三個獨立實作**：`nemotron-3.5-lightning-free`
與 `nemotron-3-ultra-free` 同屬 nemotron 家族，真正提供獨立證據的是
**`mimo-v2.6-flash-free`**。故 R5a 的實際獨立樣本數為 **n=2**，
其中 mimo 是唯一不共享家族的對照。


**估算器校準（三點、兩種方法互相印證）：**估算 150,000 對上游
`input + cacheRead` = 106,710，比值 **0.7114**；198,000 → 140,772（0.7110）；
201,500 → 143,264（0.7110）；與上下文掃描所得 0.7181 一致——
**pi-ai 的估算器在此文本上穩定高估約 40%**。⚠️ 比較時必須用
`input + cacheRead`，單看 `input` 會因緩存命中而嚴重低估
（實測 `input: 36,576` 而 `cacheRead: 106,688`）。

**十八、解法已驗證有效，但生產讀取路徑與實測不同——此為上線阻斷項。**

**解法有效（Test A）：**`mimo-v2.6-flash-free` 宣告 200000，
將 `contextWindow` 抬至 `min(宣告×4, 1048576) = 800000` 後，
於 250,000 估算下線上 `max_tokens` 回到 **32000**（非 1）、
`stopReason: stop`、正常作答；700,000 估算同樣成立。
**新懸崖在 795,904**——即解法把懸崖從 195,903 推到 795,904（4.06×），
**而非消除它**。一次修復只買到宣告值的 4 倍，此數字須寫入文件。

**蓋的失效形態可見（Test B）：**在窗口正確的 `ling-3.1-flash-free` 上
模擬誤報抬窗至 1048576、送 300,000 估算，得到**可見的 HTTP 400**，
且報文自述真值：

> `This endpoint's maximum context length is 262144 tokens. However, you
> requested about 332025 tokens (299939 of text input, 86 of tool input,
> 32000 in the output).`

故**自述採集在生產錯誤路徑上同樣成立**，不僅在刻意超發的探測上成立。

⚠️ **上線阻斷：生產線上欄位名是 `max_tokens`，不是 `max_completion_tokens`。**

pi-ai 的 `detectCompat` 對 `baseUrl` 含 `opencode.ai` 的情形，
因 `useMaxTokens` 為 false 而推導出 `max_completion_tokens`；
但模板 `mimo-v2.6-flash-free` 的內建 compat 帶有顯式
`maxTokensField: "max_tokens"`，`buildModel` 在通道未變時繼承它，
且 `openai-completions.js:1317` 讓**顯式 compat 優先於偵測結果**。
實測確認：**36 條派生記錄中 31 條**帶顯式 compat 且
`maxTokensField: "max_tokens"`，僅 5 條 `openai-responses` 記錄
因通道改變而丟失 compat。

**若 C4 讀 `max_completion_tokens`，將在 31/36 的模型上讀到 `undefined`
而永不觸發——檢測器會以「靜默失效」的方式上線。**

**修正讀取路徑，而非重測。**先前全部實測皆用手建記錄（無 compat），
故欄位名不同而**夾逼值同樣是 1**，**數值結論全部有效**；
需修的只是「從哪裡讀」：依 `model.compat?.maxTokensField` 決定欄位名，
缺省 `max_completion_tokens`。`onPayload` 兩條通道皆已收到 `model`
（`types.d.ts:78`），故**無需宿主變更**。

**完整的線上欄位映射（本地對全部 36 條派生記錄實測得出）：**

| 線上欄位 | 記錄數 | 來源 | C4 可自我糾正 |
|---|---|---|---|
| `max_tokens` | **31** | 模板 compat 顯式攜帶 `maxTokensField` | **是** |
| `max_output_tokens` | **5** | responses 通道 | **否** |

⚠️ **第三種情況：responses 通道結構上不可能出現值 1。**
`openai-responses.js:230-231` 為
`params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS)`，
而 `OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16`（`:17`；
註解明言 OpenAI Responses 拒絕低於 16 的 `max_output_tokens`）。
故 **`=== 1` 判別式在那 5 條記錄上永遠不成立**——
它們無法經由夾逼自我糾正，只能依賴按需驗證。

此為結構性事實而非缺陷：那 5 條記錄的夾逼本來就不會塌到 1
（pi-ai 在發出前已抬高至 ≥16），故無可糾正之事。
但它意味著 **C4 的覆蓋率是 31/36 記錄、10 個活躍模型中的 8 個**：
`fledge-alpha-free` 與 `muse-spark-1.3-contributor-free`
**永遠不會自我糾正**，能力卡必須如實標示，而非假設自我糾正恆成立。

**十九、同一個 `[]` 形狀內部，`none` 的接受與否不一致——R5a 因此失效。**

`big-pickle` 與前述三個模型在 models.dev 上**形狀完全相同**
（`reasoning_options: []`），卻**拒絕** `none`：

| 模型（皆 `reasoning_options: []`） | 省略 | `reasoning_effort:"none"` |
|---|---|---|
| `nemotron-3-ultra-free` | 49 tok | **0 tok** |
| `mimo-v2.6-flash-free` | 37 tok | **0 tok** |
| `nemotron-3.5-lightning-free` | 30 tok | **0 tok** |
| **`big-pickle`** | **55 tok** | **HTTP 400 `invalid_request_error: invalid request`** |

**4 中 3 接受、1 硬拒。**按 R5a 原樣實作，`big-pickle` 今天就會在使用者
選擇 Off 時直接 400。這是 n=2 無法捕捉的失敗型。

⚠️ **該 400 為泛用形態**，與 `big-pickle` 自身的上下文溢出 400、
以及 `space-bunny-free` 對 `"none"` 的 400 **逐字相同**，故報文不自述成因。
因果歸屬 rests 在受控對照上（同一請求僅 `reasoning_effort` 一項不同，
省略時回 200 並給出 `reasoning_tokens: 55` 與正確答案），
**這是推論而非自述**，其可接受的懷疑程度即止於此。

**結論：形狀對本軸完全沒有預測力。**這與 `toggle` 的發現是同一件事，
但由**獨立方向**第二次抵達——`ling-3.1-flash-free` 有效而
`longcat-2.5-preview-free` 無效，形狀同為 `[toggle]`；現今 `[]` 形狀內部
再出現接受與拒絕之分。**故 R5a 與 R5b 一併塌縮為同一條規則：**

> **未測量 → 去測量。形狀不是預設值的依據。**

未測量的推理模型一律 `off: null`（不提供該行，誠實），
由探測輪轉為 `"none"`（實測有效）或維持 `null`（實測無效／被拒）。
代價是每輪至多每個未測量推理模型一個請求，收斂後趨近於零。

**二十、夾逼的劣化是漸進的，不存在第二道懸崖。**
`mimo-v2.6-flash-free`（宣告 200000），夾逼梯度實測：

| 夾逼 | 1,904 | 904 | 5904 | 4,904 | 32,000 |
|---|---|---|---|---|---|
| `stopReason` | `stop` | `stop` | `stop` | `stop` | `stop` |
| content | `["thinking","text"]` | 同左 | 同左 | 同左 | 同左 |

推理量在全程維持 4–13 token，預算從未成為約束。
**轉折點落在 (1, 904] 之間，904 以上無任何破壞。**
故 `declared×4` 這個蓋不與任何其他數字競爭——
使用者感受到的是漸進劣化，而非第二道 cliff。

**二十一、懸崖已釘死在 (1, 64]，且全程不存在「只有 thinking」的中間形態。**

| 夾逼 | 64 | 256 | 904 | 1,904 | 4,904 | 5,904 | 32,000 | **1** |
|---|---|---|---|---|---|---|---|---|
| `stopReason` | `stop` | `stop` | `stop` | `stop` | `stop` | `stop` | `stop` | `length` |
| content | `[thinking,text]` | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 | **`[]`** |

自 64 至 32,000 的每一個預算都**同時**產生 `thinking` 與 `text`；
由 64 的 `[thinking,text]` **直接**跳到 1 的 `[]`，無中間形態。

故兩件事同時成立：

1. **C4 不需要第三個子句**——沒有 thinking-only 的結果需要處理。
2. **`hasAnswer()` 的「thinking 算應答」從未真正承重。**§十五 的反事實
   顯示它僥倖救回了一次誤報，而此處證實它在整條量測曲線上一次都沒有
   生效過——它只是一個**恰好成立**的巧合，**不得作為設計依賴**。
   這也再次印證 `max_completion_tokens === 1` 是唯一穩健的判別式。

真實懸崖依推理量落在 (1, 64] 之間（由夾逼 64 時
推理 12 + 文本約 5 = 17 token 推得，**屬算術推估而非量測**）。

**二十二、探測成本：一個請求即足以分類，但實作有一個會使成本永不收斂的陷阱。**

⚠️ **成本更正。**自由集為 36 個模型，其中 **34 個發布 `reasoning_options`**
（`[]` 15、toggle 8、effort 9、toggle+effort 1、toggle+budget_tokens 1、
完全無宣告 2）。先前以「活躍 10 個、可見 6-7 個」估算，是選擇器視圖而非
目錄視圖。**樸素的 A/B 為每模型 2 個請求 → +68**，超過 34 請求輪次的一半。

**但單請求即足以分類**，因三種結果自帶可分性：
`400` = 拒絕；`200` 且 `reasoning_tokens > 0` = 接受但忽略（即 `longcat`）；
`200` 且 `= 0` = 遵守。唯一無法以單次探測分辨者，是本來就不推理的模型——
而該情況下「省略」與「發 `none`」行為等價，故該歧義無害。

⚠️⚠️ **收斂陷阱（會使成本永久翻倍）。**`isSettled`
（`src/catalog.ts:1129-1133`）僅對 `dead` 且 `swept` 回傳 true，
**`ok` 永遠不算 settled**；而 `planRound:1157` 的目標是
`live.filter(isShown && !isSettled)`。故現有的存活性探測
**每一輪都會重探每一個存活的已顯示模型，永不收斂**，
唯一的節流是 `lastProbeAt` 把整輪限制為每日一次。

因此：**若把檔位量測搭在存活性判定上（`ok`），將是每模型每天 +1 且永不歸零。**
**必須以「該 id 是否已有檔位量測」作為自身的收斂條件**，
第一輪後即歸零。這是實作上唯一會把「一次性成本」變成「永久日成本」的地方。

**二十三、R1 與 `budget_tokens` 分支對活躍模型零可達，是推測性泛化。**

本地對當前名單逐條核對分支可達性：

| 分支 | 可達模型 | 狀態 |
|---|---|---|
| R1（檔位含外來拼法如 `none`） | `north-mini-code-free` | **僅 1 個，且 deprecated + 401** |
| `budget_tokens` | `qwen3.6-plus-free` | **僅 1 個，且 deprecated + 401** |

**活躍模型中兩者皆零可達，且永不可測**（承載它們的模型已下架）。

故 R1 不是一條規則，而是**推測性泛化**：它在設計中佔位卻無任何證據，
且其唯一實例已不可及。處置為**保留程式路徑但明確降級標註**——
名單會輪動，新的活躍模型可能發布外來拼法，故路徑仍需存在；
但**不得以「已實測」的語氣陳述**，亦不得佔用一項獨立的測試與證據位。

同理 `budget_tokens`（`qwen3.6-plus-free` 發布 `max: 81920`）：
pi-ai 的 `ThinkingBudgets` 在三層皆無對應的模型級欄位，
故此分支無論如何都不可表達，僅記錄不可表達之事實。

⚠️ **準確的措辭：R1 今日不可達，是因為 Zen 不服務那兩個模型，
而非因為它們被標記為 `deprecated`。**此區別決定該規則的未來命運：

- models.dev 在 36 個免費記錄中，`status: "active"` **出現零次**
  （10 個無 `status` 鍵、26 個 `deprecated`，本地實測確認）。
  故「活躍」並非 models.dev 的詞彙；本文件此前使用的「活躍模型」
  實指 **Zen 正在服務者**。
- 插件的目錄**刻意**把 `status ∈ {active, deprecated}` 都當候選
  （`DerivedCatalog.candidates`），並以 **Zen 的閘門作為唯一可用性權威**。
  實測印證：Zen 服務的 10 個免費模型全部無 `status` 鍵，但機制上
  一個 `deprecated` 模型若被 Zen 服務**照樣會出現在選擇器裡**
  （`muse-spark-1.2-contributor-free` 即為此例，它 deprecated 卻被服務）。

**故不得把 R1 讀成「我們證明了這不可能發生」。**事實是「今日無物抵達它」。
若 `north-mini-code-free` 重回 Zen 的服務名單，R1 即重新生效——
屆時它是**未實測**，而非**已證偽**。標註必須反映這個差別。

**二十四、方法論：兩個最重要的發現都來自跑梯度，而非跑單點。**

- **C4 的誤報觸發是 `length` 而非夾逼本身**——只有在夾逼 48、256、904
  這些「夾逼確實發生了但模型仍正常作答」的中間點上，
  才會看到 `stopReason === "length"` 竟在**窗口完全正確**的模型上出現。
- **R5a 無法從形狀判定**——只有在把 `[]` 形狀的四個模型全部測過、
  發現 3 個接受、1 個硬拒之後，「形狀有預測力」這個前提才崩潰。

**所有單點測量看起來都沒問題。**每一個單獨看都自洽且合理；
是梯度與對照組把它們放在一起時，兩個錯誤前提才暴露出來。
此紀律應寫入未來的驗證流程：**凡打算把「某參數發出去」當作正確性證明的，
必須同時測該參數取值梯度上的鄰居點。**

**二十五、未宣告的檔位其實被接受——R5 的一半必須撤回。**

以**產品自帶的 liveness 探測配置**（`PROBE_PROMPT = "hi"`、
`reasoning: "low"`、`max_tokens: 1024`）實測全部被服務的免費模型，
得到一項推翻本文件既有前提的觀察：

> **`reasoning: "low"` 並未被夾逼成省略。**
> 每一個 completions 模型——包含全部四個 `[]` 無檔位模型——
> 都攜帶 `reasoning_effort: "low"` 上線，
> 因 `clampThinkingLevel` 在 `thinkingLevelMap` 為 `undefined` 時保留 `"low"`
> （它屬預設的非 opt-in 檔位）。

**而它們全部接受，並產生非零推理：**

| 模型 | 省略 | `"low"` |
|---|---|---|
| `big-pickle` | 55 tok | **164 tok** |
| `nemotron-3-ultra-free` | 49 tok | **16 tok** |
| `nemotron-3.5-lightning-free` | — | 93 tok |
| `ling-3.1-flash-free` | — | 69 tok |

**故本文件此前主張 null 掉的「幽靈檔位」，其實是可工作的控制。**
將其移除是**刪除真實能力**，與本工作的初衷相反，必須撤回。

⚠️ 但語義不可跨模型推斷：`big-pickle` 的 `low`(164) **多於**省略(55)，
而 `nemotron-3-ultra-free` 的 `low`(16) **少於**省略(49)——**方向相反**。
故檔位名不具一致語義，卻普遍被接受且都產生推理。

**修正後的處置：兩類控制分別對待，因證據不同。**

| 控制 | 證據 | 處置 |
|---|---|---|
| 檔位列（`minimal`…`high`） | **四個模型實測接受**，產生非零推理 | **保留預設階梯**，於能力卡標記「語義未驗證」 |
| Off 列 | 三種後果均已實測（有效 / 無效 / 400） | **逐模型量測**；未量測者 `off: null` |

**撤回的內容**：原 R5 要求「未發布者一律 `null`」，該要求僅適用於 `off`，
**不再適用於階梯列**。淨效果因此比原 R5 小得多——
對無檔位 completions 模型而言，唯一變更就是**移除 Off 列**，
階梯列維持現狀。

**二十六、R4' 的措辭必須收窄：`big-pickle` 拒絕的是 `none`，不是未宣告值。**

`big-pickle` 在 `reasoning_effort: "low"` 下回 200 並產生 **164 reasoning tokens**，
在其 `none` 下回 400。故其 400 **特異於 `none`**，
它有一個包含 `low` 但不含 `none` 的詞表。
先前「400 = 拒絕未宣告值」的讀法過寬，現由數據收窄。

連帶使 `"zzz"` 對照具備判別力：`"zzz"` 400 而 `"low"` 200，
二者確實在做區分——此對照先前被判定為「無法區分」是因為
它在只有泛用 400 的語境下被讀取，現已具備對照組。

**二十七、產品 liveness 探測的 15 秒超時：足夠，但不寬裕。**

以產品配置實測全部被服務的免費模型：

| 模型 | 延遲 | ≤15s |
|---|---|---|
| `mimo-v2.6-flash-free` | **24,022 ms** | **否** |
| `nemotron-3.5-lightning-free` | 5,720 ms | 是 |
| 其餘八個 | 1,767–3,670 ms | 是 |

`mimo` 重跑兩次為 **1,425 / 2,239 ms**，故 24,022 ms 為十中之一的離群值；
排除離群值後最大 5,720 ms（2.6× 餘量）。

**故結論為「足夠」而非「寬裕」**——十次裡確有一次超過。
失敗模式良性：超時記為 `inconclusive` 且**永不持久化**
（`src/catalog.ts:1459-1462`），故得到的是**靜默缺一條測量**
而非**記錯一條測量**。但輪次完整性因此是**概率性的**，
不得以「每輪必然收斂」描述之。

另：Zen 實際服務 **13 個**免費模型（非 10 個）；
其中三個已知下架，故未納入延遲測試。

**二十八、預設階梯被全部接受，但五個模型無一單調——它不是階梯。**

⚠️ 前一節的模型清單有誤：`ling-3.1-flash-free` 發布的是 `[{"type":"toggle"}]`
而非 `[]`。被服務的免費模型中，真正的無檔位族群是**五個**：
`big-pickle`、`mimo-v2.6-flash-free`、`mimo-v2.5-free`、
`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`。以下為五者之實測。

**接受度：15/15 全部 HTTP 200**，且線上欄位名在 15 次中**完全一致**
為 `reasoning_effort`，故按該名解析對此族群安全。

**但單調性：五者無一單調。**

| 模型 | `minimal` | `low` | `medium` | `high` |
|---|---|---|---|---|
| `big-pickle` | **0** / 8 | **164** | 15 / 14 | 23 / 38 |
| `mimo-v2.6-flash-free` | 16 | 16 / 18 / 11 | 15 | 16 |
| `nemotron-3-ultra-free` | 19 | 16 | 22 | **14** |
| `nemotron-3.5-lightning-free` | **148** | 93 | **85** | 120 |
| `mimo-v2.5-free` | 83 | **4** | 26 | 118 |

`nemotron-3-ultra-free` 的 `high` 是全列最小；`mimo-v2.5-free` 的 `low` 是最小；
`big-pickle` 的 `low` 是其餘的六至十倍。**使用���選 `high` 想多想，
在其中兩個模型上得到的反而更少。**

**故「語義未驗證」不是悲觀，是唯一誠實的標籤。**
能力卡**不得**聲稱這是一條階梯，只能聲稱「存在四種不同的模式」——
這四種模式確實都改變行為（皆非零、皆被接受），但其相對次序與標籤無關。

**保留階梯的正當理由因此必須重新陳述**，不是「它提供深度控制」
（實測證偽），而是：**它提供通往不同 regime 的通道**。
最有力的一例是 `minimal` 在 `big-pickle` 上把推理降到 **0**
（對照 `low` 的 164）——`none` 做不到的事 `minimal` 做到了。
故對想要「少想」的用戶，四個未排序的模式中總有一個給得到。
刪掉階梯等於刪掉這個通道，**這才是不可接受的**。

⚠️ `minimal` 在 `big-pickle` 上關閉推理一事為 **n=2 且 0/8 離散**，
**屬線索而非結論**，不得作為 null `minimal` 的依據。

**二十九、15 秒超時不再是孤例。**

§二十七 的 `mimo` 24,022 ms 重跑未復現；本次
`big-pickle` 在 `medium` 上 **20,723 ms 與 16,237 ms 兩次獨立復現**
（其 `minimal`／`high` 僅 2.3–7.3 s，故代價特異於 `medium`）。
兩次均為 HTTP 200 且正常返回，純屬延遲問題。

故正確陳述是：**至少一個被服務的模型會在某個檔位上系統性地超過產品超時。**
但存活性探測固定送 `reasoning: "low"`，而 `big-pickle` 的 `low` 為 3,670 ms，
故**存活性路徑本身未受影響**；受影響的是任何會發送其他檔位的探測。

⚠️ **已量測：檔位探測實際使用的 `none` 拼寫之延遲。**

由本會話全部 16 次 `none` 請求的延遲記錄反查（無需新請求）：

| 範圍 | 模型 | 延遲 |
|---|---|---|
| 15 / 16 | 各模型 | **447 – 7,051 ms** |
| **1 / 16** | `nemotron-3.5-lightning-free` | **23,494 ms** |

該次**確實完成**並回傳 0 reasoning tokens——只是慢。
**在 harness 的 180 秒超时下它成立；在產品的 15 秒超時下它會被記為
`inconclusive` 而永不持久化。換言之，本文件所記載的這一條量測，
在產品配置下根本不會存在。**

這是上述「看不見的收斂失敗」的第一個**確證實例**，而非推測。

收斂**不會被阻斷**，因為沒有任何模型在 `none` 上持續偏慢
（`nemotron-3.5-lightning-free` 為 23.5 s / 1.1 s 的方差，非穩態），
且 `inconclusive` 不持久化故會重試。但每模型每輪存在約
**1/16 的遺漏機率**，故收斂時間是**概率性延長**而非恆定。

**故產品超時需要一個明確決定，而非沿用 15 秒：**

- 存活性路徑固定送 `reasoning: "low"`，實測最慢 3,670 ms，**15 秒充裕**
- 檔位路徑送 `none`，實測最慢 23,494 ms，**15 秒不足**

兩條路徑不應共用同一個超時常數。此為落地時必須拆開的決定。

**三十、`none` 有兩條投遞路徑，其中一條會靜默退化——R3 必須走對的那條。**

`"none"` **不在 pi-ai 的檔位詞表內**
（`EXTENDED_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`，
`models.js:553`）。故兩條路徑的命運完全不同：

| 路徑 | 做法 | 結果 |
|---|---|---|
| **A** | 把 `"none"` 當**檔位名**傳給 `reasoning` 選項 | `indexOf("none") = −1` → `clampThinkingLevel` 落到 `availableLevels[0]` = `"off"` → `streamSimple` 映射為 `undefined` → **永不上線，退化為省略** |
| **B** | `thinkingLevelMap.off = "none"`，使用者選 **`off` 檔位** | `clampThinkingLevel(m,"off") = "off"`（在詞表內）→ `undefined` → `buildParams` 的 else 分支讀到 `offValue` 為字串 → **`params.reasoning_effort = "none"`** |

**本地以 pi-ai 的實際函數驗證兩條路徑（零配額）**，結論如上。

**故 R3 可以上線，但前提是實作時經由 map，不得把 `none` 當檔位名。**

這是真實陷阱，且失敗形態與本工作全程所防範者完全相同：
「R3 已實作、Off 仍不生效」、全鏈路無任何錯誤。
故此條必須成為**帶名稱的測試**：斷言線上 `reasoning_effort === "none"`，
而**非**斷言 map 的形狀——後者兩條路徑都會通過。

⚠️ 本會話的實測有效性亦取決於此：`probe-off.mjs` **直接組原始 body**，
故 `"none"` 確實上了線（nemotron/mimo 得 0、big-pickle 得 400 皆有效）；
而任何經由 `streamSimple` 的 harness 都會把 `"none"` 吞掉。
**兩類 harness 的結果不可混用。**

**三十一、`off` 的處置由「最低可用檔位」找回，而非一律 `null`。**

`none` 失敗的模型上，仍可能存在能用的 Off——只是不叫 `none`：

| 模型 | `none` | 最低候選 | 六樣本 | 結論 |
|---|---|---|---|---|
| `big-pickle` | **400** | `minimal` | **0, 8, 0, 0, 8, 0**（四次精確零） | **`off: "minimal"`** |
| `space-bunny-free` | **400** | `low`（最低宣告檔） | `0, 22, 0` 對省略 `35, 55, 36, 42` | **`off: "low"`**（四對樣本無重疊） |
| `longcat-2.5-preview-free` | 接受但無效（71/71/80） | `minimal` | **36** | **`off: null`** |

故規則由「`none` 失敗即 `null`」改為：

> **`off` → 實測能將推理降至接近零的最低檔位；無此檔位者才 `null`。**

⚠️ **兩條路徑回收的都不是「完全不思考」，而是「最低可用檔位」**
（`big-pickle` 0–8、`space-bunny` 0–22）。若能力卡標示 Off，
其文案必須經得起使用者發現該行仍有 8 或 22 個推理 token 的檢驗。
**否則 `null` 與其給出零控制，不如給出可稽核的近似並說明之。**

⚠️ **`minimal` 僅在 `big-pickle` 上接近零**：`nemotron-3.5-lightning` 的 `minimal`
為 148、`mimo-v2.5` 為 83、`nemotron-3-ultra` 為 19、`mimo-v2.6` 為 16。
**故「`off` → 最低檔位」必須逐模型量測，一個模型一次請求。**

⚠️ **`mimo-v2.5-free` 的 `none` 行為仍未量測**——其最近一次發送經由
`streamSimple`，`"none"` 被吞掉，故該次結果**不可讀作接受**。
在原始路徑上補測之前，R4' 仍只有 `big-pickle` 一個實例。

**三十二、決定性發現：乾淨的 200 並不等於量測成立。R4' 應刪除而非改寫。**

`big-pickle` + `reasoning_effort: "none"` 的九次完整記錄：

| 提示詞 | 樣本 | 結果 |
|---|---|---|
| `What is 17 * 23?`（416 tok） | 400, 400 | 「總是拒絕」 |
| **`hi`（123 tok）** | **200, 400**, 200, 200 | **翻轉** |
| 183 / 242 / 286 / 344 tok | 各 200 | 接受 |

**對照組殺死了長度假設**：兩次**逐字相同**的 `hi`，一次 400、一次 200。
400 既出現在最短提示詞上，也出現在最長的——**不存在閾值**。
先前看似「算術題 vs hi」的乾淨二分，實為**間歇性故障的前兩個樣本**。

且當其返回 200 時，`none` 是**被忽略而非被遵守**：
推理 token 為 51 / 227 / 388 / 119 / 370，**無一次為零**。

⚠️⚠️ **這是與本軸其他一切失敗都不同的一種形態：**

> **探針回傳一個乾淨的 200，卻仍無法刻畫該模型。**

任何「探一次、持久化結論」的規則，約**三分之一**的首次量測會產出錯誤行，
**且無任何機制能偵測它**。這與 `inconclusive` 完全不同——
後者是探針明說「不知道」，而這裡是探針**看起來成功了**。

**故 R4' 從規則表中刪除**（不是改寫措辭）：一個會逐輪翻轉的結論
無法被持久化，任何持久化都只是在賭其中一次抽樣。

**三十二之二、修正後的規則：檔位結論必須取得「一致性」方可持久化。**

與 `swept`／`inconclusive` 的既有紀律同源，但門檻更高：

- **單次探測不得寫入檔位結論**（此為不變量 6 的延伸）
- **連續 N 次結果一致方可寫入**，N 未定但至少 3
- 任一次翻轉即作廢重問，**不作平均、不作多數決**——
  `big-pickle` 的 6/9 若取多數會得到「接受」，而接受後仍被忽略，
  多數決在此**複製了它試圖解決的問題**

⚠️ **其餘模型的「穩定」同樣未經證明**：三個遵守 `none` 的模型各僅 2–3 個樣本
（皆為 0），`longcat` 三個樣本皆非零。**它們與 `big-pickle` 的差別是
樣本數不足，而非已證明穩定。**故一致性要求適用於全部模型。

**實務上 `big-pickle` 的結論不受此影響**：其 `none` 兩種結果
（間歇拒絕／接受但忽略）**導向同一處置**——`none` 不可用，
而 `minimal` 已以六個樣本（0, 8, 0, 0, 8, 0，四次精確零）量得接近零，
故仍取 `off: "minimal"`。**兩條路徑殊途同歸，故此發現不推翻 §三十一 的結論，
但推翻了它所依據的 `none` 分類。**

**三十三、檔位宣告可信、上下文不可信——按字段分化的可信度，獲得交叉檢驗。**

`fledge-alpha-free` 從連續六次 500 恢復後，自我陳述其合法集合：

```json
[airlock_error] invalid request: reasoning_effort 'none' is unsupported;
allowed values: ["low", "high", "max"]
```

**該集合與 models.dev 為它宣告的階梯逐字吻合。**並經實際調用驗證：
`low`（321 推理字元）、`high`（135）、`max`（137）
**全部 HTTP 200 且均含推理內容**。

⚠️⚠️ **本節當時的推論已被推翻：自述只能證明「拼寫被接受」，不能證明「該檔位可用」。**
自述出現在 400 報文裡，它回答的是**解析器**接受哪些字串；使用者要的是
**這個檔位對個人開放**。兩者可以分離：上游收下 `max` 然後靜默路由到 `xhigh`，
仍回 200。

`muse-spark-1.3-contributor-free` 正是這個形態：自述含 `max`、
一次 `max` 請求回 200，而持久語料 `tests/measured-samples.json` 裡該樣本為
**`tokens: null`（n=1）**——**從未記下任何推理量**，因此「被遵守」與
「被降級」從未被區分過。2026-10-06 由使用者確認：**該路由的 `max` 不對個人開放**，
且 models.dev 也不發布它。原先記為「516 tokens、該模型最強模式、兩次確認」的
數字**在持久證據中不存在**（全倉庫唯一的 516 是上下文報文裡的另一個數），
該斷言作廢。

故「models.dev 不可信」必須收窄為：

> **models.dev 的 `reasoning_options` 在宣告檔位上可信；
> 同一資料源的 `limit.context` 可低報 5.24 倍。**
> 可信度是**按欄位分化**的，不是整體的。

⚠️ 兩項限定須同時記錄：`high`(135) 與 `max`(137) **不可區分**——
階梯頂端兩級在此提示詞上行為相同；且 `fledge-alpha-free`
**不發 `completion_tokens_details`**，推理量只能由串流 `reasoning_content`
字元數讀取，屬較弱的量測儀器，且每檔僅 n=1。

**三十四、唯一的免費驗證通道：`zzz` 自述收割。**

`fledge-alpha-free` 對**亂值**同樣自述：

```json
[airlock_error] invalid request: reasoning_effort 'zzz' is unsupported;
allowed values: ["low", "high", "max"]
```

**其餘全部模型對壞參數只回泛用 `invalid_request_error: invalid request`**
——`big-pickle` 的上下文溢出與 `zzz` 逐字相同，`space-bunny-free` 亦同。

故：**一個亂值請求即可收割完整檔位，但僅限會自述的模型。**
探測可對每個模型發一次 `zzz`，凡回 `airlock_error` 者取得真實詞表
並可與 models.dev 對照；沉默者才需退回檔位掃描。

此通道與檔位探測爭用同一個請求欄位，故**兩者交替即可**：
合併探針在相鄰輪次交替發送 `none` 與 `zzz`，**仍為零邊際配額**。
此為前沿上新增的一點：取得獨立驗證，僅付出**輪次延遲**而非配額。

⚠️ responses 軸仍為 **n=1**：`fledge-alpha-free` 在 completions 存活、
在 responses 仍回 500，與 `ling-3.0-flash-fin-free` 相同的通道不對稱。

**Decision**

**通用機制：三軸共用 `ProbeRecord`，同一套指紋失效規則。**

`ProbeRecord` 新增三個可選欄位，每個都帶 `(值, 指紋, 通道, 時間)`：
`effort`（Off 拼寫）、`context`（實測上限）、既有 `api`（通道）。
**失效以指紋為主，不以時鐘為主**——`reasoning_options` 或 `limit.context`
一變，指紋不匹配即作廢重測。`CACHE_VERSION` 保持 `1`：升級時舊快取無此欄位
即讀作「未量測」，正確且自癒；若 bump 版本，使用者已累積的 `verdict` 與
`api` 會被全丟掉，換來一天降級路由，不值得。

**成本分層原則：能搭車就搭車，不能就按需，絕不自動昂貴。**

| 軸 | 入口 | 成本 |
|---|---|---|
| 通道 | 既有探測輪雙通道 sweep | 每輪 1 請求（已有） |
| 檔位 | 於既有探測輪追加 Off 拼寫一問 | +6 請求/輪（實測可負擔） |
| **上下文（高報）** | **真實請求的 400 報文順帶採集** | **零額外配額** |
| **上下文（低報）** | **使用者按需觸發的刻意超發** | 1 請求/模型，使用者可控 |

低報**無法從失敗中察覺**（永遠發不夠），故必須主動踩；而上游報文會直接說出真值，
**每個模型只需 1 個請求**即得精確上限，不值得為 36 個模型付每日輪詢的代價。

**軸一：思考檔位（`thinkingLevelMapFor`）。**

對每個推理模型**必定回傳 map**，絕不回傳 `undefined`（§二）。未見發布者一律
`null`；`null` 與「缺省」的差別就是本條決策的全部內容。`off` 的取值依**宣告形狀**分支：

```
R0  reasoning:false                    → 不產出 map
R1  宣告值含 off 成員（外來拼法 none）   → off:"none"    [憑宣告]
R2  宣告了檔位但無 off 成員             → off:null      [實測 400]
R3  無宣告檔位且實測 works              → off:"none"    [實測 49→0 / 32→0]
R4  實測 ineffective 或 rejected        → off:null      [實測：沒有可用的 Off，就不提供該行]
R5  未量測                             → 見下
```

**R4 是對「保留該行但什麼都不發」的否決。**先前草案為 inert 狀態保留 Off 行，
理由是不讓使用者失去控制項；但「保留一行、發送一個模型不接受的字串」
與「保留一行、發送一個被忽略的字串」**同樣是謊言**，而 R4 的實測結果
（`longcat` 於 `none` 下仍回 200 且推理持續）證明後者同樣不該保留。
故 `off` 只有兩種取值：`"none"`（它有效）或 `null`（它無效）。
**不變量「不得為 null 掉 Off」的守護對象是不確定量測，不是確定負面結論**——
後者是誠實的，前者才是資料損壞。

**R5 的預設值是有實測依據的，不是形狀推導。**`toggle` 形狀的兩個實測樣本
一有效一無效，故形狀無法預測，必須逐模型量測。未量測時選 `"none"` 而非
`null`，理由是**兩種預設在 `toggle` 上都不會產生硬錯誤**（`longcat` 證實
`none` 被接受而非拒絕），因此：

- 選 `"none"`：約一半機率給到真實可用的 Off；另一半機率的後果與今日完全相同
  （模型本來就在思考）
- 選 `null`：百分之百保證使用者拿不到 Off

在沒有響亮失敗可選的情況下，**傾向於給出機會而非保證落空**。
能力卡在量測落地前一律標記「未驗證」，故此預設從不冒充已知事實。

**R5 的驗證必須重複。**實測顯示同一端點可在一次
`429 Endpoint is unavailable` 後接兩次乾淨的 200。故任何單發量測都不構成結論，
否則一次端點抖動就會產出「toggle 拒絕 `none`」這個**與實測完全相反**的結論。
這是本 ADR 迄今最容易被實務顛覆的一條，故寫入規則而非註記。

**錯誤採集對 R4 這一類是結構性盲區。**`longcat` 回 200 且推理持續，
沒有任何失敗可供採集——只有**主動對照比較**能偵測它。
「偵測到拒絕」與「偵測到推理未停止」是兩種不同能力，本設計只聲明前者，
後者必須由探測輪的主動比較提供。

R2 的選擇經過推翻：原本考慮 (a) 省略或 (b) 把 Off 映射到最低檔位，
兩者皆被否決——DSH 的選擇器本已在 `defaultEffort` 缺席時恆久 prepend 一列
**provider default**（插件 profile 未宣告 `reasoning` 鍵，故此為現狀），
該列語義正是「不發送 reasoning 參數」。(a) 會產生**兩列位元組完全相同**的請求，
其中標示為 Off 的那一列在說謊；(b) 則是標示 Off 卻產生 9 個推理 token 的較好謊言。
`off: null` 給出五個誠實的檔位列加上主機的預設列。已驗證
`clampThinkingLevel(space-bunny-free, "off") → "low"`，故陳舊的使用者偏好
落在 9 token 而非 35 token——**此修正改善該路徑而非使其退化**。

⚠️⚠️ **R2 此處的結論已被自身證據推翻，本段為審計軌跡保留。**

當時否決 (b) 的理由是「標示 Off 卻產生 9 個推理 token 是較好謊言」。
但同一段自己寫著 `clampThinkingLevel(space-bunny-free, "off") → "low"`——
**該條正是 (b)，且它給出的是 9 對 35，即一個真實的 4× 降幅。**

**否決一個已被自己量測證明有效的控制，代價由使用者承擔。**
理由（「較好謊言」）預設了「不提供該列」優於「提供一個近似」，
但本文件的整體立場恰恰相反——**寧可給出可稽核的近似，也不給使用者零控制**。

**故 R2 修正為：不對宣告檔位的模型一律 `null`，而是與無檔位模型適用同一條規則**：
`off` → 實測能將推理降至接近零的最低檔位（`none` 優先，因其為精確零）；
無此檔位者才 `null`。細節見 §三十五。


**軸二：通道。**既有 sweep 與 `applyMeasuredChannel` 已足夠。補一條零成本入口：
真實請求若以 `not supported for format` 失敗，即為通道判斷錯誤的直接證據，
在與 `withEncryptedContentFallback` 相同的位置採集。

**軸三：上下文。**此軸的關鍵在於**不對稱性**，且不對稱性決定了成本分層。

先證明**低報無法從失敗中察覺**：`contextWindow` 低報時，DSH 提前壓縮（若已配置）
使請求永遠發不夠；未配置時 pi-ai 的 `clampMaxTokensToContext` 把 `max_tokens`
夾到下限而非報錯——兩種情況都**不產生任何 HTTP 錯誤**。
故報文採集**只能修正高報**，對低報無效。

- **高報／自述型 → 零額外配額**：真實請求的 400 報文若自述
  `maximum context length is N`，直接採集。實測 7 個可測模型中 5 個屬此型。
  與 `withEncryptedContentFallback` 同一位置接入。
- **低報 → 必須主動踩**：使用者按需觸發的刻意超發，**每模型 1 個請求**
  即取得精確上限（實測已證：5 型 1 請求得精確值）。不做自動輪詢——
  36 模型每日輪詢的代價不成立，而按需完全在使用者控制之下。
- **泛用錯誤形態 → 需區間**：`big-pickle` 的 400 為泛用
  `invalid_request_error: invalid request`，**不**自述上限，故只能得到
  觀測區間（本次為 >1048576）。注意此形態與 `space-bunny-free` 對
  `reasoning_effort:"none"` 的 400 完全同形——**泛用 400 不可單憑自身判定**，
  必須搭配陽性對照（見軸一的 400 規則）。

**套用規則**：實測值 > 宣告值則**上調**（使用者取回遺失能力），< 則**下調**（避免上游 400）。
實測值缺如時**維持宣告值不動**，並在能力卡上標記「未驗證」——不以傾向替代量測。

**篩選順序，不是替代值。**實測顯示 ≤262144 可測者 5 中 4 低報，
故驗證動作**預設排序**低頻段在前，讓使用者先花配額在回報率最高處；
但 `ling-3.1-flash-free`（宣告 262144 且正確）證明頻段**只指示去哪裡量，
永不指示答案是什麼**。任何以頻段直接改寫 `limit.context` 的捷徑均被明文否決。

**未驗證模型的預設值：向上偏，不向下偏。**由上文的不對稱性直接得出——
低報是唯一**無錯誤因而無恢復路徑**的失敗（`max_tokens` 塌成 1，靜默死亡）；
高報則要麼被 DSH 的反應式壓縮重試接住（自述型報文命中正則），
要麼僅損失一次請求。故未驗證時廣告 `max(宣告值, 底線)`，
並在能力卡標記「宣告 X / 廣告 Y（未驗證）」。

此偏向上有一條必須同時成立的守護，且**初稿給出的判據是錯的**。
初稿曾以「該請求的估算值是否超過本次廣告的 `contextWindow`」作為
上下文軸的陽性對照。**在「廣告偏大」這個預設之下，此判據自我否定**：
真實溢出恰恰會落在廣告值**以下**，因而會被誤判為參數非法。

實測已證泛用形態 400 無法由報文自身區分：`big-pickle` 對上下文溢出與
對 `reasoning_effort:"zzz"` 回**逐字相同**的 `invalid_request_error: invalid request`。

故正確處置是**承認不可歸因**：

> **泛用形態 400 永不寫入任何量測。**它只計入「某處失敗」，
> 不構成上下文結論。上下文 harvest **僅對自述型報文
> （`maximum context length is N`）有效**；泛用形態只能靠主動探測取得真值，
> 任何時候都不能從被動觀察推得。

一次溢出的價值因此只在自述型成立：採集成精確值並持久化，該模型從此正確。
泛用型則退為按需探測。此路徑僅在模型實際被用到接近上限時觸發，
故對從未接近上限的模型零成本。

**結構性修正（與三軸同批落地）。**

1. `buildModel` 不得以 `template.input` / `template.reasoning` 兜底。模板解析到
   `mimo-v2.6-flash-free`（reasoning true、input text+image），故「models.dev 沒說」
   目前會被解析成「繼承我們所知最-capable 的東西」——與 `undefined` map 同一個錯誤，
   只是換了個欄位。
2. `onPayload` 守衛不得刪除。實測其**在 responses 通道上是活體**
   （`openai-responses.js:259-262` 會產出巢狀 `reasoning`），僅在 completions
   通道上不可達。正確處置是讓它**成為 map 的鏡像**而非第二權威：
   僅當 `model.thinkingLevelMap?.off !== "none"` 才剝除佔位值。
   `onPayload` 兩條通道皆已收到 `model`，故無需宿主變更。
3. `description` 與 `maxTokens` **需 DSH 側變更**，不繞道。`LlmModelInfo`
   已有 `description?: string` 槽位（`dsh-llm/types/types.d.ts:311-312`）
   但 `PiAiAdapter.modelInfo` 從不填入；`maxTokens` 則被插件空
   `configuredMaxTokens` Map 阻擋。列為向上游提案，不在本 ADR 內解決。
4. **第三方插件可覆寫本方案的量測結果，必須視為已知整合風險。**
   使用者 profile 已安裝 `dsh-better-reasoning-effort` v0.5.2，其目標清單
   包含 `"opencode.ai"`（本插件的 baseUrl），並在 `llm-pi-ai` 命名空間
   對未宣告檔位的模型自動寫入 `reasoningEfforts`——而該欄位正是
   `dsh-llm-pi-ai:588`（`resolveModelReasoning`）唯一的 `thinkingLevelMap` 寫入點。
   故本方案逐模型量測出的結果**可能被靜默覆寫**。
   該插件獨立使用 `efforts: { off: "none", … }`，與本 ADR 的 R3 同構——
   這是對 R3 的旁證，但同時構成**第二個權威**。故能力卡必須記錄實際生效的
   來源，且 `compat` 測試需涵蓋「第三方已宣告檔位」這一情形。

**不變量（須逐條釘為測試）。**

1. `getSupportedThinkingLevels(model).length >= 1` 恆成立——空列表陷阱上移一級。
2. 任兩列提供的控制不得產生相同位元組——否則其中一列必為謊言。
3. map 中的字串值只允許來自已發布檔位名或 `"none"`——否則即是 `off`-is-a-400。
4. 任何單次不確定量測都不得縮小可見性，亦不得 null 掉 Off。
5. 上下文代入後的壓縮閾值不得晚於實測准入閾值。
6. 任何**單發**量測不得寫入結論——端點抖動會產出與實測相反的結論。

第 1–3 條已對全部 36 條免費記錄以 pi-ai 的
`getSupportedThinkingLevels` / `clampThinkingLevel` 驗算通過。

**三十五、R2 被自身證據推翻——修正後 Off 覆蓋率由 6/13 升至 9/13。**

受控對（同一輪、同一提示詞，僅 effort 一項不同）：

| 模型 | 通道 | 省略 | 最低宣告檔位 | 倍率 | R2 是否正確 |
|---|---|---|---|---|---|
| `muse-spark-1.3-contributor-free` | responses | **166, 184**（復測） | `minimal` **38** | **4.6×** | **否，剝奪能力** |
| `muse-spark-1.2-contributor-free` | responses | **231** | `minimal` **47** | **4.9×** | **否，剝奪能力** |
| `fledge-alpha-free` | completions | **54** `completion_tokens` | `low` → **93** | 無降幅 | 碰巧正確 |

**R2 在 3 個已測模型中錯了 2 個，而它對的那一個是靠巧合。**

⚠️ 兩項限定不得略過：

- muse-spark-1.3 早前量得的 **360 為離群值**；復測 184 對 166，
  真實省略基線為 166–184，穩定於約 11% 內。
- **`fledge-alpha-free` 的推理量不可觀測**：其 usage 無
  `completion_tokens_details` 亦無 `reasoning_tokens`，唯一訊號是串流
  `reasoning_content` 的**字元數**，與表中所有 token 計數**單位不同**。
  補測省略基線後（同單位）得 136 對 321 字元，即 `low` 為 **2.4× 的增加**。
  重測一輪後：**2/2 配對、2 個獨立單位，順序全部一致**——省略 136/300 對
  `low` 321/501，四次皆為 `low` 較高；兩個區間不重疊（300 < 321），
  **但單對僅差 21 字元**，不足寫成「已定案」。

  故正確措辭為：**`low` 在 2/2 配對、2 個獨立單位上均高於省略；
  `off: null` 正確；幅度未確立。** 該模型方差之大，使兩側各兩個樣本
  足以讓一個小間隙看起來像結論——此即 §二十四「跑梯度而非跑單點」
  在此反向作用：**單點看起來夠了，重測才發現它其實不夠。**

**修正後的單一規則（取代 R2/R3/R4/R4'）：**

```
off → "none"      若實測達精確零
   → 最低可用檔位   若實測有真實降幅
   → null         若無實測降幅
```

**分類完全不依賴形狀**：`big-pickle`（`[]`）走 `minimal`、
`space-bunny-free`（completions 檔位）走 `low`、
`muse-spark` ×2（responses 檔位）走 `minimal`。
三種形狀、三條通道、三個不同檔位，規則一致。

**13 個被 Zen 服務的免費模型，Off 行覆蓋率 6/13 → 9/13。**
不提供的 4 個為：`fledge-alpha-free`（已測，未發現降幅）、
`longcat-2.5-preview-free`（已測，無降幅）、
`ling-3.0-flash-fin-free` 與 `deepseek-v4-flash-free`（端點下架，未測）。

**三十六、前沿的嚴格結果：四點，其中兩點結果相同，故實為三點。**

以**結果空間**（而非實現方式）做支配檢驗。五個維度：
A = Off 行覆蓋、B = 上下文覆蓋、C = 名单變動下的自我糾正能力（皆高為好）；
Q = 每次收斂的邊際配額、R = 收斂所需輪次（皆低為好）。

| 方案 | A | B | Q | R | C | 判定 |
|---|---|---|---|---|---|---|
| 現狀不動 | 0/13 | 8/10 | 0 | 0 | 1 | 被支配 |
| 獨立探測＋立即持久化 | 9/13 | 8/10 | 8 | 1 | 2 | 被 3、4 支配 |
| **合併探針＋立即持久化** | 9/13 | 8/10 | 0 | 1 | 2 | **前沿** |
| **合併探針＋泛型 400 計存活** | 9/13 | 8/10 | 0 | 1 | 2 | **前沿**（與上同一結果，但無耦合） |
| 合併探針＋一致性 N=3 | 9/13 | 8/10 | 0 | 3 | 2 | 被 3、4 支配 |
| 合併探針＋交替 `none`/`zzz` | 9/13 | 8/10 | 0 | 2 | 2 | 僅在加入「獨立檔位驗證」一維時為前沿 |
| 獨立探測＋一致性 | 9/13 | 8/10 | 8 | 3 | 2 | 被支配 |
| 檔位掃描兼作效力測量 | 9/13 | 8/10 | 20 | 1 | 2 | 被支配 |
| **靜態標定表** | 9/13 | 8/10 | 0 | 0 | 1 | **前沿**（不自我糾正） |
| **＋主動上下文驗證** | 9/13 | **10/10** | 8 | 2 | 2 | **前沿** |

⚠️ **維度集合決定前沿，這是本節最關鍵的一條。**
若遺漏 C（自我糾正），靜態標定表因 R=0 而**假性支配**其餘全部方案——
這正是我在本文件寫作過程中犯過的錯，並據此錯誤地判定
「前沿枚舉未收斂」。**被支配的 8 項是同一結果的實現差異，不是新的前沿點。**

故前沿為 **3 點**（合併兩個耦合變體後）：

1. **合併探針 ＋ 泛型 400 計存活**——Q=0、R=1、自我糾正
2. **靜態標定表**——Q=0、R=0、**不**自我糾正
3. **方案 1 ＋ 主動上下文驗證**——Q>0、B=10/10、自我糾正

**所選點為方案 1（若計入獨立檔位驗證則為其 `none`/`zzz` 交替變體），
它是前沿點，且其每一行皆有實測支撐。**

---

## 三十七、最終方案（交付形態）

### 唯一不變量

> **任何未被實測的東西，一律不對使用者聲稱。**
> 缺省的解析結果是「不聲稱」，而不是「猜一個」。

本文件 74 項實測中，每一項推翻都源自同一個錯誤模式——
**把缺席讀成了許可**：`thinkingLevelMap: undefined` 被 pi-ai 讀作「全部提供」；
`off` 缺省被讀作「發送什麼都不發」；`template` 兜底被讀作「繼承最-capable 的東西」。
**每一次修正都是同一條規則的應用，因此規則本身不需要因新發現而改寫。**

### 四條規則

**一、Off（單一規則，不看形狀）**

```
off → "none"       若實測達精確零
   → 最低可用檔位   若實測有真實降幅
   → null          其餘一切情況
```

三種形狀、三條通道、三個不同檔位共用此規則。
`[]` 形狀已被三次獨立反例證明無預測力（`nemotron`/`mimo`/`nemotron-3.5` 遵守、
`big-pickle` 拒絕），故**形狀永不參與判定**。

**二、檔位列**

保留 models.dev 宣告者；未宣告者保留預設階梯
（已量測 5/5 接受），並標記「四種模式，非階梯」——
**五個模型無一單調**，故不得聲稱其為階梯。

**三、上下文**

- 宣告值即預設值，**永不主動代入**
- C4 於夾逼觸底（`wire max_tokens === 1`）時上調，上限 `min(宣告×4, 1048576)`
- responses 通道因 pi-ai 將 `max_output_tokens` 兜底至 ≥16，**C4 結構上不可達**，
  故該 2 個模型以**按需驗證**取得精確值（一次性 2 個請求）

**四、證據門檻**

| 門檻 | 理由 |
|---|---|
| 單次量測不得持久化 | 已實證單點會翻轉（muse-spark 360 為離群值；`big-pickle` 6/9） |
| 連續 N 次一致（N≥3）方可持久化 | 「乾淨的 200」不等於量測成立 |
| `inconclusive` 永不持久化 | 沿用既有紀律 |
| 以自身量測存在性作為收斂條件 | `isSettled` 只認 `dead`，搭車會使每模型每日 +1 且永不歸零 |

### 三個必須寫成具名測試的陷阱

1. **不得把 `none` 當檔位名**——`clampThinkingLevel` 會將其解析為 `off`，
   請求靜默退化為省略。必須斷言**線上 `reasoning_effort === "none"`**，
   而非斷言 map 形狀（兩條路徑都會通過形狀斷言）。
2. **`onPayload` 守衛不得刪除**——它在 responses 通道上是活體。
   須改為 map 的鏡像，僅當 `model.thinkingLevelMap?.off !== "none"` 才剝除。
3. **C4 的欄位須按 `model.compat?.maxTokensField` 解析**——
   31/36 記錄發送的是 `max_tokens` 而非 `max_completion_tokens`，
   讀錯則檢測器在 31/36 模型上靜默失效。

### 為何此結構不會因新發現而需重做

新證據只能**改變一個值**，不能**推翻規則**：

- 測到新的 `none` 行為 → 該模型的 `off` 從 `none` 變為檔位名或 `null`，規則不變
- 測到新的上下文值 → `contextWindow` 更新，C4 與按需驗證的分工不變
- 發現新的上游 400 形態 → 只是多一條可解析的形態，規則不變
- 發現某模型不穩定 → 一致性門檻吸收它，規則不變

**唯一能推翻它的是「量測本身無法刻畫模型」這一命題**——
而該命題已被 `big-pickle` 證實過一次（6/9）。一致性門檻提高置信度，
但**不消除**該風險。此為本方案已知的、不可由設計消除的殘餘風險，
**必須在能力卡上如實標示，而非隱去**。

---

## 三十八、殘餘風險（最終版，逐條對應實測）

以下每一條都經量測，不是推測。**已修的標明修法，未修的標明為何不修。**

**一、乾淨的 200 不等於量測成立。**實測 `big-pickle` 對 `reasoning_effort:"none"`
在九次**逐字相同**的請求中回三次 400、六次 200，且 200 者 `reasoning_content` 皆存在。
單次抽樣約三分之一記錯行，且**無任何下游機制能察覺**——探測回的是乾淨的 200 與
格式良好的結果。緩解是三次一致才寫入；**它提高置信度，不消除該風險**。
已實測比例 0.7181（估算對真實 tokenizer）與 0.7110–0.7114（估算對上游准入計數）
互相印證。

**二、失效形態不對稱，且靜默那一種已被處理。**顯式 400 → `INVALID_REQUEST`，
不可重試、自帶上游說明。**被靜默忽略的 effort 值 → HTTP 200 零內容 →
`EMPTY_RESPONSE`，它在 `DEFAULT_RETRYABLE_CODES` 內，預設重試五次**：
500+1000+2000+4000+8000 = 15,500ms 退避、六次完整往返、對共享桶多耗五次，
最後顯示一個**不提 effort** 的錯誤。
**已修**：`onPayload` 看見自己發出的 `max_completion_tokens === 1` 且回覆為空時，
把它改寫為 `stopReason: "error"`，措辭避開所有可重試樣式，落入
`PI_AI_ERROR`（不可重試），文字原樣送達使用者。無需宿主變更。

**三、`xhigh` / `max` 僅在**宣告**或**量測到它確有作用**時提供。**八個模型、兩條通道，
**沒有任何檔位被拒絕過**，但這兩級在 pi-ai 語意中是 opt-in。
⚠️ **原條文「`muse-spark-1.3` 的 `max`（516 tokens，該模型最強模式）由**模型自述**解鎖」
已作廢**——見 §三十三 的更正：該數字沒有持久證據，且使用者確認 `max` 不對個人開放。
**自述從此不解鎖任何檔位**：提供一列是對「使用者會得到什麼」的聲明，
而拒絕裡的詞表是對「解析器會接受什麼」的聲明。

**四、`responses` 通道的檔位為 n=0 實測。**該通道僅 `muse-spark-1.3` 可達
（`fledge-alpha-free` 連續七次 500，`ling-3.0-flash-fin-free` 連續七次 429）。
間接證據：fledge 的自述與其宣告逐字吻合；muse-spark 5/5 宣告檔位全接受。
**不是逐模型實測**，但規則本身不依賴跨模型推斷——第一個端點恢復的模型會自行量出結論。

**五、`contextWindow` 低報會觸發虛假壓縮。**`isContextOverflow`
（`pi-ai/utils/overflow.js:146-150`）在 `stopReason === "stop"` 且
`inputTokens > contextWindow` 時回 `CONTEXT_WINDOW_EXCEEDED`，引發壓縮與重試。
C4 將窗口抬到 `min(宣告×4, 1048576)`，抬得過頭會讓壓縮更晚發生而非更早——
**但那正是使用者仍在獲得能力的區間**，而誤報的代價是蓋內一次可見的拒絕。
錯的 effort 值**不能**引發此路徑。

**六、第三方插件構成第二個權威。**使用者 profile 已裝
`dsh-better-reasoning-effort` v0.5.2。**已重新查證並收窄**：它的 autofill
只讀 `descriptor.user.providers`（使用者手寫設定），而本插件從不往該命名空間寫，
故**兩個寫入方目標儲存不相交**，量測結果不會被覆寫。代價是若使用者**手動**
在設定中宣告本路由，該第三方會填入並永久生效（`reasoningEfforts !== undefined`
具黏性）。其知識庫亦含 `mimo-v2.6` 條目，獨立使用 `efforts: { off: "none", … }`
——與本 ADR 的 R3 同構，屬旁證而非衝突。

**七、收斂是概率性的，且現在有界。**三次一致才寫入；取不到樣本的模型按
0 / 6h / 24h / 7d 退避（`ling-3.1-flash-free` 連續七次 429，此前每輪都被問、永久燒配額）。
已確認的裁定**凍結**並停止累加樣本，30 天後或宣告變更時重評——否則中位數會在
無限增長的樣本集上漂移，可能悄悄降級一個模型確實支援的控制。
比率落入模糊帶 [0.287, 0.645] 的模型**目前無終態**：實測中該情形出現**零次**
（全部落在 0.000–0.231 或 0.800–10.813），且已實測的兩個難測模型都會終止。
為一個從未觀測的情形引入終態，是拿複雜度換不存在的問題；提案留存於
`.scratch/reports/termination.md`，待真有模型落入帶內再啟用。

---

## 三十九、證據放在哪裡

**持久證據是 `tests/measured-samples.json`**——provider 自己的回答，逐點標注
「問的是什麼」，由 `tests/measured-corpus.test.mjs` 回放。它是追��回歸的錨點，
且**不含任何本機路徑**。

**設計推理留存於 `.scratch/reports/`**：本 ADR 之前的三輪設計文件
（`scheme.md`、`surface.md`、`final-change-list.md`、`threshold.md`、
`termination.md`），依本倉庫既有慣例隨 `.scratch/` 一起入庫——
該目錄已跟踪 18 個 markdown 設計文件。

**原始探測 JSON 與一次性 harness 刻意不入庫。**它們是單日快照，
來自共享配額桶，永遠無法重現；而它們支持的結論已固化在
`tests/measured-samples.json` 與本 ADR 中。`scripts/` 亦不收留——
該目錄存放的是被源碼引用的成品工具（如 `zen-provider.ts:742` 引用的
`scripts/probe-ab.mjs`），而本輪的探測腳本是含本機路徑的臨時 harness。

**回歸語料自證有效**：把分類器改回逐樣本 `=== 0`，語料立刻失敗兩條；
恢復中位數即恢復。這是本輪唯一能證明「測試不會看起來對而其實錯」的機制。

## 四十、證據等級：哪些數字有錨點，哪些只是一次快照

本 ADR 的 74 項實測**並非同一等級**。持久錨點只有一個：
`tests/measured-samples.json`（provider 自己的回應，逐樣本記「問的是什麼」）。
`.scratch/probe/` 下的原始 JSON **不入庫**（§三十九），所以只存在於那裡的數字
對下一個讀者等同於不存在。

2026-10-06 逐條核對的結果（腳本見 `.scratch/verify/`，零配額）：

**有錨點（可在語料中復現）**——big-pickle 的 `minimal` 0/8 與 `low` 164、
space-bunny-free 的 `low` 0/9/22/37 與基線 35、mimo-v2.6-flash-free 的基線 37
與 `none` 0、longcat-2.5-preview-free 的 `none` 71/80 與 `minimal` 36、
nemotron-3-ultra-free 的基線 49、nemotron-3.5-lightning-free 的基線 30。

**無錨點（只有一次性快照，或語料裡是 `tokens: null`）**——
⚠️ `muse-spark-1.2` 的 `minimal` 47、⚠️ `muse-spark-1.3` 的省略 166/184、
⚠️ fledge-alpha-free 的 321/135/137 **字元數**（該模型不上報
`completion_tokens_details`，本 ADR 已註明單位不同）、§三十三 的
`max` 516（已於該節作廢）。

**為什麼要寫這一節**：我（Agent）在 2026-10-06 把「`muse-spark-1.3` 的 `max`
被扣住」當成待辦轉述給使用者，依据是 §三十三 的「516 tokens、兩次確認」——
而那句話在語料裡是 `tokens: null`。**使用者當場糾正：該檔位不對個人開放。**
錯誤不在讀取，而在**把一份沒有錨點的斷言當成既成事實轉述**。

由此得到兩條對後人的硬要求：

1. **引用本 ADR 的數字前，先在 `tests/measured-samples.json` 裡找一次。**
   找不到就寫「無錨點」，不要寫成「實測 N」。
2. **本 ADR 裡任何「實測 N tokens」若語料無對應樣本，只能用於提出問題，
   不能用於斷言能力。** 特別是 muse-spark 家族——它同時是本 ADR 中
   錨點最弱、而結論最肯定的一族。

線上裁定不受影響：`muse-spark-1.2`／`muse-spark-1.3` 目前的
`level-works/minimal` 來自 **2026-10-06 線上實測的樣本**
（`[17,12,11,31,34]`／`[31,18,19,16,21]`，對基線 `[53,148,86]`／`[125,121,155]`），
不是來自本 ADR 的無錨點數字。

**Consequences**

- 10 個活躍模型的提供檔位數由 5 降為 1（7 個）、4 降為 3（`fledge-alpha-free`）、
  6 降為 5（`space-bunny-free`、`muse-spark-1.3-contributor-free`）；
  **沒有任何模型失去 models.dev 背書過的檔位**。
- `mimo-v2.6-flash-free` 使用者可取回 5.24 倍上下文。
- 方案**依賴主機的 provider-default 列**存在。插件自身無法供應該列——
  pi-ai 的詞表中沒有「主機完全未發檔位」這個成員，而 `off` 恰恰就是它。
  緩解手段為一條會響的相容性斷言，不是靜默兜底。
- 每日探測輪成本由 ≤34 增至 ≤40 請求。

**未量測與存疑**

- `toggle` 形狀完全未量測（上游 429）。R3 對其為繼承假設。
- `ling-3.0-flash-fin-free` 兩次失敗未取得資料（`Endpoint is unavailable.`），
  故 262144 頻段僅 2 中 1 為低報。
- `nemotron-3-super-free`、`glm-4.7-free` 回 `ModelError: not supported`——
  該判斷關於模型下架，與其上下文上限無關，故 204800 頻段無資料。
- 「某些日期之前發布的宣告皆低報」此假設**無法檢驗**：204800 頻段的兩個模型
  已下架，無法取得其上限。該假設既不能證實也不能證偽。
- `big-pickle` 與 `longcat-2.5-preview-free` 的上限只有區間，未取得精確值。
- 兩個 mimo 共用同一路由，故「單一端點上限」與「兩個模型恰好同值」無法區分。
- `structured_output`、`tool_call`、knowledge cutoff、open-weights、
  非文圖模態在三層皆無通道，為 clean negative，非本 ADR 可解。

## 四十一、最大輸出：同一份宣告的另一個欄位，同樣低報（2026-10-07）

前四十節處理的是通道、檔位、上下文。第三根軸是 `limit.output`，它一直未被
量測，而它比前兩者更直接：**pi-ai 的 `buildBaseOptions` 送出
`options.maxTokens ?? model.maxTokens`，DSH 對這個 provider 不送 `maxTokens`
（profile 的 `configuredMaxTokens` 為空），故 `limit.output` 就是每次回答被
截斷的那個數字。** 低報的後果與低報上下文同型，且同樣安靜：模型在
`finish_reason: "length"` 停下，面板沒有任何一行說明。

**量法（2026-10-07，線上集合 11 個模型）**：提示是一個字，所以 `max_tokens`
只決定**上限**而不決定生成量，每一步約 30 個輸出 token；數字取自**出線的
請求體**（`fetchImpl` 記錄 `max_tokens` / `max_completion_tokens` /
`max_output_tokens`），不是取自宣告。拒絕只有在**單調**時才算上限證據：§七
說明泛用 400 無法自證，故每個 400 都補一次二分（上一個 200 為陽性對照）。

| 模型 | 宣告 | 鏈路上接受的最大值 | 倍數 | 現場報文 |
|---|---|---|---|---|
| `mimo-v2.6-flash-free` | 32000 | **1040384** | ≥32.5× | — |
| `muse-spark-1.2-contributor-free` | 131072 | **1040384** | ≥7.9× | — |
| `muse-spark-1.3-contributor-free` | 131072 | **1040384** | ≥7.9× | — |
| `fledge-alpha-free` | 131072 | **1040384** | ≥7.9× | — |
| `nemotron-3.ultra-free` | 128000 | **991808** | ≥7.7× | 首輪 503，09:07 重跑取得 |
| `nemotron-3.5-lightning-free` | 262144 | **991808** | ≥3.8× | — |
| `longcat-2.5-preview-free` | 131072 | 262144 | ≥2× | 393216 → 400，二分 262144 仍 200 |
| `big-pickle` | 32000 | 128000 | ≥4× | 1040384 → HTTP 500（無結論） |
| `space-bunny-free` | 524288 | 524288 | **1×** | 782336 → 400，二分後仍單調 |
| `ling-3.1-flash-free` | 32768 | — | 無資料 | 三次 429 `Endpoint is unavailable.` |
| `ling-3.0-flash-fin-free` | 32768 | — | 無資料 | 四次 400 `Endpoint is unavailable.` |

**首輪的「無資料」不是模型的性質，是當時上游的狀況**：`nemotron-3-ultra-free`
在 09:07 重跑即取得 991808（兩次獨立執行）。`ling-3.1-flash-free` 與
`ling-3.0-flash-fin-free` 在 09:07 仍然只回 429／400 的
`Endpoint is unavailable.`——這兩個端點自 2026-10-06 起就持續如此，屬於
**端點健康**，不是能力問題，故不影響任何結論。

**`space-bunny-free` 是這張表存在的理由**：它的宣告量測為**正確**
（524288 收、782336 拒，二分單調），所以這不是一條規則，是一份證據表——
沒有條目的模型維持原狀。

**採用值取「接受過的最大值」，絕不取外推**：`SEED_OUTPUT` 以
`limit.output` 指紋綁定（與上下文同一個 `contextFingerprint`），宣告一改即丟棄；
並且以同一模型所廣告的窗口為上限——**大於上下文的輸出上限不是更大的上限，是謊話**。
pi-ai 的夾擠是 `min(maxTokens, context − est − 4096)`，故鏈路上永不超過表內數字：
有空間的對話會要滿，長對話自動要少。**無需在 payload 邊界再加一道夾擠**——
這正是先前把 `min` 的方向想反所差。

### 四十一之一、視覺與工具：兩句一直只是「推測」的話，現在有量測

README 長期宣稱「工具可用」並自我註明那是**准入條件**而非量測；徽標的視覺
同樣只源自 models.dev 的宣告。2026-10-07 兩者都補了實測：

- **工具**：給三個真實 schema（`read`/`bash`/`edit`，描述照人寫，**不用**閘門
  那個「Unavailable in this request. Do not call.」的佔位——否則模型照做反而會
  被讀成能力不足），要求「呼叫 `bash` 跑 `echo capability-probe`」：
  **7/7 發出真實 toolCall 且參數正確**（mimo、space-bunny、longcat、
  muse-spark-1.2/1.3、nemotron-3.5、big-pickle）。09:07 補測首輪失敗的四個：
  `nemotron-3-ultra-free` 與 `ling-3.1-flash-free` 同樣發出正確 toolCall，
  累計 **9/9**；`ling-3.0-flash-fin-free` 與 `fledge-alpha-free` 仍
  `stopReason:error`。四者的 `stopReason:error` **帶工具與不帶工具的報文逐字元組
  相同**（Nvidia 503 / `Endpoint is unavailable.` / HTTP 500），故那是上游
  狀況，不是能力缺失。
- **視覺**：64×64 手寫 PNG（上半 `#FF00FF`、下半 `#00FF00`），
  問「上半部是什麼顏色」：**5/5 答 `magenta`**（mimo、longcat、
  muse-spark-1.2/1.3、space-bunny）。對照組（無圖）在 mimo 回答
  「no image was attached」、在 space-bunny 回答 `blue`——**答錯**，
  這正是圖像承載了答案的證據。唯一宣告視覺卻無資料的是 `fledge-alpha-free`
  （上游 500／429）。`nemotron-3-ultra-free` 與兩個 `ling` **不宣告**圖片輸入，
  面板本就不給視覺徽標，故無可測項——**沒有宣告的能力不需要實測，
  但也說明宣告本身仍非上游第一手證據**。

兩個副教訓，都寫進證據本身：

1. **`maxTokens: 1024` 會製造假的視覺失敗。** mimo 在 256 與 1024 下把整個
   預算花在 thinking、一個字都沒回（pi-ai issue #3010 的形狀），在 4096 下
   回答 `magenta`。**能力測量的預算必須足以容納思考**，否則量到的是 token
   分配，不是能力。
2. **「宣告支援圖片」不等於「路由接受圖片」**，這一句至今只驗到一半：
   5 個可量測的宣告模型全數通過，但宣告本身仍非上游的第一手證據。

### 四十一之二、「接受」與「兑现」之間：180 秒這道牆（2026-10-07）

上限表回答的是**請求會不會被受理**，不是**模型能不能生成那麼多**。使用者選擇
補做後者的證明，得到的第一個結果不是預期的那個：

| 請求 | 結果 |
|---|---|
| mimo `max_tokens: 40000`（探測路徑） | 181s、HTTP 200、**無 usage** |
| mimo `max_tokens: 34000`（探測路徑） | 181s、HTTP 200、**無 usage** |
| mimo `max_tokens: 40000`（繞過探測，timeout 900s） | `stopReason: length`、**產出 40000**、263.7s、約 152 tok/s |

**兩次都在 181 秒死掉，不是巧合，是本插件自己的時鐘。**
`zen-provider.ts` 的 `requestOptions` 寫著 `timeoutMs: options?.timeoutMs ?? 180_000`，
而 pi-ai 把它交給 OpenAI SDK 的 `timeout`——那是**整個請求**的逾時，不是閒置逾時。
更關鍵的是 `index.ts` 的 profile 也寫 `timeoutMs: 180_000`，而 DSH 會把它複製進
每次請求的選項（`dsh-llm-pi-ai` 的 `profileOptions`），所以**主機的值會覆蓋插件的值**：
只改插件那一處不會有任何效果。

**結論：180s 在任何 max_tokens 數字生效之前，就先決定了一次回答能有多長。**
以實測的 152 tok/s 換算，180s 約等於 27,000 個輸出 token——**比插件原本廣告的
32,000 還少**。也就是說：只把上限從 32,000 抬到 1,040,384，使用者在實際使用中
看不到任何差別，因為先撞到的是時間牆。

**已修**：兩處都改為 600s，與 profile 既有的 `streamIdleTimeoutMs: 600_000` 對齊，
主機與插件不再各說各話；呼叫端自帶的 timeout 仍然優先。這一條改動**不影響**
短回答——它只在模型真的想寫很久時才會用到。

**為什麼值得寫**：這正是「能力有沒有真實發揮」最典型的失敗形狀——廣告的數字是對的、
上游也受理，但**插件自己**在更早的地方就把能力掐掉了，而面板不會顯示任何差異。
ADR §四十一的前半段若只量「受理」，就會把這道牆漏掉。

### 未量測與存疑（2026-10-07 補測後）

- ~~接受 ≠ 兑现~~ **已證**：mimo 實際產出 40,000 token（`stopReason: length`），
  遠超宣告的 32,000——**宣告確實在截斷真實回答**，抬升有意義。
- **產出速率是新的隱形上限**：約 152 tok/s 意味著「要多長」由時間決定而非
  `max_tokens` 決定。64K 的回答需要約 7 分鐘，仍在新的 600s 之內；256K 需要
  28 分鐘，**做不到**——即使路由允許。這條沒有被任何機制偵測。
- `fledge-alpha-free`、`ling-3.1-flash-free`、`nemotron-3-ultra-free`、
  `ling-3.0-flash-fin-free` 本輪無資料，維持宣告。
- `big-pickle` 與 `longcat-2.5-preview-free` 仍只有區間。
- 本節所有數字與 §四十 同級：一次性快照，原始 JSON 在
  `.scratch/verify/output-ceiling2-results.txt`、`vision-results.txt`、
  `tool-use-results.txt`，**不入庫**。

## 四十二、面板為何在「手動探測」之後仍無法對齊真實能力（2026-10-07）

使用者提問：按了探測，能力還是對不上。查完程式碼，原因不是探測做得不夠，而是
**面板在資料模型層就不可能對齊**。五條，每一條都可以在程式碼裡指出來：

1. **卡片只有三個欄位。** `ModelCapability` = `{id, image, thinking}`。真正決定
   每一次請求的兩個數字——`contextWindow` 與 `maxTokens`——**根本不在 payload 裡**。
   所以一輪探測結束後，一行最多只會多出「✓ 142ms」；資料模型裡沒有任何欄位可以
   顯示 1,048,576。
2. **全链路沒有 provenance。** `image: true` 無論來自 models.dev 的宣告還是
   線上實測，渲染出來一模一樣。同理，宣告的 200000 與實測的 1048576 也無法區分
   ——不是忘了標，是**沒有地方可以標**。
3. **探測的題目結構上不可能發現低報。** `probeOnce` 送的是一個短文字提示、
   `maxTokens: 1024`，它永遠靠近不了上下文或輸出的任何一個上限。而唯一的執行期
   窗口機制 `observeClamp` 需要 `max_tokens === 1` 加空回應——也就是**對話已經死在
   夾擠上之後**才會響。使用者早就損失了。
4. **已存在的證據無處可放。** 視覺 5/5、工具 9/9、輸出上限表都在種子表與本文，
   而 `ProbeRecord` 只有 liveness、effort、context 三個欄位：**沒有任何一個位置
   可以記住「視覺已實測」**，所以一輪探測既記不下也顯示不出來，明天新出現在 Zen
   上的模型則從零開始。
5. **於是這面面板其實是一份 liveness 報告，穿著能力卡的衣服。** 「立即探測」
   按鈕點下去能加的資訊只有狀態與延遲。**探測從不問能力，所以按鈕的能力與對齊無關。**

**修法（三段，缺一不可）**

- **(a) 投影。** 卡片改為 `Model<Api>` 的投影：帶上實際的 `contextWindow` 與
  `maxOutput`（**與 pi-ai 夾擠用的是同一組數字**，所以面板不可能描述一個請求路徑
  沒在用的上限），並在旁邊帶上宣告值與每個軸的 `measured` 旗標。**不需要任何額外
  請求**。
- **(b) 證據存放。** `ProbeRecord.capabilities` 成為可持久化、以
  `capabilityFingerprint`（context:output:modalities）綁定的逐軸事實，並以
  2026-10-07 的實測結果作為種子。**缺席 ≠ 否定**與 effort 軸同一條規則：
  端點宕機、配額用完、整段只有 thinking 沒文字，都**不寫任何東西**。
- **(c) 輪次補問。** 對「面板還沒有證據」的軸，每個模型**只問一次**：視覺給一張
  手寫 PNG（上 `#FF00FF` 下 `#00FF00`），工具給**真實 schema**（閘門那個
  `Do not call` 的佔位必須**取代**而不是附加，否則同一個工具清單裡有互相矛盾的
  兩個定義，那不是量測）。視覺題的預算用 4096，因為 1024 會讓推理模型把預算花在
  thinking 上一個字不回——那是**假的視覺失敗**（2026-10-07 於 mimo 與 muse-spark-1.2）。

**為什麼 (c) 的成本可以接受**：每軸每模型一次，然後永遠不再問；而且種子表意味著
今天已實測的模型**一點都不花**。剩餘成本是「這個模型還沒有證據」的一次性代價，
且與每模型既有的九次預算共用同一個上限——面板本來就報這一輪花了幾次請求。

**這一節與前面各節的關係**：§四十一證明「宣告會低報 32 倍」，
§四十一之二證明「就算修正，還有一道 180 秒的牆」，而本節說明的是**使用者為什麼
在面板上看不到以上任何一條**。三者合起來是同一個病：**宣稱、量測、顯示是三件
分離的事，而只有第一件曾經連著第三件。**

## 四十三、把「受理」寫成「能力」：1,040,384 不是任何模型的輸出長度（2026-10-07）

**使用者指正**：面板顯示最大輸出 1,040,384，而「目前地球最強模型都到不了百萬輸出」。
指正成立，本文 §四十一把**受理**寫進了**能力**欄位。

**錯在哪裡，一句話**：`limit.output` 經 pi-ai 上線後是**請求預算**，不是「這台機器
最多能寫幾個 token」。§四十一自己寫過「接受 ≠ 兑现」，卻仍把「接受的最大值」放進了
一個名為「最大輸出」的欄位，並在 README 寫成「它實際回答 1,040,384」。

**兩種證據必須分開（本輪新增的判別實驗）**

| 實驗 | 結果 | 說明 |
|---|---|---|
| `max_tokens: 8`，提示要求印 1..100000 | mimo / space-bunny / longcat / nemotron-3-ultra / big-pickle / nemotron-3.5 全部**精準停在 8 或 64 / 2048**，`finish_reason: length` | **路線確實執行這個欄位** |
| 同上，40,000 預算 | mimo **產出 40,000**，`stopReason: length`，約 152 tok/s | 這才是能力證據 |
| 1,040,384 預算 | HTTP 200，回了幾十字 | 只證明**不拒絕**，不證明寫得出來 |

於是三種事實各有各的重量：

1. **受理**（HTTP 200 at N）→ N 可以當**預算**：它不拒絕，而且既然欄位會被執行，
   預算太小會真的截斷回答。預算調高**不會**讓模型寫更多（模型自己決定何時停）。
2. **拒絕**（400/422 at N，且前一步 200）→ N 之上不可用，這是**硬上限**。
   `space-bunny-free` 拒 782,336、`longcat` 拒 393,216，兩者的宣告都落在區間內。
3. **產出**（`finish_reason: length` 且 produced = 預算）→ 這才是**能力**。
   至今只有一個模型有：`mimo-v2.6-flash-free` ≥ **40,000**。

**採納的修法**（不是把數字改回去）

- `SEED_OUTPUT` 的欄位由 `measured` 更名為 **`budget`**，並新增可選的 **`observed`**。
  預算繼續照實測調高——因為**低報預算的真實後果是靜默截斷**，而那是使用者每天都在
  遇到的損失。
- 新增 `observedOutputFor()`：**只有真的看過一次生成**的模型才有值，其餘一律缺席。
  面板把它顯示為「實測产出 ≥40,000」，與「輸出預算 1,040,384」並排且分開命名。
- 面板欄位由 `maxOutput` 更名為 `outputBudget`，README 與 CHANGELOG 的每一句
  「它實際回答 N」改為「它願意受理 N 的預算」。

**為什麼不干脆全部退回宣告**：那會把 mimo 從 40,000 退回 32,000——而 40,000 是**親眼
看見它寫出來**的。真正的錯誤不是調高，而是**把預算說成產出**。

**仍未量測**：其餘七個模型的產出。一次 40,000 token 的生成約 4 分鐘、40K 輸出
token，七個模型約 280K token，吃的是使用者的共享 bucket；**未經同意不做**。
`nemotron-3.5-lightning-free` 在 64 預算下產出 55 並 `stop`（模型自己收尾），
在 2048 下才產出 2048——**小預算會讓「模型自己停」看起來像「欄位被忽略」**，
這是本節第二個可複用的教訓。

**上限的真正邊界**：時間。mimo 約 152 tok/s，10 分鐘逾時 ≈ 91,000 token，與預算無關。
所以即使某模型真的能寫 200,000，這個插件也不會讓它寫完——**而這一點沒有任何機制
會報告**。

## 四十四、第二度指正：最大輸出預設**跟隨 models.dev**（2026-10-07）

§四十三把「受理」從「能力」欄位移出去，但預算本身仍留著那八筆受理值。**追問
「最大輸出跟隨 models.dev 呢？」之後，預算也回到 models.dev，只留一個例外。**

**為什麼預設跟隨 models.dev，不是因為它對，而是因為另外兩種證據都不夠**

| 選項 | 後果 |
|---|---|
| 全站退回 models.dev | mimo 從 40,000 退回 32,000——而 40,000 是**親眼看見它寫出來**的。這是真實的靜默截斷損失。 |
| 用受理值（本節之前） | 七個模型的預算比需要的高，且**沒有任何觀察支持**。最壞情況是一個囉嗦的模型在 10 分鐘內寫到約 91,000 token，而不是 32,000——那是使用者共享 bucket 上 3 倍的消耗。 |
| **跟隨 models.dev，除非有被看過的生成** | 只有 mimo 改變（32,000 → 40,000，+25%），而且這個改變有交付級證據。其餘七個一個字都不動。 |

**規則一句話：只有交付級證據能移動這個欄位。** 受理不是，拒絕不是，「路線大概會
接受更多」也不是——因為這三者都不是「看見某台機器寫出來」的觀察，而無法指出觀察的
數字就是自己編的。

**仍然成立的量測（但只作為「宣告可能錯」的論據，不作為抬高的依據）**：路線確實執行
`max_tokens`——要求 8、提示要寫上千字，六個模型精準回 8 且 `finish_reason: length`。
所以宣告太小**確實**會截斷；這是「宣告可能低估」的證據，不是「可以調多」的證據。

**這條規則同時是省錢的**：使用者的 bucket 是共享的，選項二最壞可讓單輪多燒 3 倍輸出
token，選項三最壞只多 25%，而且只發生在一個模型上。

**未量測**：另外七個模型的產出。一次 40,000 token 的生成約 4 分鐘、40K 輸出 token，
七個約 280K token——**未經同意不做**，且做出來之後，它們的預算會各自變成被觀察到的
數字，那才是這張表該有的樣子。

## 四十五、交付級實測：兩個模型，以及三個讓量測本身出錯的陷阱（2026-10-07）

使用者同意花 token 去做「被看過的生成」。結果**兩個模型拿到交付級證據，三個陷阱
比那兩個數字更值得記錄**。

**量得著的**

| 模型 | 宣告 | 請求 | 產出 | stop | 時間 | 速率 |
|---|---|---|---|---|---|---|
| `mimo-v2.6-flash-free` | 32000 | 64000 | **64000** | length | 346s | 185 tok/s |
| `big-pickle` | 32000 | 48000 | **48000** | length | 132s | 365 tok/s |

**陷阱一：模型自己決定何時停。** 同一個模型、同一個請求值，mimo 第一次產出 892
（`stop`），第二次產出 64000（`length`）。**單次短答是關於那個樣本的證據，不是關於
上限的證據**——所以協議必須重試，而表裡每一筆都是「被目擊過的生成」。

**陷阱二：準入門把工具放進每個請求，而呼叫工具會結束生成。**
`longcat-2.5-preview-free` 在 64000 的預算下產出 121 token 且 `stopReason: "toolUse"`
——**讀起來和「路線把輸出卡住了」一模一樣**。修正是在系統訊息裡明說這是一場長度
量測、不要呼叫工具。

**陷阱三：速率是沒人看得見的天花板。** 實測 34 tok/s（nemotron-3.5）到 365
（big-pickle）；在十分鐘請求逾時內約等於 28,000 到 295,000 token。**對宣告為
128000 / 262144 / 524288 的模型而言，瓶頸是時鐘而不是預算**——就算測出更高也改不了
任何東西。這也是本輪提前收手的原因：剩下的模型即使測成，觀察值也不會超過它們的宣告。

**一個反直覺的副產物**：「無法自然結束」的提示（無限重複單詞）**測不出來**——
big-pickle 在 64000 預算下寫 139 token 就 `stop`，nemotron-3.5 寫 680 也停。模型會
收尾。反而是「印 1..100000」這個有終點卻被要求不要提前結束的提示有效。

**沒有量到的，以及為什麼不算遺漏**：longcat 自己寫到 32770 就收尾（534 秒，61 tok/s），
nemotron-3.5 寫 4058 就收尾（34 tok/s）。這些是**樣本事實，不是上限**，所以不進表；
表裡只放 `finish_reason: length` 且產出等於請求值的樣本。

## 四十六、怎麼���知道「真實最大輸出」：讓它拒絕，不是讓它生成（2026-10-07）

使用者問：到底怎樣才能得到真實最大輸出？上網搜是否可行？

**先答搜尋**：可行，但只能拿到**第三方轉述**，而本次實測證明轉述會出錯。
搜到的兩條相關來源是 [models.dev 的 OpenCode provider 頁](https://models.dev/providers/opencode)（**與
插件讀的是同一份檔案**，不是獨立資訊源）與 [NVIDIA NIM 的 Nemotron 3.5 Lightning 文件](https://docs.nvidia.com/nim/large-language-models/latest/get-started/advanced/get-started-nemotron-3.5-lightning.html)（講的是 `max_output_tokens`
語意，且針對 NIM 端點而非 Zen）。**它們描述的是底層模型，不是這條路由的閘門上限**——
而真正限制使用者的恰恰是閘門。結論：搜尋適合作為宣告的交叉檢查，**不能當量測**。

**然後是那個更好的答案：讓它拒絕**

探測時用一個遠超窗口的請求值（每步約 30 個輸出 token），立刻得到：

| 模型 | 请求 | 结果 |
|---|---|---|
| `mimo-v2.6-flash-free` | 1,048,577 / 2,000,000 / 8,000,000 | **三次全 200**，各產出 12–15 token |
| `big-pickle` | 2,000,000 | `[invalid_request_error] Requested token count exceeds the model's maximum context length of **262139** tokens.` |

兩件事同時被證明：

1. **mimo 在這條路由上，八百萬的輸出預算都照收**——先前「接受 1,040,384」根本不是
   路由的上限，而是**我們自己 pi-ai 夾擠的上限**。所謂「最大輸出」對 mimo 而言是
   未知且可能極大的數，唯一的天花板是時間。
2. **big-pickle 的上游自己說出���真值：262,139。** 而插件給它廣播的是 **1,048,576**。

**所以這不是量測方法學的問題，是我上一輪種下的種子本身有毒。**

## 四十七、撤回一顆種子：接受不是量測，兩根軸都適用

`SEED_CONTEXT` 裡的 `big-pickle: 1048576` 來自「1048576 被接受、1572864 與 2097152
被拒（都是泛用 400，什麼都沒說）」——當時被當成「寧可保守的下界」而採用。四小時後，
同一個端點：

- 在 `max_tokens: 2,000,000` 時**明確說出**自己的上限是 **262,139**；
- 幾分鐘後連 `210,000` 都回 500，而更早的 `200,000` 還成功過——**上游不穩定**。

**危害不是「高報」，是 4 倍**：DSH 會在約 839K 估算 token 才壓縮，而真實天花板是
262K；超過之後的每一個請求都會被拒。使用者會看到一個「突然壞掉」的模型，而且沒有
任何地方說得出原因。**已撤回，聲明值 200,000 重新上線。**

**由此得到的通則（比這個 bug 本身更值得留著）**

> **窗口種子只能來自端點「自述」���數字，否則不要種。**

理由是成本對比懸殊到荒謬：

| 手段 | 成本 | 回傳 |
|---|---|---|
| 讓它拒絕 | **0 個輸出 token** | **一個數字** |
| 讓它生成到預算 | 數萬 token，且可能根本不寫滿 | 一個下界 |

之前整段工作都在用昂貴的那一手段去問一個便宜手段就能回答的問題。**先問它上限在哪，
再問它能不能寫到那麼多。**

**還沒做的**：其餘九個模型尚未做這種上探。每個約 3 次請求、共不到 100 個輸出 token，
遠比已花的生成量便宜；**未經同意不做**，因為它會動到上下文廣播值。

## 四十八、三種機構，三種權重（2026-10-07）

使用者的指示是「上網搜模型的最大輸出，然後測」。搜尋的結果比預期好，也比預期更
能說明問題——**因為第一方規格和路由實際執行的東西，不是同一個數**。

### 一、廠商一手規格：[MiMo-V2.6-Flash 官方頁](https://mimo.mi.com/models/en-US/mimo-v2.6-flash)

> Context Window **1M tokens** · Max Output **128K tokens** · RPM 100 · TPM 10M

| | models.dev 宣告 | 廠商 | 差 |
|---|---|---|---|
| 上下文 | 200000 | **1048576** | 宣告低 5.24× |
| 最大輸出 | 32000 | **131072** | 宣告低 **4.1×** |

**上下文這一欄獨立佐證了我們的種子**：1M = 1,048,576，正是端點在拒絕報文裡自述的
數字。兩條互相獨立的證據（上游自述、廠商規格）落在同一個值上——這是本 ADR 裡
證據最強的一格。

### 二、路由實際執行：mimo 根本不設上限

| 模型 | 1,048,577 | 2,000,000 | 8,000,000 |
|---|---|---|---|
| `mimo-v2.6-flash-free` | 200 | 200 | 200 |
| `nemotron-3-ultra-free` | 200 | 200 | 200 |
| `nemotron-3.5-lightning-free` | 200 | 200 | 200 |
| `muse-spark-1.3-contributor-free` | 200 | 200 | 200 |
| **`longcat-2.5-preview-free`** | **拒** | **拒** | **拒** |
| `fledge-alpha-free` | 500 | 500 | 500（上游當時故障） |

**longcat 的拒絕正文直接寫出真值**：

```
[invalid_parameter] 參數校驗失敗: /max_tokens: 995834 is not less or equal to 262144
```

（995834 是我們自己的夾擠值：1,000,000 窗口 − 估算 − 4096。）**所以 longcat 的真實
上限是 262,144，而 models.dev 公布的是它的一半。**

### 三、按廠商數字去測 mimo 的 128K

| 嘗試 | 產出 | stop | 時間 |
|---|---|---|---|
| 1 | **79,722** | `stop`（自己收尾） | 762s |
| 2 | 14,235 | `stop` | 103s |

**它沒有寫滿 131,072——因為它不想寫那麼多，不是因為寫不出。** 這正是
§四十五 那條教訓的第三次復現：模型自己決定何時停。所以 79,722 是「觀察到的產出」，
131,072 是「廠商公布的天花板」，兩者不互相冒充。

### 四、最終規則：三種證據，各有各的權重

| 證據 | 誰說的 | 成本 | 能證明什麼 |
|---|---|---|---|
| **named** | 廠商規格 / 路由拒絕正文 | 0 輸出 token | **預算的上限**。超過它會被拒，低於它會截斷 |
| **observed** | 目擊一次生成 | 數萬 token，且可能不寫滿 | 模型**真的寫過**多少 |
| 宣告 | models.dev | 0 | 預設值，兩個都沒有時照用 |

`maxTokens = max(宣告, named, observed)`，再以窗口為上限。**`observed` 永遠不會被
`named` 灌水**：面板上 mimo 顯示「輸出預算 131,072 / 實測產出 64,000」，兩個數字
並排，來源不同。

**仍然成立的瓶頸**：mimo 約 138–185 tok/s，而插件的請求逾時是 600 秒 → 單次回答
約 82,800–111,000 token。**131,072 的廠商上限在十分鐘內寫不完**（實測那次 79,722
用了 762 秒）。也就是說：**時鐘仍然比任何預算更早生效**。

## 四十九、停止預置：把「路由自述的上限」變成運行時採集（2026-10-07）

前三節把證據分了級，第四節把方法論擺正了，但**表仍然是預置的**——裡面每一筆都要有人
手動量過、寫進程式碼、然後在某天過期。§四十七證明這條路會出錯（big-pickle 的四倍高報
就是預置表裡的一顆種子）。

**採集機制（本輪實作）**

1. **免費的那個儀器**：路由拒絕時，報文裡會**自述**上限——
   `max_tokens: N is not less or equal to M`（輸出）、`maximum context length of K
   tokens`（上下文）。拒絕不產生任何輸出 token，**卻回傳一個數字**。相較之下，一次生成
   要數萬 token 而且可能連預算都寫不滿。
2. **每個探測輪次問一次**：請求值給「整個廣告窗口」，pi-ai 會夾到
   `window − est − 4096`——也就是這段對話能帶走的最大值。**有上限的路由會拒絕並說出
   數字；沒上限的路由會回答，而「回答了」本身就是答案**（記為 `fp: ""`，且因為
   `isMeasuredLimits` 拒絕空指紋，它**不會**被讀回成一個量測，下一輪會再問）。
3. **按宣告指紋保存**：`ProbeRecord.limits` 帶 `fp` 與 `at`。宣告一改，指紋不符即丟棄。
   上下文上限一旦被命名，**當場生效**（不必等整輪結束），因為那是最強的一類證據。
4. **優先級**：`maxTokens = max(宣告, 路由自述, 廠商規格, 目擊產出)`，以窗口封頂。
   路由自述排第一——它是第一手、當下、免費，而且是**新模型也立刻能有的**證據。

**為什麼這是對的形式而不只是一個功能**

預置表回答「2026-10-07 那天是什麼」；採集回答「這條路由現在是什麼」。後者不需要有人
記得回來更新，也不需要有人記得哪些結論建立在受理之上——因為**受理永遠不會被採集**，
它不產生數字。

**面板因此顯示一個區間**，而不是一個數字：`實測產出 ≥79,722 · 路由自述上限 262,144`
（分屬不同模型時各自顯示）。單一數字在這裡從來都是錯的形狀——真實天花板本來就是區間。

**仍然不做的**：不從受理抬價（已證有毒）；不追生成（證據密度太差）；不動
`nemotron-3.5-lightning-free`（262,144）與 `space-bunny-free`（524,288），因為它們的
時鐘天花板先到。

## 五十、機制第一次上線，抓到它自己的兩個 bug（2026-10-07）

採集機制第一次在真實輪次裡跑，結果**證明了它能工作，也暴露了它壞掉的方式**。

**證明**：重啟後第一輪手動探測，`longcat-2.5-preview-free` 自己把上限交出來了：

```json
"limits": { "output": 262144, "fp": "1000000:131072:text+image", "at": 1791348182449 }
```

沒有人手動量過它，沒有人寫程式碼——路由拒絕，數字被讀出來，按模型記住。

**Bug 一：整輪的請求數被拿去比每模型的預算**

`if (state.probeRun.requests >= samplesPerModel)` —— `requests` 是**整輪**累計，
`samplesPerModel` 是**每模型**上限。整輪用掉九個請求之後，後面所有模型的 ceiling 與
capability 問題全部被跳過。現場證據：十一個模型裡**只有前四個**（big-pickle、fledge、
ling-3.1、longcat）有 `limits` 欄位，其餘七個連問題都沒被問到。

**而這個 bug 的樣子極其危險**：被跳過的模型看起來跟「路由什麼都沒說」一模一樣——
那正是 `fp: ""` 記錄的狀態。**兩種完全不同的情況在資料裡長得一樣**，而其中一種
（沒問過）會被永久當成答案。

修法：改用每模型計數器。附帶的教訓寫進測試名稱裡。

**Bug 二：存的指紋和驗的指紋不是同一個**

存進 `ProbeRecord.limits` 時用的是 `capabilityFingerprint`
（`1000000:131072:text+image`），而 `measuredLimitsFor` 驗的是 `contextFingerprint`
（`1000000:131072`）。**兩者永遠不相等，所以每一筆採集到的上限都被靜默丟棄。**

面板上長貓的 262,144 仍然顯示——因為**種子表裡本來就有這個數**。也就是說
**機制看起來在工作，實際上完全沒生效**，而唯一的線索是 `stated` 欄是 null。

這是本專案反覆出現的同一個失效形狀：**證據存在、儲存正確、但沒有任何一條路徑
把它接到結論上**，於是結論來自舊的來源，看起來一樣。§四十七（受理當量測）、
§四十三（受理寫成能力）都是同一個形狀的不同外觀。

**修完之後值得注意的**：採集到的值仍然不保證被採用——它必須通過與宣告的指紋比對。
本輪 longcat 的宣告沒變，所以指紋相符、值被採用。**宣告一改，指紋不符，採集到的值
連同種子一起丟棄**，而那正是應該發生的行為：路由器可能已經改變，而那個數字是對
**舊的宣告**說的。

**新一輪的成本**：每個尚無 `limits` 的模型多一次請求（本輪十一個模型 → +11），
與每模型既有的九次預算共用同一個計數器，面板照樣報這一輪花了幾次。

## 五十一、第三次同形失效：一條永遠不會被重問的記錄（2026-10-07）

§五十 修掉兩個 bug 之後的第二輪現場檢查：**覆蓋率修好了**（十一個線上模型全部被問到，
上一輪只有四個），長猫仍然只有 longcat 命名了上限——這與手動探測的結果完全一致
（mimo / nemotron×2 / muse-1.3 在八百萬的請求下都回答，big-pickle 的端點當時只給
泛用 500）。

**但長猫的 `stated` 仍然是空的。**

原因：那筆記錄是**修復前**寫下的，用的是舊指紋
`1000000:131072:text+image`。`isMeasuredLimits` 只檢查「`fp` 是不是非空字串」，
所以它**通過**校驗、被讀回、然後在 `measuredLimitsFor` 的指紋比對裡被丟棄。
而輪次的提問條件是「`limits === undefined`」——它不是 undefined，**所以永遠不會被重問**。

**這是同一個失效形狀的第三次出現**（§47 受理當量測、§43 受理寫成能力、這次：
正確的量測讀成「沒有東西」）。共同點永遠是同一個：**證據存在、儲存正確、但沒有
任何一條路徑把它接到結論上**，而結論來自舊來源，外觀一模一樣。

**修法**：提問條件從「有沒有記錄」改成「**記錄能不能被採用**」——
指紋對不上就重問；`fp: ""`（問過、路由沒說）仍然豁免，因為那確實是本 session 問過的
事實，且下次熱啟動會被丟棄、新 session 自然會再問。

**這也是為什麼現場檢查不能省**：這個 bug 是在部署之後、看到 `stated` 為空才發現的，
而 `stated` 為空這件事本身就是唯一���線索——因為面板上 262,144 照樣顯示，
只不過那個數來自種子表。**沒有任何一個數字看起來是錯的。**

## 五十二、一次「現場檢查」測的是舊代碼——先證明運行的是新代碼（2026-10-07）

第三次現場檢查得出的結論是「長貓沒被重問，修復沒生效」。**修復其實已經生效了，
但現場跑的是修復前的構建。**

- `src/catalog.ts` 修於 13:53:39
- `lib/catalog.js` 構建於 **13:46:50** ← 早了七分鐘
- DSH 重啟於 13:55:26，載入的自然是那個舊的 `lib/`

原因是流程性的：為了跑得快，我用 `npx tsx --test` 直接繞過了 `pnpm test`
（它會先跑 `pretest` → `build`）。**類型檢查通過 ≠ 構建更新**——`tsc --noEmit` 根本不
寫 `lib/`。

而這個陷阱在同一個測試檔裡早就寫著警告（`tests/compatibility.test.mjs` 第 52 行）：

> `npx tsx --test tests/*.test.mjs` 是最高頻的內層循環，它**不跑 `pretest`**，所以在這裡
> 導入 `lib/` 會靜悄悄地測到過期的構建。

那次警告是給「測試導入 lib」的；這次是給**現場檢查**的——同一個坑的另一個入口。

**因此：任何現場檢查的第一步不是看數據，是先證明運行的是新代碼。**

```sh
ls -la --time-style=+%H:%M:%S lib/*.js src/*.ts   # lib 必須比 src 新
grep -c "<修復的標記>" lib/<file>.js             # 標記必須在構建裡
```

三條都滿足，現場數據才有意義。**否則「沒生效」這個結論本身可能是錯的**——
而這次它看起來完全合理：數字沒變、行為沒變、`stated` 仍然是空。沒有任何東西會提示你
你測的是舊代碼。

## 五十三、按了探測「閃一下什麼也沒發生」（2026-10-07）

**症狀**：重啟後按「立即探測」，按鈕閃一下恢復原狀，接下來近半分鐘什麼都沒發生。

**先排除伺服器**：直接打那個 POST。輪次**確實啟動**——`running: true` 在點擊後
**1.4 秒**發布，整輪 **29.4 秒**結束。機制是好的。（第一次量到「33 秒內從未見到
running」是誤判：那次點擊撞上冷卻，被 429 拒了，而腳本沒有區分「被拒」與「啟動」。）

**根因在客戶端的一個 null 分支**，而且它的前提就寫在同檔案的測試註釋裡：

```js
if (reading === null || reading.running === true) { adopt(reading); return; }
```

重啟後的那個窗口���，卡片掛載時發出的**第一次進度讀取會失敗**（外掛路由還沒起來），
`loadProgress()` 回 null，`pollRef.current.last` 保持 null。讀者就在這個窗口裡點了按鈕，
於是：

1. `saw = null`（螢幕上沒有任何一輪的時間戳可比）
2. 點擊處理器自己的那次讀取同樣回 null → `adopt(null)` → **直接 return**
3. **`startPolling()` 從未被呼叫**：整輪期間卡片沒有任何輪詢鏈
4. 而 POST 要等整輪結束才回應（`forceProbes()` 是 `await` 完 `runProbeSingle` 才返回）
5. 於是按鈕亮一次、之後近 30 秒畫面靜止

**同一個 owner 的第二處**：`adopt()` 的身份判據 `reading.startedAt === saw`。
`saw` 為 null 時，真實讀數的數字時間戳**永遠不等於 null**，所以每一讀都判失敗、
每一讀都走「放棄」分支。

**修法（同一個 owner，兩處）**

- null 讀取不是「沒東西可顯示」，是「沒有可比對的身分」→ **裝上輪詢**。
- `saw === null` 意味著螢幕上什麼都沒有，**沒有任何東西可以被排除** → 繼續等，
  由 `AWAIT_GRACE_MS` 綁定，所以後端真的不啟動時按鈕仍然會回來。

**這個 bug 是既有的，不是本輪改動引入的**；而且它需要的正是「重啟後立刻點按鈕」這個
最自然的動作。既有測試刻意先讓首次讀取落地（「as a reader's would」），所以從來沒覆蓋
到它——**測試的前提恰好就是生產環境不保證的那件事**。

**一個方法論教訓**：第一次嘗試寫這個測試時，我把首次讀取做成「永不返回」，結果**測試通過
了**——因為掛起的讀取把「觸發放棄的那一次讀取」也一起掛掉，缺陷根本不會被走到。改成
「點擊前所有讀取都失敗、POST 之後才恢復」才真正復現。**一個會讓缺陷消失的測試不是測試。**

## 五十四、「不配置最大輸出」實測不可行，於是補上唯一免費的那個觀測（2026-10-07）

使用者問：能不能乾脆不配置最大輸出，讓模型自適應？

**天花板是惰性的，這一點已經有證據**：給 mimo 發 `max_tokens: 8,000,000`，它回的是
12–15 個 token 的「ready」；同一個請求值兩次產出 892 與 79,722。模型自己決定何時停，
預算只影響「不攔腰截斷」。

**但「省略欄位」不可行**（把 `max_tokens` 從出線的 body 裡拿掉，其餘完全不變）：

| 模型 | 顯式 64000 | 省略欄位 |
|---|---|---|
| mimo | 650 tok / `stop` / 15s | **0 輸出 / `error` / 283s** |
| big-pickle | 736 / `stop` / 14s | 907 / `stop` / 22s ✓ |
| longcat | 64,000 / `length` / 947s | 129 / **`stop=toolUse`** / 7s |

三種結果裡只有一種正常。**路由在缺這個欄位時會拒絕或改變行為**，所以「不配置」不是一個
選項；正確做法是「發這條路由肯收的最大值」，而那正是採集機制在做的事。

**順帶補上唯一免費的觀測。** 整條輸出軸壓在一個沒有人能問模型得到的數字上：
**有沒有真實回答想寫得比我們發的更多？** 合成生成要幾萬 token 而且不可靠（同一請求
892 與 79,722），而**真實流量本來就帶著答案**——`stopReason === "length"` 就掛在一個
本來就要發的請求上。所以：

- 回答被截斷 → 依 `emitted` 與模型自身上限比較，分成 `output`（我們的預算太小）與
  `context`（對話滿了，與輸出預算無關）兩類計數
- **持久化**：這是一個跨天累積的答案，而重啟會清掉記憶體裡的計數——今天就重啟了六次
- 面板只在真的有數字時顯示；**零是有價值的答案**（代表預算從未生效，調高它買不到東西）

這一條把「預算夠不夠」「要不要加逾時」從意見變成事實，而取得事實的成本是零。

**這一輪也把「採集優先級」的最後一格補上了**：路由自述（長猫 262,144，自動學到）
> 廠商規格（mimo 131,072）> 目擊產出（長猫 64,000、big-pickle 48,000、mimo 79,722）>
models.dev 宣告。**全部都有出處，面板全部顯示出處。**

## 五十五、每一個數字都對，但沒有人讀得出「現在是多少」（2026-10-07）

面板行長這樣：

```
longcat-2.5-preview-free   👁视觉✓  ★思考·High  工具✓
上下文 1,000,000   输出预算 ~~131,072~~ → 262,144   路由自述上限 262,144   实测产出 ≥64,000
```

使用者問：**「當前配置的最大輸出大小是多少，沒看懂。」**

四個數字全部為真，兩個箭頭全部有依據，而答案**無法一眼讀出**。這說明一行
**不可能靠「更真」變得可讀，只能靠變短**：

- 生效值（`上下文 1,000,000 · 輸出 262,144`）留在明處——它就是請求帶著走的數字
- 出處（models.dev 宣告被誰取代、路由自述上限、實測產出、真實回答被截斷幾次）
  全部收進一個 tooltip
- **刪掉明處的刪除線**：一個劃掉的數字擱在生效值旁邊，對沒有內化這個慣例的人
  來說，它看起來就是**生效值**

**這是本專案第三次犯同一個錯的不同外觀**（§47 受理當量測、§43 受理寫成能力、
§五十三 讀取失敗被當成沒資料）：**證據齊全，但沒有把它接到「讀者要回答的那個問題」
上**。前兩次是接錯結論，這次是接對了結論、卻擺錯了位置。數字沒有錯，排列讓它們
互相稀釋。

**規則**：一行只回答一個問題；回答完了，多餘的真話進 tooltip。真話不會因為沒顯示
而失效——它們仍然可查、可 hover、可被測試斷言。

## 五十六、「已實測」曾經一個詞蓋住四種證據（2026-10-07）

agent 審計自己代碼時挖出來的：**面板的 `measured` 是一個算出來的布爾值**
（`!== declared`），不是證據。所以

| 數字的來處 | 面板寫的 |
|---|---|
| 端點在拒絕正文裡自述 | 已實測 |
| **廠商官網公布的**（mimo 的 131,072） | 已實測 |
| 目擊一次生成寫完（big-pickle 48,000） | 已實測 |
| 由夾擠簽名推斷 | 已實測 |

而**數字一個都沒錯**。錯的是那個詞——它讓「小米官網說 128K」看起來像「我們在這條
路線上量到了 128K」，而這正是今天早上「一百万输出明顯不對」那個誤會的形狀。
**ADR §五十五 剛寫下「一行只回答一個問題」，轉頭代碼又用一個詞回答了四個問題。**

**改成證據分類**（`route` / `vendor` / `witnessed` / `inferred` / `declared` / `none`），
並且**平手時偏向更可信的來源**——長貓的 262,144 同時有「路由自述」與「廠商公布」兩個
來源，顯示 `route`，因為那是路由自己說的。

另一個審計發現：**上限採集在每日輪次裡從不運行**。能力題與思考軸共用
`samplesPerModel`，而每日輪次把它設成 1，於是那個區塊在第一個請求前就 break。
**§四十九 寫的是「每個探測輪次問一次」，而代碼從來沒有這麼做過**——兩根軸現在各自
有預算。

**順帶修了一個我沒有想到的成本錯誤**：視覺題最多燒 4096 個輸出 token，而每日輪次涵蓋
**包含使用者已關閉的**模型。為看不見的模型每天付這筆錢不合理，所以**上限題**（拒絕時
零輸出 token）留在每日輪次，**宣告能力題**（視覺／工具）留在手動輪次——手動輪次只看
螢幕上的東西。

**測試帳**：這一輪我花了遠超預期的時間在改測試的請求計數上（十一個測試讀的是「每模型
一次請求」）。這是第二次在同一個地方卡住——**改動很小，帳目很貴**。留一句話給以後的
自己：先讓改動生效，再改測試，不要為了讓測試先通過而把改動做小。

## 五十七、四件「寫了但從沒被讀過」（2026-10-07 收尾）

agent 審計挖出來的清單裡，最後四條全部屬於同一個形狀：**機制存在、文檔齊全、沒有任何
程式路徑去讀它們**。§四十七、§四十三、§五十六都是這個形狀的不同外觀。

| 機制 | 寫在哪裡 | 之前發生什麼 |
|---|---|---|
| `nextProbeAt` | 每個 `dead` 記錄 | **移除是永久的**——誤判下架的模型永遠回不來，而 Zen 重新上架的名字也永遠回不來 |
| 視覺／工具的 TTL | 從來沒有 | 一個月前的探測與今天的探測**長得一模一樣**，且沒有任何路徑能降級一個徽標 |
| 種子與宣告的逐字相等 | `seededContextFor`／`observedOutputFor` | models.dev 改一個錯字，就**靜默刪掉整張表裡唯一一次被目擊的生成** |
| `region-blocked` | 從來沒有 | 「not available in your country」被歸成 `unknown` 或 bad-key，而這是**唯一一個讀者能一行修好的故障** |

**改法都不是新增，而是接上**

- `nextProbeAt` 現在被讀：一個死掉七天的模型會被再問一次。這同時是 Zen 重新上架後模型
  回來的唯一途徑——**沒有它，一次誤判就是永久的**。
- 視覺／工具加 `CAPABILITY_TTL_MS = EFFORT_TTL_MS`（30 天）。注意一個細節：**沒有傳時鐘
  時不猜年齡**，判決照舊成立；會重問的是**輪次**，而它一定傳時鐘。這條區分是刻意的：
  讀取不該因為缺一個參數就變成「不知道」。
- 種子與宣告不符時**降級而不是丟棄**：套用但走 `declared × 4` 的閥門，面板標成
  `inferred`——**它停止聲稱自己是一手證據，但數字還在**。而被目擊的生成保留，並由
  `observedOutputIsStale` 告訴面板「這個數字沒有對著當前宣告複核過」。
- `region-blocked` 成為獨立狀態，且歸入**呼叫端**條件那一類（灰色），因為壞掉的是你的出口
  不是模型。

**這一整段的教訓，已經是第四次寫下同一句話**：證據齊全不代表結論正確；**要問的是
「這個數字怎麼到達它所在的欄位」**。四次都是同一個答案的變體，而每一次都要等一次審計
或一次現場檢查才發現。ADR 0004 從 §四十七到 §五十七記錄的正是這個——**機制的數量不是
品質的證明**。

**以及第五次，而這一次是我自己造成的**：把本節追加進 ADR 時，我先寫了一個佔位檔、
`rm` 掉真檔、再追加新章節——**刪掉了 2,073 行歷史**，而且已經 commit。從上一個提交恢復
回來了。同一個教訓，第五次：機制存在不等於結論成立，而**「我以為我做了什麼」同樣不
等於我真的做了什麼**。

## 五十八、「問過了」原本在重啟時被丟掉（2026-10-07 現場）

重啟後第一輪就把這件事暴露了：**上限採集第一次自己跑起來**，11 個模型各問一次，
10 個「路由什麼都沒說」，longcat 的舊記錄因為指紋仍匹配而沒重問——機制是對的。

但那 10 條記錄是 `{"fp": "", "at": 0}`，而 `isMeasuredLimits` **拒絕空指紋**，所以它們
**不會被讀回來**。程式註解寫著：「這個工作階段已經問過了，下次熱啟動丟掉，讓新的工作階段
再問一次。」

**於是每重啟一次 DSH，就要為 11 個模型各花一個請求，去問一個十次裡十次沉默的問題。**
而匿名桶是共享的，**路由的沉默不會因為行程重啟而改變**。

這條註解的出發點（「這個工作階段已經問過」）和 §五十六 改動的出發點（「每日輪次要能自己學到
上限」）**彼此矛盾**：一個想讓每次重啟都重新確認，一個想讓確認變成每天一次。改動較新的那個
才是對的——**每日輪次的目的是學到變化，不是確認沒變化**。

**改法**：沉默被記上真實時間戳，並保留 24 小時。它**永遠不能變成量測**（空指紋永遠匹配不上
任何 `contextFingerprint`，面板投影另外擋一次），所以改變的只有「下一輪要不要再花錢聽一次」。

**第七次，而這次的收穫是把兩個機制的意圖放在一起看**——前六次都是單獨看一個機制，發現它
缺了什麼；這次是兩個機制**各自都合理、合起來互相矛盾**。單獨看每一個都說得通。
