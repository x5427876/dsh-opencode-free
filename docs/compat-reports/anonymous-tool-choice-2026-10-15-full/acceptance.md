# 全模型相容性驗收

日期：2026-10-15。退出碼：2。完整驗收：未完成。

## 執行範圍

使用者已授權依序實作及本輪 live 驗收。執行命令：

`pnpm compat --dsh 0.2.1-alpha.3 --tools --out docs/compat-reports/anonymous-tool-choice-2026-10-15-full`

此命令沿用 `pnpm run build && node scripts/compat-run.mjs`。未指定單一模型。
使用本地工作樹打包的插件 0.3.4；不是已發布套件的驗收。
匿名 public，獨立 DSH_HOME、工作目錄與 headless profile。只在子進程移除 key 與 debug 環境變數。
本輪沒有啟停既有 DSH，也沒有安裝到使用者 profile。

## 結果

本輪確認 8 個免費對話目標；8 個模型通過全部必要步驟。
官方資料另有 4 個項目無法確認分類。這些項目未發推理請求，也不算通過。

| 模型 | L0 | L1 | read | pwsh | 判定 |
| --- | --- | --- | --- | --- | --- |
| big-pickle | 通過 | 通過 | 通過 | 通過 | ok |
| cat-jam-free | 通過 | 通過 | 通過 | 通過 | ok |
| mimo-v2.6-flash-free | 通過 | 通過 | 通過 | 通過 | ok |
| muse-spark-1.3-contributor-free | 通過 | 通過 | 通過 | 通過 | ok |
| nemotron-3.5-lightning-free | 通過 | 通過 | 通過 | 通過 | ok |
| step-5-preview-free | 通過 | 通過 | 通過 | 通過 | ok |
| longcat-2.5-preview-free | 通過 | 通過 | 通過 | 通過 | ok |
| space-bunny-free | 通過 | 通過 | 通過 | 通過 | ok |

## 官方來源與分類缺口

- [官方模型清單](https://opencode.ai/inference/v1/models)：ok；2026-10-15T00:53:44.791Z
- [官方端點與價格](https://opencode.ai/v2/docs/console/models/)：ok；2026-10-15T00:53:44.791Z
- [models.dev 補充資料](https://models.dev/api.json)：ok；2026-10-15T00:53:44.791Z

排除 73 個有官方依據的付費或非對話項目。完整清單見同目錄 JSON。

- muse-spark-1.2-contributor-free：official endpoint missing or ambiguous
- test：official endpoint missing or ambiguous
- claude-opus-5-5-backup：official endpoint missing or ambiguous
- deepseek-v4-flash：official endpoint missing or ambiguous

不使用 ID 名稱推測費率，不以 models.dev 缺資料縮小驗收範圍，不跨輪合併成功結果。

## 版本與產物

- DSH CLI：0.2.1-alpha.3。
- 插件：0.3.4，local working-tree tarball。
- 原始碼提交：d26726b6efc40558d764d4967744b5e8ddfdb78b。
- tarball SHA-256：814caede1237a4a103ea15c8eee77250b91e52b779d392f82af36e47a9fe6e75。
- @deepseek-ai/dsh-llm：0.2.1-alpha.3。
- @deepseek-ai/dsh-llm-pi-ai：0.2.1-alpha.3。
- @earendil-works/pi-ai：1.2.0。

## 離線驗證與審查

`pnpm run check` 通過。274 個離線測試全部通過，型別、建置與打包通過。
實際 tarball 的執行匯入、型別消費、client 語法、patch 及私有檔案排除檢查通過，共 14 個允許的項目。
工程標準與規格兩軸審查已完成。審查發現的官方目錄漏測問題已修正，且回歸測試通過。詳見 [review.md](review.md)。

原 L0 HTTP 400 已確認與插件強制加入 `tool_choice: "none"` 有關。共用策略已移除此強制設定，並保留呼叫端選項。離線測試也確認補位工具呼叫不會到達宿主執行端。

## 清理與限制

暫存根目錄 `C:/Users/Gavin/AppData/Local/Temp/dsh-compat-9NjI0W`：已確認不存在。
報告僅保存安全判定、狀態與比較布林。原始對話、推理、工具輸入與結果只在記憶體比對。
此結果只涵蓋 Windows headless；不宣稱 Web、Desktop、compaction 或其他平台成功。
票 05 保持 open。須先補足官方分類證據，並在上游允許時另經授權執行完整一輪。不得把本輪未完成項目標記通過。
