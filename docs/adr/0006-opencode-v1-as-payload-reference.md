# 以 OpenCode CLI v1 線作為請求內容的仿照依據

**Status**: accepted, 2026-10-31.

OpenCode CLI 現在有兩條並行的發行線。v1 線（npm `opencode-ai`，最新 1.19.5）是
預設安裝腳本與 npm `latest` 所指的版本。v2 線（GitHub 發行與 `@opencode/cli`，最新 2.2.5）
是官方宣告的接班版本：文件有「Migrate from V1」專頁，v2 的安裝器會取代 v1 的執行檔。
官方沒有公布 v1 的停止維護日期。

匿名請求要符合官方 CLI 的內容（見[協定分析紀錄](../protocol-notes.md)），所以必須選一條線當
「仿照依據」。兩條線送出的請求在 2026-10-31 的實測中並不相同：

- 主請求的工具：v1 為 `bash edit glob grep read skill task todowrite webfetch write`；
  v2 為 `edit glob grep question read shell skill subagent webfetch websearch write execute`。
  各工具的描述與 schema 逐項不同。
- TLS 密碼套件清單（17 項、同順序）與 `<env>` 區塊（含 `Working directory:`）兩條線相同。
- 閘門對兩種工具集都放行。

## 決策

- 插件的請求形狀（`read`／`bash` 的補位宣告、工具改名、`<env>` 區塊、TLS 密碼套件）
  仍以 **v1 線**為依據，目前基準是 1.19.5。不因 v2 發行而改成 v2 的形狀。
- v2 線只當**漂移觀察**：每次評估都擷取 v2 最新版的請求，與插件比對並放行回放
  （[升級評估](../upgrade-evaluation.md#4-check-the-official-cli-payload)），結果記入協定紀錄，
  但不單獨觸發程式碼變更。
- 以下任一條件成立時，重新檢討這項決定：閘門拒絕插件現行形狀而放行 v2 形狀；
  官方宣告 v1 停止維護；預設安裝腳本或 npm `latest` 改指向 v2。

## 取捨

選 v1 的理由是它仍是預設路徑，使用者與官方免費層的主要客戶端多半仍是它，而且插件已在這個形狀上
完成全模型 L0 與單模型 L1／L2 驗證。代價是方向相反：官方明確往 v2 走，閘門日後可能只收 v2 的
形狀，到時插件會一次落後兩個版本。每次評估都擷取 v2 並回放，是為了在那之前看見訊號。
插件並不複製任一版的工具描述（`read`、`bash` 的說明是依 DSH 能力改寫），所以改依據的成本主要是
重新驗證，不是改寫大量程式碼。
