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

## 功能

- 在 DSH 模型選單的 `opencode-zen-free` provider 下提供 Zen 免費模型。
  清單跟著 models.dev 走並自行更新；插件詳情頁上每個模型都有開關，可以把不
  會用到的隱藏起來。
- 詳情頁上有一輪可以看著它跑的可用性檢查：只問你開著的那些模型，答一個報一個，
  而只有在這條路線明確說不提供某個模型時才會把它移出清單——所以撞上壞窗口的
  代價是一行灰字，不是一個模型。
- 預設匿名使用，Zen API key 是可選的。
- 透過 pi-ai 原生串流：文字、推理、工具呼叫、用量與中斷。
- 工具在 DSH 內執行，Windows 的 `pwsh` 也能用。
- 上游拒絕請求時，給出明確的錯誤訊息。

## 需求

| 項目 | 版本 |
|---|---|
| DeepSeek Harness | `0.2.0-rc.2`（必須完全相同） |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

每個插件版本只對應一個 DSH 版本。請先確認你的版本：

```sh
dsh --version
```

| 插件 | DSH |
|---|---|
| `0.3.0` | `0.2.0-rc.2` |
| `0.2.1` | `0.2.0-rc.2` |
| `0.2.0` | `0.2.0-rc.1` |
| `0.1.3` – `0.1.4` | `0.1.7-rc.2` |

四個 peer 依賴是**必要**的，不是選用的：`src/` 每一個都在頂層 import，宿主少了
任何一個都會載入失敗。不要忽略 peer dependency 警告。

## 安裝

從 npm 安裝這個固定版本：

```sh
dsh plugin --profile web add dsh-opencode-free@0.3.0
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

模型清單跟著 [models.dev](https://models.dev) 走：Zen 自己的 `/models` 端點負責
「有哪些模型」，models.dev 負責「哪些是免費的、叫什麼名字、上下文多大」。插件在背景
讀取（最多一天一次，且不阻塞任何請求）並快取結果，所以上游新發布的免費模型會自己
出現；Zen 加了模型不必重裝插件。

目前被列為免費、且上游未標記停止維護的模型：

| 模型 | ID | 輸入 | 上下文 |
|---|---|---|---|
| Muse Spark 1.3 Free | `muse-spark-1.3-contributor-free` | 文字、圖片、影片、音訊 | 1M |
| Space Bunny Free | `space-bunny-free` | 文字、圖片、影片 | 1M |
| LongCat 2.5 Preview Free | `longcat-2.5-preview-free` | 文字、圖片 | 1M |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` | 文字、圖片、音訊、影片 | 200K |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | 文字 | 1M |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | 文字 | 256K |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | 文字 | 256K |
| Big Pickle | `big-pickle` | 文字 | 200K |

所有模型都支援推理和工具呼叫。DSH 的推理等級會直接傳給上游；可選的等級逐模型取自
models.dev——Muse Spark 是 `minimal`…`xhigh`，Space Bunny 是 `low`…`max`，模型沒
發布的等級不會出現在選項裡。`off` 保留為顯式選項；選它或不選等級都不送推理參數，
跟 OpenCode 的 "Default" 完全一樣（請求路徑會把 pi-ai 原本要送的佔位 effort 拿掉）。
沒有選的話，Muse Spark 使用 `xhigh`。

每個模型的識圖能力、上下文大小與最大輸出同樣讀自 models.dev：只有在模型宣告支援
圖片時才會附上截圖，選擇器裡的上下文數字也是該模型自己的，而不是抄另一個模型的。

**這兩個來源各自按自己的時鐘讀取**，因為它們回答的是不同問題、代价也不同。哪些模型
*免費*由 models.dev 決定，它的目錄是一份 5.2MB 的完整檔案，所以大約一天讀一次——除非
端點已確認它認得條件請求，那之後重驗只要幾百位元組而不是重新下載。哪些模型 Zen *目前
仍在供應*由一個小 GET 決定，而它完全不花推理額度，所以每 30 分鐘重問一次。這就是下
架的模型能在幾分鐘內、而不是一天之內從選單消失的原因。

若 Zen 正在供應某個 models.dev 尚未發布的免費模型，插件詳情頁會說明並點名。它不會被
加進選單：該模型的上下文長度與能力沒有任何來源查得到，而猜錯的數字會被拿來用，不只
是顯示而已。

**這張表是快照，不是合約。** 它的用途是讓你認出自己在選什麼；真正的清單是插件最後
一次讀到的內容。到插件詳情頁就能看到並調整：那裡的清單依模型 id 字母排序，你開著
的模型置頂；每個模型都有開關，可以把它從模型選單隱藏；每一行還帶著能力徽標——宣告
支援圖片輸入的有視覺徽標，有發布思考等級的有思考徽標（標出最高的那個等級）。沒發布
等級的模型不會有思考徽標，不會用猜的補一個。

探測這一輪只問你開著的那些模型，並且即時回報，跑完也留著。進行中時，進度藥丸數著
已完成／總數，每一行顯示自己的狀態——答出來的綠色加毫秒數、正在問的那個轉圈圈、還在
排隊的灰色；而這一輪根本不會去問的那一行（你關掉的模型）完全沒有探測徽標，因為寫
「等待中」等於對一輪永遠不會走到它的探測食言。能力徽標全程都在，不必等你回頭才找
得到那一行是誰。

