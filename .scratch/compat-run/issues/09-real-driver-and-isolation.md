Status: open
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
