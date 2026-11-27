# 以 OpenCode CLI v2 線作為請求內容的仿照依據

**Status**: accepted, 2026-11-27. Supersedes [ADR-0006](0006-opencode-v1-as-payload-reference.md).

官方的免費層總整理 [anomalyco/opencode#59387](https://github.com/anomalyco/opencode/issues/59387)
寫明 v1 線（`0.x`、`1.x`，例如 1.19.5）不再支援免費模型、只修重大錯誤，並要求使用者升級到 v2；
v1 Desktop 已收到「This version of OpenCode Desktop no longer supports free models」
（[#59378](https://github.com/anomalyco/opencode/issues/59378)）。這符合 ADR-0006 列出的
「官方宣告 v1 停止維護」條件。

## 決策

- 插件的 CLI 請求格式改以 **v2 線**（npm `@opencode/cli`）為仿照依據，基準為 2.4.2：
  工具形狀、`<env>` 區塊、TLS 密碼套件、識別標頭全部對齊這一版的實測擷取。
- 不保留切回 v1 形狀的開關；v1 形狀只留在版本控制歷史。
- 不再擷取或觀察 v1 線。升級評估只擷取 v2 最新版。
- 擷取以官方發行的二進位檔（核對 `SHA256SUMS`）為準；v2 原始碼只用來對照。

## 取捨

插件的 v1 形狀曾在全模型 L0 與單模型 L1／L2 通過，改依據後這些結果不再適用，必須在 v2 形狀上重新驗證。
v2 的工具集與 DSH 的對應（`shell`、`subagent` 等）比 v1 更遠，補位與改名的規則需要重新設計。
留著 v1 的代價是：閘門可能隨時只收 v2，而官方已明說 v1 不再支援免費模型。
