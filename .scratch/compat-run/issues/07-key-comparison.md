Status: open
Labels: ready-for-agent
Blocked by: 03

# 07: 帶 key 的對照補跑

Spec: `../spec.md`

## What to build

匿名為主；有 Zen key 時用它區分「外掛壞了」和「額度乾了或閘門變了」。

- 偵測環境變數 `OPENCODE_API_KEY`（不是命令列選項，key 不出現在命令列或報告中）。
- 只對匿名結果是 `rate-limited` 或 `gate-refused` 的模型補跑一次帶 key 的請求，結果與匿名結果並列於報告。
- 沒有 key 時完全不補跑，流程照常完成。
- 其他判定的模型不補跑，匿名路徑（外掛最核心的承諾）仍是驗證主體。
- 報告只記錄「是否帶 key」，絕不輸出 key 本身。

## Acceptance criteria

- [ ] 沒有 key 時零次補跑
- [ ] 有 key 時只對 `rate-limited` 與 `gate-refused` 的模型補跑
- [ ] 匿名與帶 key 的結果並列呈現
- [ ] 補跑的結果不改變匿名判定本身，也不使匿名的 `rate-limited` 被當成通過
- [ ] key 不出現在報告、JSON、終端輸出或錯誤訊息中（有測試斷言）
