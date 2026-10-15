Status: resolved
Labels: ready-for-agent

# 02: 有效且穩定的 session 身份

**What to build:** 讓同一 DSH session 使用有效且穩定的上游身份，不再以雜湊偽造時間區段，並讓所有既有請求路徑的親和標頭與 payload cache key 保持一致。

**Blocked by:** None (can start immediately).

## Acceptance criteria

- [x] 以既有公開 provider／身份接縫和固定時間 fixture，先重現雜湊時間區段不符合官方編碼，再修正為已取得成功證據的 descending 時間編碼。
- [x] 時間編碼的預期值來自固定的一手來源例子，不把實作算法複製成 assertion；有效 ID 保留官方結構。
- [x] 相同 DSH session 在目前進程內使用相同上游身份；不同 session 身份可區分，且不需新增持久化登入或憑證資料。
- [x] main、compat 與既有身份守衛的 session 親和欄位和 payload cache key 一致，不出現只修正標頭但保留舊 cache key 的情況。
- [x] 不因修復而重寫呼叫端的 transcript、工具定義或選項；不覆蓋有效認證或破壞 config、環境變數、匿名 public 的既有優先順序。
- [x] 不順便改變 request ID 策略；若實作確認契約要求調整，須以可重現的行為證據與回歸測試說明必要性。
- [x] 釐清目前進程內穩定親和與時間編碼所需狀態的生命週期；必要的固定時間／時鐘回撥 fixture 通過，不宣稱已驗證上游的長 session 或允許時間範圍。
- [x] 更新或替代既有雜湊 session 身份 ADR，保存舊決策的取捨、被推翻的前提與新策略；相關雙語說明及未發布變更紀錄同步更新。
- [x] 相關離線回歸、型別檢查與建置通過；測試不使用上游、不讀使用者 profile、不輸出認證片段、對話或原始請求。
- [x] 保留 0.3.4／DSH 0.2.1-alpha.3，不發布、不修改使用者資料；不把本票離線成功當作真實 DSH 或全部模型通過。

## Context

Parent: 新 inference 准入相容性與單模型相容性驗證規格。

差分診斷顯示：使用套件 hash session 並同步親和欄位仍得到 403；保留隨機尾段、換成有效時間前綴得到 200。本機自行生成 descending 時間前綴也已在 provider 診斷接縫取得非空回覆。request ID 單獨替換仍得到 200，因此不是已證實的必要修正。

遵循既有目錄 source-of-truth 與 live／CI 分離決策；只重審這次證據推翻的身份決策。與票 01、03 共享模組，建議依序實作，但不增加功能依賴。

## Comments

已改為首次生成有效 descending 時間 ID、進程內穩定映射與共同 fallback；親和欄位沿用既有單一值流程，request ID 未改。固定 timestamp 0／counter 1 的一手來源例子先失敗，再修正通過；另覆蓋不同 session、重複呼叫與時鐘回撥。

驗證：型別檢查、建置及 inference-admission／compatibility 共 35 個離線測試通過。ADR-0001、雙語 README 與 Unreleased 已更新。未新增持久化狀態，未執行 live 驗證。
