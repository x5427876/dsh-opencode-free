# dsh-opencode-free

[English](README.md) | **繁體中文**

[![CI](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml/badge.svg)](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

在 DeepSeek Harness（DSH）中使用 [OpenCode Zen](https://opencode.ai/docs/providers)
的免費模型。不需要安裝 OpenCode、不需要登入、不需要 API key，也不需要另外架伺服器。

> [!WARNING]
> 這是非官方的社群插件，與 OpenCode 和 DeepSeek 無關。插件送出 OpenCode CLI
> 的身份來使用免 key 的免費層。上游沒有第三方合約，隨時可能失效。
> 請看〈[運作原理](#運作原理)〉。
>
> 和所有 DSH 插件一樣，它以 host 的權限執行；它也會為 Zen 請求包裝整個行程的
> `fetch` 與 `node:http(s)`（見〈[它在你的行程裡修補什麼](#它在你的行程裡修補什麼)〉）。
> 安裝第三方插件前，請先讀 DSH 的
> [安全說明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。

## 功能

- 在 DSH 模型選單的 `opencode-zen-free` provider 下提供 Zen 免費模型。
  清單跟著 models.dev 走並自行更新；插件詳情頁上每個模型都有開關，可以把不
  會用到的隱藏起來。
- 詳情頁上有即時顯示的可用性檢查。只有路線明確拒絕某個模型時才會把它移出清單，
  所以被閘或被限流的那一輪不會讓你損失任何模型。見[可用性檢查](#可用性檢查)。
- 預設匿名使用，Zen API key 是可選的。
- 透過 pi-ai 原生串流：文字、推理、工具呼叫、用量與中斷。
- 工具在 DSH 內執行，Windows 的 `pwsh` 也能用。
- 上游拒絕請求時，給出明確的錯誤訊息。

## 需求

| 項目 | 版本 |
|---|---|
| DeepSeek Harness | `0.2.1-alpha.1`（必須完全相同） |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

每個插件版本只對應一個 DSH 版本。請先確認你的版本：

```sh
dsh --version
```

| 插件 | DSH |
|---|---|
| `0.3.1` | `0.2.1-alpha.1` |
| `0.3.0` | `0.2.0-rc.2` |
| `0.2.1` | `0.2.0-rc.2` |
| `0.2.0` | `0.2.0-rc.1` |
| `0.1.3` – `0.1.4` | `0.1.7-rc.2` |

四個 peer 依賴是**必要**的，不是選用的：`src/` 每一個都在頂層 import，宿主少了
任何一個都會載入失敗。不要忽略 peer dependency 警告。

## 安裝

從 npm 安裝這個固定版本：

```sh
dsh plugin --profile web add dsh-opencode-free@0.3.1
```

範例使用 `web` profile，請換成你的目標 profile。

檢查安裝結果：

```sh
dsh plugin --profile web list dsh-opencode-free --depth 0
```

套件只出現一次，就代表安裝正確。若要確認插件也進了 composed config，可以跑
`dsh --profile web --dump-config` 並找 `opencode-free`。

其他 profile 和插件不會變動。

更新或移除：

```sh
dsh plugin --profile web update dsh-opencode-free
dsh plugin --profile web remove dsh-opencode-free
```

## 使用

重啟 DSH（或等 HMR 重載），打開模型選單，選擇 **OpenCode Zen Free** 下的模型。

### 模型清單

清單不是寫死的，所以本頁不列出模型名稱。開啟模型選單即可看到目前的清單；最新的
實測結果在 [`docs/compat-reports/`](docs/compat-reports/)。

- **來源。** [models.dev](https://models.dev) 決定哪些模型免費、叫什麼名字、上下文
  多大；Zen 自己的 `/models` 端點決定其中哪些目前仍在供應。上游新發布的免費模型
  會自己出現，不必重裝插件。
- **更新頻率。** models.dev 在背景大約一天讀一次，不阻塞任何請求。Zen 的清單不花
  推理額度，所以每 30 分鐘重讀一次，下架的模型幾分鐘內就會從選單消失。
- **尚未發布的模型。** 若 Zen 正在供應某個 models.dev 尚未發布的免費模型，詳情頁會
  點名，但選單不會提供它：它的上下文長度與能力沒有任何來源查得到，而猜錯的數字會被
  拿來用。
- **離線或首次啟動。** 既沒有網路也沒有快取時，插件會退回 pi-ai 內建的模型集，詳情
  頁會說明。重新整理失敗不會讓清單變空。
- **詳情頁。** 模型依字母排序，你開著的置頂。每個模型都有開關，可以把它從選單隱藏；
  另有視覺、思考、工具三種徽標，以及**請求真正使用的兩個上限**——上下文與最大輸出。
  帶 ✔ 的徽標或數字是**在這條路線上實測**的，沒帶的是 models.dev 的宣告。當實測值取代
  宣告時，宣告會被劃掉並列在旁邊（`上下文 200,000 → 1,048,576`）——因為過期數字與
  實測數字長得一樣，而這正是過去這一面板無法告訴你它是哪一種的原因。

### 推理與能力

DSH 的推理等級會直接傳給上游；階梯逐模型取自
models.dev（Muse Spark 是 `minimal`…`xhigh`，Space Bunny 是 `low`…`max`），模型沒
發布的等級不會出現在選項裡。

工具呼叫可用，而且這是**量測**，不再是准入條件：要求模型跑一個指令時，這輪答得出
來的每個模型都真的發出工具呼叫，參數也正確——線上集合 9/9（2026-10-07）；答不出來
的那幾個，帶工具與不帶工具的報文逐字元組相同，屬於上游狀況，不是能力缺失。免費層
仍然只在請求帶著 `read` 與 `bash` 時才放行，那是另一件事，不是這句話的意思。

`off` 是唯一的例外：它是**量出來的，不是假設的**。檢查會先問模型不推理、再問它自己
最低的檔位，把推理 token 數與該模型自己的基線比較，只有真的有降幅才提供 `off`——
能到精確零的就是 `none`，否則是實測有幫助的最低檔。路線從不回報推理量的模型**完全
不會有 `off` 這一列**，而不是給一列什麼都不做的選項。沒有選的話，Muse Spark 使用
`xhigh`。

視覺同樣有實測：截圖只附給宣告支援圖片輸入的模型，而要求這些模型說出「一張上下兩
色的圖，上半部是什麼顏色」時，每個答得出來的模型都答對了（5/5，2026-10-07）。

選單裡的上下文與輸出預算是實測的，不是抄來的——而兩者是**不同種類的數字**，
所以分開標示。

**上下文**是真正的上限，取自端點自己的拒絕報文：Mimo V2.6 Flash 宣告 200,000，
端點說它的最大值是 1,048,576。這是能力，也是對話什麼時候被壓縮的依據。

**輸出預算**跟隨 models.dev，只有一個例外。路線**會執行** `max_tokens`——用一個想寫
上千字的提示去要求 8，答得出來的模型全部精準停在 8 且 `finish_reason: "length"`——
所以宣告太小確實會在宣告處截斷真實回答，沒有任何地方會說。但那只證明欄位會被執行，
**不證明模型寫得出來**：2026-10-07 每條路線都受理到 1,040,384 的預算，而沒有任何模型
被看到寫過那種量。所以規則是：**只有「被說出口的上限」或「被看過的生成」才能移動這個數字**。
小米官方頁面寫 MiMo-V2.6-Flash 的最大輸出是 128K，而 models.dev 寫 32,000；longcat 的
路由則直接在拒絕正文裡說出自己的上限（`/max_tokens: 995834 is not less or equal to
262144`），models.dev 寫的是它的一半。這兩種「說法」都不花錢——拒絕會回一個數字——
而它們現在都成了預算的上限。被看過的生成同樣算：mimo 被要求 131,072 時寫出
79,722 就自己收尾，big-pickle 寫出 48,000。其他模型的預算就是 models.dev 寫的數字，
只有在不是這樣時那一行才會出現箭頭。

值得知道為什麼有些模型沒有數字：**模型自己決定何時停**，同一個請求值一次產出 892
token、下一次產出 79,722。而且對其中幾個而言瓶頸根本不是預算——實測速率在 34 到 365
tok/s 之間，所以十分鐘逾時會在約 28,000 到 295,000 token 之間結束一次回答；對宣告
128,000 或 262,144 的模型來說，是時鐘先到。

這道題的另一半不花錢，而且是自動收集的：**路由拒絕請求時，報文裡的數字就是它自己的
上限**——輸出是「is not less or equal to 262144」，上下文是「maximum context length
of 262139」——檢查會把這些數字讀出來、按模型記住。拒絕不產生任何輸出 token，所以
這是唯一免費的上限量測，也正是它抓出過期宣告：big-pickle 的窗口之所以被找出來高了四倍，
就是靠它。答應而不拒絕的路由等於什麼都沒說，這件事會被記成「未說」，而不是被猜成一個數。

還有一道沒人看得見的上限：時間。Mimo V2.6 Flash 約 150 token/秒，所以單次回答會在
10 分鐘請求逾時時結束，約 90,000 token，與預算寫多少無關。這件事沒有任何機制會報告，
因為在上限處停下的回答，看起來和寫完的一模一樣。過去更糟：只有 3 分鐘——那比宣告的
預算還短，所以在逾時修正之前，調高預算根本沒有用。

### 可用性檢查

詳情頁會對你開著的模型跑一輪檢查，並即時顯示進度：計數、答出來的模型各自的延遲、
正在問的那個轉圈圈。結果會留在畫面上，重啟 DSH 也不會消失，直到下一輪取代它。

- **何時。** 每個本地日一輪，在讀取模型清單時觸發；詳情頁的「立即探測」按鈕可隨時
  額外要求一輪。你不碰模型選單就不會付出任何額度。五分鐘內第二次點擊會被拒絕，並
  告訴你還要等多久——而不是開一輪讓你盯著轉圈圈。
- **怎麼做。** 先讀 Zen 的清單（一個 `GET`，不花推理額度）；Zen 不再列出的模型不會
  送出任何完成度請求就被移出。接著逐個模型送出請求——逐個送是因為匿名呼叫共用同一個
  額度桶。
  - **每天那一輪**：Zen 仍供應的每個模型各送**一個**極短請求，**包含你關掉的那些**
    ——隱藏起來的模型正是沒有人會去查的那一批。失敗的模型也只花一次請求。
  - **「立即探測」**：只問你開著的模型，而且會一直問到量測完成（上限九次；其中一部分
    用在**從來沒問過的能力題**：給模型一張圖看它答不答對顏色、給它真實工具看它會不會
    呼叫）。每個軸**每個模型只問一次**並保留答案，所以常用模型第一輪之後就不再花額度；
    而問不出結果的輪次什麼都不寫——徽標維持無記號，而不是宣稱模型不能做。
    所以一次點擊是**做完**而不是開始。報告會告訴你這次花了多少次、還有幾個模型欠著
    樣本。
- **什麼會讓模型被移除。** 只有明確的答案：Zen 不再列出它，或路線回答不提供它
  （`Model is unavailable.`、`Model <id> is not supported`、
  `Model <id> has been deprecated`、`404`、`410`）。Zen 不公布哪個端點服務哪個模型，
  所以在判沒之前會把這家 provider 實作的兩條通道各問一次；而**答不出話的通道不能
  推翻點名的那一個**——否則走錯通道時那句 `not supported for format` 會把所有模型都判死。
  models.dev 的 `deprecated` 標記不決定這件事：這家 provider 的這個標記可能是免費層
  結束，也可能只是那條紀錄過時。
- **什麼不會。** 匿名層拒絕、額度用完、key 被拒、網路中斷、上游過載、整個端點掛掉。
  這些輪次對任何模型都沒學到東西，所以那些行是灰色「未測到」而不是紅色，而且
  **原因直接寫在那一行上**（`未測到 · 額度用盡`），滑鼠停上去還有 HTTP 狀態碼和該怎麼辦。
  紅色那行是對模型的判斷，一定會講明原因。
- **移除是最終的。** 路線拒絕過的模型不會再被問，因為重問一個已有答案的問題只是白花
  額度。補 Zen key 也不會讓它回來：**key 改變的是你的額度，不是模型清單**，路線
  拒絕的模型帶 key 一樣被拒。Zen 只是不再列出的模型則不同：Zen 重新列出它時，它就
  回來了。

如果想把整份目錄重新判定一次——例如 Zen 修好了某條通道——刪掉插件的快取檔並重啟
DSH 一次：

```
$DSH_HOME/dsh-opencode-free/catalog.json     # 未設 DSH_HOME 時為 ~/.dsh/…
```

`$DSH_HOME` 有設定時優先，而 DSH Desktop 的 profile 通常就是這種情況；在那種機器上
刪 `%USERPROFILE%\.dsh\…` 那條路徑什麼也不會改變。下次啟動會重新讀 models.dev，把
每個模型都當成未探測過，全部重探。這是唯一的回頭路。

這些規則背後的理由見
[`docs/adr/0002-catalogue-source-of-truth.md`](docs/adr/0002-catalogue-source-of-truth.md)。

## 設定

### Zen API key（可選）

沒有 key 時，插件送出 `Authorization: Bearer public`，不送任何個人憑證。
匿名層拒絕你時，插件只會回報錯誤，不會要求你輸入 key，也不會自動改用付費模型。

要使用 key，擇一即可：

1. 在插件的 `config` 加上 `apiKey`，重載後生效。
2. 設定環境變數 `OPENCODE_API_KEY`。

優先順序：`apiKey` 設定 → `OPENCODE_API_KEY` → 匿名 `public`。

DSH Desktop 沒有 shell 環境，請用第 1 種方式。在該 profile 的 `cordis.patch.yml`
覆寫插件設定：

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKey: <你的 Zen key>
```

開始對話前先驗證 key。這個指令會送出一個 16 token 的請求：

```sh
# key 進環境變數，不進命令列：
read -rs -p "Zen key: " OPENCODE_API_KEY; echo
OPENCODE_API_KEY="$OPENCODE_API_KEY" ./scripts/reverify.sh
unset OPENCODE_API_KEY
```

看 ③ 號燈：綠燈代表 key 有效；紅燈代表 key 無效或上游有問題。

## 運作原理

插件透過 DSH 的 `PiAiAdapter` 註冊 `opencode-zen-free` provider，用 pi-ai
自己的傳輸層直接連到 `https://opencode.ai/zen/v1`：Muse Spark 用 Responses，
其他模型用 Chat Completions。做法參考 Pi 的
[`pi-opencode-direct`](https://github.com/Aymendje/pi-opencode-direct)。

匿名層只接受看起來像 OpenCode CLI 的請求：

- OpenCode 的 `User-Agent` 和 `x-opencode-*` header，加上格式正確的 `ses_` session ID；
- `stream: true`；
- 名稱剛好是 `read` 和 `bash` 的工具。

DSH 在 Windows 上提供的是 `pwsh`，不是 `bash`。匿名請求時，插件把 `pwsh`
送成 `bash`，回傳的呼叫再改回 `pwsh`。不帶工具的請求（標題、壓縮）會補上
不可用的佔位工具。帶 API key 的請求永遠不改寫。

可用性探測會在位元組離開前的最後一道邊界上，重新保證 `read` 和 `bash` 這兩個工具名
還在。那條邊界以上的每一層都可能把它們弄丟，而沒有它們的請求在每個模型上都會被拒——
所以探測自己負責保證自己的准入，而不是假設上面那幾層有好好傳下來。

完整的調查過程、重播結果和診斷原則，請看
[`docs/reverse-engineering.md`](docs/reverse-engineering.md)。

### 它在你的行程裡修補什麼

`apply()` 會包裝三個行程層級的入口，讓不是插件自己發出的請求也帶上 OpenCode
身份：

- `globalThis.fetch`
- `node:http` 與 `node:https` 的 `request` 和 `get`

範圍嚴格限定在 Zen 的 base URL `https://opencode.ai/zen/v1`。其他主機與路徑原封不動，
參數逐位元組保留。重複載入不會重複包裝（原始函式存放在 `globalThis` 的
`__dshOpenCodeFree*` 下），插件卸載時會還原。同一個行程裡若有其他擴充也呼叫這個
base URL，它們的請求同樣會帶上這組身份 header。

## 疑難排解

**卡片上一片灰色「未測到」，但那個模型聊天明明正常**
探測被閘擋下來了，你自己的請求卻是通的。這種拒絕會由一行橫幅說明是哪一種上游閘門
條件回答的，而且它不是對該模型的判定：清單沒有動過任何東西。按「立即探測」重問一次
就好。

**`403 FreeTierError ... only be used from within OpenCode`**
執行 `./scripts/reverify.sh`。② 號燈送出的請求符合所有已知的閘門條件。
如果 ② 號燈是黃燈，代表上游的閘門條件變了，不是你的設定有問題。

**HTTP 200，但沒有回覆**
`200` 代表請求已經通過閘門。之後沒有內容，就是該模型在上游卡住。
請換一個模型，或直接測試：

```sh
pnpm run build
node scripts/test-live.mjs nemotron-3.5-lightning-free
```

**除錯記錄**
啟動 DSH 前設定 `DSH_OPENCODE_FREE_DEBUG=1`。插件會把送出的身份、請求形狀、每一條
Zen 請求的狀態碼印到 stderr；探測被拒時，還會附上上游報文的前 300 個字元。
它不會印出對話內容。身份那一行會印出 `Authorization` header 的前 14 個字元，所以
設定了 key 之後，這份紀錄不要貼到公開的地方。

## 開發

貢獻與 review 前，請閱讀[工程標準](docs/standards.md)與[已知差距](docs/standards-gap.md)。

請修改 `src/*.ts`。不要改 `lib/`，它由 `tsc` 產生。

```sh
pnpm install
pnpm run typecheck  # 嚴格型別檢查
pnpm run build      # 產生 lib/
pnpm run test       # 先 build，再跑離線測試
pnpm run check      # typecheck、測試、打包
```

單元測試使用記憶體內的 fixture，不連網路，也不消耗免費額度。
下面這些腳本會送出真實請求：

| 腳本 | 檢查內容 |
|---|---|
| `scripts/reverify.sh` | ① 模型目錄可連線、② 匿名閘門、③ API key（只在設定 `OPENCODE_API_KEY` 時執行） |
| `node scripts/test-live.mjs [model-id ...]` | 對每個免費模型（或你列出的模型）送一個極短的匿名請求。它不宣告任何工具，所以 `replied:false` 通常是閘門不給，不是模型沒了——它不是可用性檢查。請先執行 `pnpm run build`。 |
| `pnpm compat --dsh <版本> [--tools] [--keep] [--out <目錄>]` | 相容性驗證：在暫存的 `DSH_HOME` 安裝該版 DSH 與本 repo 打包的插件，經真實的 headless DSH 逐一驗證 Zen 全部免費模型。退出碼 `0` 全部驗過、`1` 插件端錯誤、`2` 沒驗完（額度受限）、`3` 前置檢查不通過。支援新版 DSH 發版前必跑；不進 CI。見 [`docs/compat-run.md`](docs/compat-run.md)。 |

安裝或驗證此插件的 Agent，請看 [`AGENTS.md`](AGENTS.md)。

## 模型實際看到的內容（Model Experience）

以下改動只作用在送往 Zen 的匿名請求。帶 Zen key 的請求原樣送到模型。

### Windows 上的 shell 工具名稱

#### 模型看到什麼

請求提供 DSH 的 `pwsh` 工具、但沒有 `bash` 工具時，模型在工具清單與對話中先前的
每一次工具呼叫和結果裡，看到的都是名為 `bash` 的同一個工具。模型回傳的 `bash`
呼叫在 DSH 端還原為 `pwsh`。

#### Token 影響

只有名稱不同，描述與參數不變。

#### KV Cache 影響

前綴穩定：每次匿名請求都對整段歷史套用同樣的改名，連續請求共用同一前綴。同一個
session 在帶 key 與匿名之間切換時，工具名稱改變，快取無法重用。

### 准入用的佔位工具

#### 模型看到什麼

請求缺少名為 `read` 或 `bash` 的工具時（標題、compaction，或沒有這兩個工具的
profile），每個缺少的工具都會補上一個無參數的定義，描述為：

```markdown
Unavailable in this request. Do not call.
```

#### Token 影響

有條件：受影響的請求最多多兩個簡短的工具定義。

#### KV Cache 影響

在工具組合相同時前綴穩定；佔位工具每次都加在相同位置。

### Compaction 提示

#### 模型看到什麼

請求沒有工具、只有一則使用者訊息，且系統提示不超過 2,000 字元並包含
`context summarization`（host 的 compaction 提示）時，系統提示會換成 OpenCode 的版本：

```markdown
You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary matching the format specified so another coding agent can continue the work.
Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.
Do not continue the conversation. Do not respond to any questions in the conversation. Only output the structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation.
```

裝著對話內容的那則使用者訊息不會被改動。

#### Token 影響

取代：系統提示的 token 變成上面這段文字的 token。

#### KV Cache 影響

獨立：compaction 是一個單獨的模型請求，不和對話共用前綴。

## 已知限制

- **每個版本只支援一個 DSH 版本。** peer 釘選是精確版本；其他 DSH 版本會略過
  這個插件（見〈[需求](#需求)〉）。
- **非官方的存取方式。** 免 key 層沒有第三方合約，上游一改就可能在沒有通知的情況下
  拒絕所有匿名請求。
- **匿名額度共用。** 同一個出口 IP 後面的所有人共用免費額度，額度用完時看起來
  可能像模型壞了。掛 Zen key 可避開。
- **需要 `webServer`。** 插件為詳情頁的路由注入 DSH 的 `webServer`，所以在沒有
  `webServer` 的 profile（例如內建的 `headless`）裡不會載入。
- **沒有持久登入。** key 每次請求都從插件設定或 `OPENCODE_API_KEY` 讀取，沒有登入流程。

## 授權

[MIT](LICENSE)。這是獨立擴充，與 OpenCode 和 DeepSeek 官方無關。
