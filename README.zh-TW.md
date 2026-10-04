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
  另有能力徽標：視覺（模型宣告支援圖片輸入）與思考（標出最高的已發布推理等級；沒
  發布等級的模型沒有此徽標）。

### 推理與能力

所有模型都支援推理和工具呼叫。DSH 的推理等級會直接傳給上游；可選的等級逐模型取自
models.dev（Muse Spark 是 `minimal`…`xhigh`，Space Bunny 是 `low`…`max`），模型沒
發布的等級不會出現在選項裡。`off` 保留為顯式選項，不送推理參數，跟 OpenCode 的
"Default" 一樣。沒有選的話，Muse Spark 使用 `xhigh`。

只有宣告支援圖片輸入的模型才會附上截圖。選單裡的上下文大小與最大輸出是該模型自己的。

### 可用性檢查

詳情頁會對你開著的模型跑一輪檢查，並即時顯示進度：計數、答出來的模型各自的延遲、
正在問的那個轉圈圈。結果會留在畫面上，重啟 DSH 也不會消失，直到下一輪取代它。

- **何時。** 每個本地日一輪，在讀取模型清單時觸發；詳情頁的「立即探測」按鈕可隨時
  額外要求一輪。你不碰模型選單就不會付出任何額度。
- **怎麼做。** 先讀 Zen 的清單（一個 `GET`，不花推理額度）；Zen 不再列出的模型不會
  送出任何完成度請求就被移出。其餘每個模型再逐個送一個極短請求——逐個送是因為匿名
  呼叫共用同一個額度桶。答出來過的模型下一輪會再問，延遲才不會變舊。你關掉的模型
  不會被問。
- **什麼會讓模型被移除。** 只有明確的答案：Zen 不再列出它，或路線回答不提供它
  （`Model is unavailable.`、`Model <id> is not supported`、`404`、`410`）。Zen 不公布
  哪個端點服務哪個模型，所以在被判沒之前，會把這家 provider 實作的兩條通道各問一次。
  models.dev 的 `deprecated` 標記不決定這件事：這家 provider 的這個標記可能是免費層
  結束，也可能只是那條紀錄過時。
- **什麼不會。** 匿名層拒絕、額度用完、key 被拒、網路中斷、整個端點掛掉。這些輪次
  對任何模型都沒學到東西，所以那些行是灰色「未測到」而不是紅色，並有一行橫幅說明
  是哪一種條件回答的。紅色那行會講明原因，滑鼠停上去還有 HTTP 狀態碼和該怎麼辦。
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
