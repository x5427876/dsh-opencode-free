Status: resolved
Labels: ready-for-agent

# 01: 修復無工具匿名請求並守住宿主執行邊界

**Parent:** [功能規格](../spec.md)。

**What to build:** 探測與其他無工具匿名請求保留准入工具宣告，但不再被插件強制加入不相容的工具選擇值。模型嘗試呼叫補位工具時，在宿主可執行呼叫形成前拒絕。真實工具、明確呼叫端選擇與帶 key 請求維持原語意。

**Blocked by:** None (can start immediately).

**User stories:** 1–14、40。

## Acceptance criteria

- [x] 先以公開 provider／HTTP fixture 重現無工具預設請求因插件加入 tool_choice none 而遭拒絕的案例，再修復並確認該案例通過。
- [x] 正常 gate 與最終 payload backstop 都採同一匿名准入策略。無宿主工具且呼叫端未明確指定選擇時，保留實質 read／bash 宣告並省略插件加入的 tool_choice；不使用逐模型例外表。
- [x] main／direct compat、兩種 stream 方法、Responses／Completions、legacy／normalized context 均有行為證據。
- [x] 串流與最終結果中的補位呼叫均在宿主可執行呼叫形成前遭拒絕。測試完整及分片工具名稱，直接檢查宿主收到的事件，而非只檢查最後 result 拒絕。
- [x] 補位呼叫失敗有可辨識且安全的錯誤，不執行補位工具、不重寫對話、不自動重送，也不改變既有 429 退避。
- [x] 保留真實宿主工具、呼叫端明確工具選擇與 payload hook 語意。帶 key、其他 provider、非目標請求保持原行為。
- [x] read、pwsh／bash 的名稱、參數、結果與歷史往返，以及 session 身份、親和與呼叫端輸入不可變通過必要回歸。
- [x] 使用既有公開接縫完成離線測試，不新增測試專用公開介面；同步相關雙語行為說明與未發布變更紀錄。
- [x] 本票可用離線 fixture 展示請求成功與補位呼叫被攔截，不以此宣稱上游全部模型已通過；不發 live 請求。

## Context

兩個強制 none 的既有寫入點均須處理。不能只修探測或單一通道。保留精確 DSH 0.2.1-alpha.3、插件 0.3.4 與既有傳輸。適用 A1–A3、Q1–Q3、S1–S3、D1；不擴大修復無關 gap。





## Outcome

公開 provider 回歸先紅後綠。相關兩檔共 41 個離線測試與型別檢查通過。未發 live 請求。

