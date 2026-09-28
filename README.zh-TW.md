# dsh-opencode-free

[English](README.md) | **繁體中文**

[![npm](https://img.shields.io/npm/v/dsh-opencode-free)](https://www.npmjs.com/package/dsh-opencode-free)
[![CI](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml/badge.svg)](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

在 DeepSeek Harness（DSH）中使用 [OpenCode Zen](https://opencode.ai/docs/providers)
的免費模型。不需要安裝 OpenCode、不需要登入、不需要 API key，也不需要另外架伺服器。

> [!WARNING]
> 這是非官方的社群插件，與 OpenCode 和 DeepSeek 無關。插件送出 OpenCode CLI
> 的身份來使用免 key 的免費層。上游沒有第三方合約，隨時可能失效。
> 請看〈[運作原理](#運作原理)〉。

## 功能

- 在 DSH 模型選單的 `opencode-zen-free` provider 下提供 7 個 Zen 免費模型。
- 預設匿名使用，Zen API key 是可選的。
- 透過 pi-ai 原生串流：文字、推理、工具呼叫、用量與中斷。
- 工具在 DSH 內執行，Windows 的 `pwsh` 也能用。
- 上游拒絕請求時，給出明確的錯誤訊息。

## 需求

| 項目 | 版本 |
|---|---|
| DeepSeek Harness | `0.2.0-rc.1`（必須完全相同） |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

每個插件版本只對應一個 DSH 版本。請先確認你的版本：

```sh
dsh --version
```

| 插件 | DSH |
|---|---|
| `0.2.x` | `0.2.0-rc.1` |
| `0.1.3` – `0.1.4` | `0.1.7-rc.2` |

不要忽略 peer dependency 警告。

## 安裝

範例使用 `web` profile，請換成你的目標 profile。

```sh
dsh plugin --profile web add dsh-opencode-free@0.2.0
```

檢查安裝結果：

```sh
dsh plugin --profile web list dsh-opencode-free --depth 0
dsh --profile web --dump-config
```

套件只出現一次，而且 composed config 裡出現 `opencode-free`，就代表安裝正確。
其他 profile 和插件不會變動。

更新或移除：

```sh
dsh plugin --profile web update dsh-opencode-free
dsh plugin --profile web remove dsh-opencode-free
```

## 使用

重啟 DSH（或等 HMR 重載），打開模型選單，選擇 **OpenCode Zen Free** 下的模型。

| 模型 | ID | 輸入 | 上下文 |
|---|---|---|---|
| Muse Spark 1.3 Free | `muse-spark-1.3-contributor-free` | 文字、圖片 | 1M |
| Muse Spark 1.2 Free | `muse-spark-1.2-contributor-free` | 文字、圖片 | 1M |
| MiMo V2.5 Free | `mimo-v2.5-free` | 文字、圖片 | 200K |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | 文字 | 1M |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | 文字 | 262K |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | 文字 | 262K |
| Big Pickle | `big-pickle` | 文字 | 200K |

所有模型都支援推理和工具呼叫。DSH 的推理等級會直接傳給上游；沒有選的話，
Muse Spark 使用 `xhigh`。

模型清單是隨套件發布的基線，插件不會在背景刷新。上游下架某個模型時，
你會看到「模型不可用」的錯誤。

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
OPENCODE_API_KEY=<你的 Zen key> ./scripts/reverify.sh
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

完整的調查過程、重播結果和踩雷紀錄，請看
[`docs/reverse-engineering.md`](docs/reverse-engineering.md)。

## 疑難排解

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
啟動 DSH 前設定 `DSH_OPENCODE_FREE_DEBUG=1`。插件會把送出的身份和請求形狀
印到 stderr，不會印出內容或 key。

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
| `node scripts/test-live.mjs [model-id ...]` | 所有免費模型（或你列出的模型）都能匿名回覆。請先執行 `pnpm run build`。 |

安裝或驗證此插件的 Agent，請看 [`AGENTS.md`](AGENTS.md)。

## 授權

[MIT](LICENSE)。這是獨立擴充，與 OpenCode 和 DeepSeek 官方無關。
