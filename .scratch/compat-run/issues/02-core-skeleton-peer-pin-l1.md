Status: open
Labels: ready-for-agent
Blocked by: None (can start immediately)

# 02: 核心骨架：peer 釘選檢查與單一模型 L1 判定

Spec: `../spec.md`

## What to build

相容性驗證（compat run）的核心 `runCompat(options, deps)` 的最小可用版，也是整個功能唯一的測試 seam。給定選項與注入的依賴，它回傳報告物件與退出碼。

本票交付的行為：

- DSH 版本必填、沒有預設值；缺少時直接報錯。
- 當外掛 `package.json` 的 peer 釘選不等於指定的 DSH 版本時，立刻停止並說明原因；此時不呼叫任何驅動器、不消耗任何請求。
- 對注入的模型清單逐一呼叫注入的驅動器，取得一次 headless 的 stdout、stderr 與退出碼；回覆為非空文字則該模型判 `ok`，否則判 `plugin-fault`。
- 產出報告物件：檔頭（DSH 版本、外掛版本、日期、作業系統、是否帶 key）加逐模型結果。
- 退出碼：有 `plugin-fault` 為 1，否則為 0。

依賴一律注入（取得模型清單、單一模型的驅動器、`sleep`），本票用假的實作測試，不打真實 DSH 或 Zen。

## Acceptance criteria

- [ ] 缺少 DSH 版本時回報明確錯誤
- [ ] peer 釘選不符時停止，且驅動器零次呼叫
- [ ] 非空文字回覆判 `ok`；空回覆、外掛未啟用、`NO_ADAPTER` 判 `plugin-fault`
- [ ] 報告物件含檔頭全部欄位與逐模型結果
- [ ] 有 `plugin-fault` 時退出碼 1，全部 `ok` 時退出碼 0
- [ ] 測試只透過 `runCompat` 驗外部行為，沿用既有測試以注入依賴、不打真實上游的風格
