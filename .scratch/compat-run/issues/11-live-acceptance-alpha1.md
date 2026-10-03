Status: open
Labels: ready-for-agent
Blocked by: 10

# 11: 在 DSH `0.2.1-alpha.1` 上做一次完整實機驗證

Spec: `../spec.md`

## What to build

用做好的相容性驗證，對 DSH `0.2.1-alpha.1` 搭配目前的外掛版本跑一次完整的實機驗證，這也是原本卡住的「確認所有模型可用」的答案。

- 以 `--dsh 0.2.1-alpha.1` 對全部免費模型執行；時間與額度允許時加 `--tools`。
- 用 `--out` 把報告存成留存證據。
- 結果如實記錄：額度不足時，被擋的模型標 `rate-limited`、沒輪到的標未驗證，**不宣稱通過**。退出碼 2 就是「沒驗完」，要說明。
- 若出現 `plugin-fault`，附上原因並另開票處理，不在本票內修外掛。
- `upstream-down`（例如 Ling 3.0 的 Endpoint is unavailable）只記錄，不視為外掛問題。

這張票依賴匿名額度，可能需要等額度恢復後重跑；在拿到完整結果之前保持 open。

## Acceptance criteria

- [ ] 實機執行完成，退出碼已記錄並解釋
- [ ] 報告已用 `--out` 存檔，檔頭含 DSH 版本、外掛版本、日期、作業系統、是否帶 key
- [ ] 每個免費模型都有判定與驗到的層級；未驗證者明確列出
- [ ] 沒有 `plugin-fault`，或每個 `plugin-fault` 都有對應的後續票
- [ ] 結論如實寫進 `## Answer`，沒有把 `rate-limited` 或未驗證寫成通過