紅色那行絕不只寫「失敗」：它會講明原因（已下架、Zen 未提供、探測超時、連接失敗、
匿名層被拒、額度用盡、key 無效），滑鼠停上去還有 HTTP 狀態碼和該怎麼辦。但被閘、
額度用盡、key 無效這三種是「呼叫端」的問題，那一輪其實什麼都沒測到——所以那些行是
灰色「未測到」，另有一行橫幅說明是哪一種上游閘門條件回答的、那一輪是幾點跑的，且
明說這不是該模型的結論。一個在 DSH 裡好好的模型，不該因為撞上被閘的窗口就戴著紅色
徽標。該輪結束後藥丸變成戰績留著，重啟 DSH 也留著，不會一閃就沒。被那一輪下架的
模型會在「本輪下架」一行點名，和只是複核確認早已下架的那批分開——自己消失的行，
沒辦法自己解釋。

（原因和建議的字句由卡片自己翻，探測層只送代碼和狀態碼：英文介面不會看到中文診斷。）

決定你拿到什麼的規則有兩條：

- 模型會一直留著，直到它**不再回應**。插件對每個開著顯示的模型送一個極短請求，
  回應的留下；第一條通道拒絕時，才會再花一次請求去問第二條通道。
  models.dev 的 `deprecated` 標記只決定模型**是否在目錄內**，不決定你看不看得到：
  這家 provider 的這個標記有歧義——可能是免費層結束，也可能只是那條紀錄過時——
  沒有任何靜態欄位能分辨這兩種情況。
- Zen 已經不提供的模型同樣不會出現在選單。

沒有被提供的模型，就是**不在清單裡**。不存在一份長期持有的第二份名單去列舉被移除的
東西，所以沒有任何東西會跟選單不一致或過期。

當路線回答「我不提供這個模型」時，該模型才算沒了——`Model is unavailable.`、
`Model <id> is not supported`、`404`、`410`。Zen 不公布哪個端點服務哪個模型，所以通道
猜錯時，回來的是同一句「不支援」：因此在被判沒之前，插件會把這家 provider 實作的兩
條通道各問一次，`dead` 判定也只有在掃完之後才算最終——掃描存在之前留下的判定會被重
問一次，因為那些才可能是路由失誤，而不是模型真的沒了。判定既然是最終的，這次掃描就
是「通道猜錯」與「一個能用的模型永遠不回來」之間的差別。至於路由真的確認不提供的
模型，那是貨真價實的答案：清單本來就該收斂，而它只在 Zen 自己的目錄或掃描過的輪次
這兩處收斂。

**判定為 dead 就是最終的。** 路線既然已經拒絕過，插件就不會再問第二次——重問一個已經
有答案的問題只是白花額度，而在這家 provider 上這正是每天 34 次與 10 次的差別。

補 Zen key 不會讓被移除的模型回來，因為 **key 改變的是你的額度，不是模型清單**。
有沒有 key，服務的模型是同一份；key 只是讓你可以多送一些。路線拒絕的模型，帶 key 一
樣拒絕。

如果你還是想把整份目錄重新判定一次——例如 Zen 把某個模型加回來了，或修好了某條通
道——刪掉插件的快取檔並重啟 DSH 一次：

```
$DSH_HOME/dsh-opencode-free/catalog.json     # 未設 DSH_HOME 時為 ~/.dsh/…
```

`$DSH_HOME` 有設定時優先，而 DSH Desktop 的 profile 通常就是這種情況——在那種機器上
刪 `%USERPROFILE%\.dsh\…` 那條路徑會刪不到東西，什麼也不會改變。

下次啟動會重新讀 models.dev，把每個模型都當成未探測過，全部重探。這是唯一的回頭路，
所以在你依賴那個更短的清單之前，值得先知道。

### 這項可用性檢查要你付出什麼

每天一次，插件對每個還需要答案的模型問 Zen 一個極短的問題，然後等答案。這是真的成本，
值得講清楚：

- **每個本地日一輪，逐個送出。** 逐個送是刻意的——匿名呼叫共用同一個額度桶，同時
  發出會更快花完，也會壓到上游。這一輪走的是你開著顯示、又還沒被判定的模型，所以
  關掉一個模型、或一個判定收斂，都是讓它變小的方式。答出來過的模型下一輪還是會再問，
  卡片上的延遲才不會變舊。Zen key 會提高你的額度，實務上讓這一輪更便宜，但它不會改變
  這一輪裡有哪些模型。
- **先讀清單，那一段不花錢。** 每輪開頭先打一次 `GET /zen/v1/models`。Zen 不再列出
  的模型**不會送出任何完成度請求**就被移出清單——這是這一輪便宜、而不是變成 N 次
  請求的原因。Zen 把模型放回去時，下一輪它就回來了，不需要手動救。
- **不用就不付。** 沒有獨立開關：這輪在讀取模型清單時觸發，詳情頁的「立即探測」
  按鈕則是隨時額外要求一輪、略過每日限制。你不碰模型選單就不會付。
- **被閘或被限流時什麼都不會變。** 匿名層拒絕、額度用完、key 被拒、網路中斷、或
  整個端點掛掉時，插件對那些模型完全不下結論：它們的顯示逐字不動，卡片會說明本輪
  結論不可信。唯一會讓模型消失的，是清單不再列它，或該路線明確表示不提供那個模型。
- **要不要隱藏某個模型，仍然由你決定。** 卡片上的開關一個動作就同時把它從模型選單
  藏起來、並讓下一輪不再問它。

離線或首次啟動：既沒有網路也沒有快取時，插件會退回 pi-ai 內建的模型集，模型選單仍然
可用，卡片會說明目前顯示的是內建兜底目錄。重新整理失敗不會讓清單變空。

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

完整的調查過程、重播結果和踩雷紀錄，請看
[`docs/reverse-engineering.md`](docs/reverse-engineering.md)。

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

安裝或驗證此插件的 Agent，請看 [`AGENTS.md`](AGENTS.md)。

## 授權

[MIT](LICENSE)。這是獨立擴充，與 OpenCode 和 DeepSeek 官方無關。
