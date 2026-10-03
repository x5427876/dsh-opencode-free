Status: open
Labels: ready-for-agent
Blocked by: 02

# 03: 判定分類與 429 處理

Spec: `../spec.md`
ADR: `docs/adr/0003-compat-run-not-in-ci.md`

## What to build

讓相容性驗證能分辨「外掛壞了」和「額度乾了或上游壞了」，不再把所有非 `ok` 都當失敗。

- 補齊判定：`rate-limited`（429，不確定）、`upstream-down`（上游明確說模型不可用，例如 Model/Endpoint is unavailable、500；已知 Ling 3.0 即屬此類）、`gate-refused`（403，閘門政策變了）。
- 限速：模型之間間隔 3 秒。
- 遇到 429 依序退避 30 秒、60 秒各重試一次；仍為 429 則標 `rate-limited`。
- 連續 3 個模型都 429 時整輪中止，剩餘模型標「未驗證」。
- 退出碼：有 `plugin-fault` 為 1；否則有 `rate-limited` 或未驗證為 2；否則為 0。`upstream-down` 與 `gate-refused` 只進報告，不影響退出碼。

`sleep` 由 #02 的注入依賴提供，所以退避與間隔的測試不需要真的等待。

## Acceptance criteria

- [ ] 各種驅動器輸出對應到正確的五種判定之一
- [ ] 429 之後依 30 秒、60 秒退避，且重試成功時判 `ok`
- [ ] 兩次退避後仍 429 判 `rate-limited`
- [ ] 連續 3 個模型 429 即中止，剩餘模型標未驗證且不再呼叫驅動器
- [ ] 模型間間隔 3 秒（以注入的 `sleep` 觀察）
- [ ] 退出碼 0、1、2 與優先序（1 > 2 > 0）皆有測試
- [ ] `upstream-down` 與 `gate-refused` 不使退出碼非 0
- [ ] 報告明確列出未驗證的模型
