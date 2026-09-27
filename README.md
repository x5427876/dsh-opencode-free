# DSH OpenCode Free

在 DeepSeek Harness 中直接使用 OpenCode Zen 的免費模型，不需要安裝
OpenCode、不需要登入、不需要 API Key、不需要額外伺服器。

思路與 Pi 的 [`pi-opencode-direct`](https://github.com/Aymendje/pi-opencode-direct)
相同：走 pi-ai 原生傳輸（Muse Spark 用 Responses，其餘免費模型用
Chat Completions），用串流處理文字、思考、工具呼叫、用量、中斷與
工具結果重播，工具在 DSH 內執行。

## 準備 DSH

本插件 `0.1.4` 僅適配 DeepSeek Harness `0.1.7-rc.2`。
安裝前請先確認版本：

```sh
dsh --version
```

不要忽略 peer dependency 警告。

## 安裝

```sh
dsh plugin --profile web add dsh-opencode-free@0.1.4
dsh plugin --profile web list dsh-opencode-free --depth 0
dsh --profile web --dump-config
```

成功條件：套件只出現一次，composed config 出現 `opencode-free`，
不相關的 profile 與插件沒有變動，不需要重啟正在跑的 DSH（除非要立即使用）。

更新與移除：

```sh
dsh plugin --profile web update dsh-opencode-free
dsh plugin --profile web remove dsh-opencode-free
```

## 使用

重啟 DSH（或 HMR 重載）後，在模型選單選擇 `opencode-zen-free`
provider 下的模型即可。Muse Spark 支援原生圖片、推理與工具呼叫；
DSH 的思考強度選擇會透傳，沒選時 Muse Spark 預設 `xhigh`。

上游匿名層要求請求帶有名為 `read` 與 `bash` 的工具。DSH 在 Windows
只提供 `pwsh`，所以插件在匿名請求中把 `pwsh` 送成 `bash`，回傳時再改回
`pwsh`；不帶工具的請求（標題、壓縮）會補上不可用的空工具。帶 key 時不改寫。

若仍出現 `403 FreeTierError`，請執行 `scripts/reverify.sh`：②號燈黃燈表示
上游閘門條件又變了，不是設定問題。

> 定位：本插件仿冒 CLI 身份使用 keyless 層，上游無第三方合約，
> 隨時可能再被閘。實測紀錄見 `docs/reverse-engineering.md`。

## 模型目錄新鮮度

模型清單是打包時的基線，不在背景自動刷新（避免副作用與額度成本）。
上游下架的模型會回模型不可用而非通用錯誤；新鮮度以
`scripts/reverify.sh` ①號燈為信號，紅燈先查網路。

## Zen key（可選）

與原專案相同，Zen key 不是必要設定。不設 key 時送 `Bearer public`，
不送個人憑證。匿名被拒時會回報錯誤，不會強制要求 key 或自動切換付費模型。
若你有 Zen key，可選擇設定後重測：

1. 在該插件行的 `config` 加 `apiKey`（重載即生效，不需重啟），或
2. 設環境變數 `OPENCODE_API_KEY`。

優先順序：插件 `apiKey` config → `OPENCODE_API_KEY` → 匿名 `public`。
DSH Desktop（無 shell 環境）走第 1 路：在該 profile 的 `cordis.patch.yml`
覆寫本插件行：

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKey: <你的 Zen key>
```

改 key 存檔即 HMR 重載生效。設完先驗 key（一次 16 token 的極小請求，
不是正式對話；key 無法離線驗，必須打一次上游）：

```sh
OPENCODE_API_KEY=<你的 Zen key> ./scripts/reverify.sh  # 只看 ③號燈
```

③號綠燈＝key 有效；紅燈＝key 無效或上游異常，先別開聊。
匿名壓縮會額外送 OpenCode 原文一致的 compaction system prompt（Zen
匿名免費層會閘 developer 內容）；有 key 的 request 永遠不改寫。

除錯可用 `DSH_OPENCODE_FREE_DEBUG=1` 印出 outbound 身份（只印形狀，
不印內容）。

## 開發

改 `src/*.ts`，不要直接改 `lib/`（發佈產物，由 `tsc` 產生）：

```sh
pnpm install
pnpm run typecheck  # tsc 嚴格型別檢查
pnpm run build      # tsc（host：lib/*.js + lib/types/**）
pnpm run test       # 會先自動 build，以 tsx 跑測試（無網路）
pnpm run check      # typecheck → build → tests → pack
```

測試用純記憶體 fixture，不打網路、不耗免費額度。

## 授權

MIT。這是獨立擴充，與 OpenCode、DeepSeek 官方無關。
