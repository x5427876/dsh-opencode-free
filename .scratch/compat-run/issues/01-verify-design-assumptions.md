Status: resolved
Labels: ready-for-agent
Blocked by: None (can start immediately)

# 01: 在真實 DSH 上驗證三個設計假設

Spec: `../spec.md`

## What to build

相容性驗證（compat run）的設計建立在三個尚未實機證實的假設上。在動真實依賴之前，先在真實 DSH 上逐一確認，把結論寫進本票的 `## Answer`。結論若推翻假設，回頭修改 spec，再讓下游票繼續。

三個假設：

1. 在隔離的 `DSH_HOME`、內建 `headless` profile 上，用 overlay 補上 `webServer` 服務後，外掛能穩定啟用，並完整走完一次「經過 DSH 的模型回覆」。先前實機只做到被 429 擋下，沒有拿到過完整回覆。
2. 外掛的暖機探測結果可以不讀外掛內部快取檔的格式就取得（例如透過 DSH 與外掛的公開行為）。
3. 以某個模型發布的最低 effort 等級送出請求時，Zen 不會回 `UNSUPPORTED_REASONING_EFFORT`。

## 注意

- 這張票會消耗匿名額度，可能再度被 429 擋下。**允許部分結論**：被擋住的假設明確標「未驗證」並說明原因，不得寫成已確認。只要有任何一個假設被推翻或未驗證，都要在 `## Answer` 說明對下游票的影響。
- 只用隔離環境，不碰使用者的 `~/.dsh`，不啟動或停止任何既有的 DSH。
- 不得尋找或使用任何 Zen key；沒有 key 就以匿名驗證。

## Acceptance criteria

- [ ] 假設 1：記錄是否拿到至少一次完整的模型回覆，或被擋在哪一步
- [ ] 假設 2：記錄暖機結果能否經公開行為取得，以及取得方式；若不行，提出替代方案
- [ ] 假設 3：記錄至少一個有發布 effort 等級的模型以最低等級送出的結果
- [ ] 每個假設標明「已確認 / 已推翻 / 未驗證」及證據
- [ ] 若有假設被推翻或未驗證，已更新 spec 或註明對 #05、#09 的影響

## Answer

2026-10-03，Windows 11（win32 x64）、Node v24.13.0、DSH `0.2.1-alpha.1`（npm `@deepseek-ai/dsh`，裝在 `%TEMP%` 的隔離目錄）、外掛 `0.3.1`（目前 repo `pnpm pack` 的 tarball，以 `dsh plugin --profile headless add file:<tgz>` 裝入隔離 `DSH_HOME`），匿名、無 key。沒有碰 `~/.dsh`，也沒有啟停任何既有 DSH。

overlay（`--patch`）內容：插入 `webserver` 列（`@deepseek-ai/dsh-host-webserver`，`host: '127.0.0.1'`，埠為 Node 預先向 OS 要的空閒埠），覆寫 `agent-default-model`（`provider: opencode-zen-free`、`model`、選用的 `reasoningEffort`），並停用 `session-title-llm`（否則每次 headless 會多送一個標題請求，耗兩倍額度）。

1. **已確認。** 外掛在 headless 下啟用，`/dsh-opencode-free/api/catalog` 約 2 秒後可讀。`nemotron-3.5-lightning-free` 經 DSH 回覆 `OK only`（退出碼 0）；`fledge-alpha-free` 回覆 `OK`。帶 `--tools` 的兩步也實測通過：`read` 讀回隨機 nonce，`pwsh` 印出 nonce 檔的 SHA-256 前 16 碼（pwsh 輸出大寫，需不分大小寫比對）。headless 下工具不需要 approval。
2. **已確認，經公開行為取得。** 暖機進程以 `-`（讀 stdin）啟動 headless 並保持 stdin 開著，DSH 載入外掛後不會開始任務；依序呼叫外掛面板路由 `POST /refresh`（同源 `Origin`）、`POST /probe`，輪詢 `GET /probe` 直到 `running: false`，再讀 `GET /catalog` 的 `visible`，然後結束進程。全程不讀快取檔。實測一輪 13 個模型：5 個 `ok`、8 個 `quota-exhausted`（429），23 個 models.dev 免費但 Zen 未列者標 `not-listed`（零成本）。之後各模型進程只發一個 completion 請求與一次免費的 `/models` GET，沒有再觸發探測（`DSH_OPENCODE_FREE_DEBUG=1` 觀察）。
3. **已確認。** `fledge-alpha-free`（發布 `low/high/max`）以 `reasoningEffort: low` 送出：provider 收到 `reasoning=low`，上游 200，回覆 `OK`，沒有 `UNSUPPORTED_REASONING_EFFORT`。

失敗輸出樣本（供 #03 判定用）：429 時 stderr 為 `dsh: RATE_LIMIT: 免費額度用完。…（上游 HTTP 429）`、退出碼 1（DSH 自己的 `llm-retry` 會先重試，約 18 秒）；不在 picker 的模型為 `dsh: UNKNOWN_MODEL: pi-ai provider "opencode-zen-free" has no configured model "…"`、退出碼 1。

對下游票的影響：沒有假設被推翻。#05 依第 2 點用面板路由取得暖機結果；#09 依上面的 overlay 驅動 DSH。#08 的 shell 步驟改為「印出 nonce 檔的 SHA-256 前 16 碼」，避免把 nonce 直接寫進提示讓模型照抄，spec 已同步。DSH 安裝改用 `pnpm add --config.node-linker=hoisted`（允許 build scripts），13 秒完成，`dsh-host-webserver` 可解析。
