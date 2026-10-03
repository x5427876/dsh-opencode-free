Status: resolved
Labels: ready-for-agent
Blocked by: 01, 02, 04

# 09: 真實驅動器與隔離環境，接上命令列

Spec: `../spec.md`

## What to build

把核心接上真實世界，讓任何開發者只要有 Node 和 pnpm，一個指令就能在指定的 DSH 版本上跑相容性驗證。

- 命令列入口：解析 `--dsh <版本>`（必填）、`--tools`、`--keep`、`--out`，接上真實依賴後呼叫核心，印出報告並以核心的退出碼結束。
- 隔離環境：在系統暫存目錄安裝指定版本的 DSH，把 `DSH_HOME` 指到暫存目錄；對目前 repo 打包外掛並裝進隔離的 `headless` profile。完全不碰使用者的 `~/.dsh`，不啟動、停止或重啟任何既有的 DSH。
- 補上外掛需要的 `webServer` 服務：自選空閒埠、只綁 127.0.0.1，並以 overlay 指定預設模型與 `reasoningEffort`。做法依 #01 的結論。
- 真實驅動器：對單一模型在隔離環境跑一次 headless，回傳 stdout、stderr、退出碼。
- 預設結束時清除暫存環境；`--keep` 保留並印出位置。
- 只用 Node 的子進程介面，不使用 shell 專屬語法，Windows、macOS、Linux 一致。

驗收需要一次實機執行：對**一個**模型跑出 L1 結果並記錄。若匿名額度已乾，如實記錄為 `rate-limited`，並說明驗到了哪一層。

## Acceptance criteria

- [ ] 一個指令即可執行，只需要 Node 與 pnpm，不需要 key
- [ ] 隔離環境建在暫存目錄，`~/.dsh` 與既有 DSH 進程完全不受影響
- [ ] 外掛 tarball 來自目前 repo，並以 `file:` 安裝進隔離的 `headless` profile
- [ ] 自選空閒埠、只綁本機迴圈位址
- [ ] 預設清理暫存；`--keep` 保留並告知位置
- [ ] 跨平台不依賴 bash 或 cygpath
- [ ] 實機對一個模型跑出的結果（或被 429 擋下的紀錄）已記入本票的 `## Answer`
- [ ] 失敗時的錯誤訊息不含 key 或請求內容

## Answer

`scripts/compat-run.mjs`（`pnpm compat --dsh <版本> [--tools] [--keep] [--out <dir>]`）接上真實依賴：Zen `/models` 與 models.dev（重用外掛的 `fetchZenModelIds`、`fetchSection`）、隔離 DSH 驅動器、真實計時。只用 `child_process.spawn` 呼叫 `node` 與 pnpm（經 `npm_execpath`），不經 shell，不依賴 bash 或 cygpath。前置檢查失敗（缺 `--dsh`、peer 不符、參數錯）以退出碼 3 結束，不安裝也不送請求。

2026-10-03 實機（Windows 11、Node v24.13.0、DSH `0.2.1-alpha.1`、外掛 `0.3.1` 由目前 repo `pnpm pack`、匿名）：

- 前置檢查：`pnpm compat` 與 `pnpm compat --dsh 0.2.0-rc.2` 都以 3 結束，系統暫存目錄沒有建立任何 `dsh-compat-*`。
- 第一次完整執行：models.dev 暫時連不上（`fetch failed`；直接重試正常），流程停下並回報、以 2 結束，沒有退回內建清單。
- 第二次：暖機正常；Zen 順序前 3 個模型（big-pickle、deepseek-v4-flash-free、muse-spark-1.3）退避 30s/60s 後仍 429，連續 429 規則中止，其餘 10 個標未驗證，退出 2。當時暖機剛看到另外 5 個模型正常回覆。因此加上「暖機回答 ok 的模型先驗」（spec 已同步，有測試）。
- 第三次（13:38Z）：**退出碼 0**。11 個 `ok`（L1）；`deepseek-v4-flash-free` 為 `upstream-down`（`400 … Model is unavailable`）、`ling-3.0-flash-fin-free` 為 `upstream-down`（`Endpoint is unavailable`）；沒有 `plugin-fault`、沒有未驗證。暖機中標 429 的 8 個模型，間隔 3 秒逐一送出時都正常回覆。
- 隔離：DSH 與外掛裝在 `%TEMP%\dsh-compat-*`，結束後已刪除（只留 `%TEMP%\dsh-compat-reports\` 的 JSON）；`~/.dsh` 在執行期間沒有任何檔案變動；沒有啟停既有 DSH。webServer 綁 `127.0.0.1`、埠由 OS 指派。
- 錯誤訊息只含 stderr 的 `dsh: CODE: …` 行或步驟名稱與退出碼；key 由核心在分類前替換掉（#07 測試）。匿名請求的子進程環境會移除 `OPENCODE_API_KEY`。
