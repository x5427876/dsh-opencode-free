# 03: 請求路徑接線，聊天失敗指得出路

**What to build:** 傳輸失敗時查分類接縫，轉為帶穩定代碼的錯誤並附指引文字；
使用者在聊天看到的即指引，不再是通用密钥无效。

**Blocked by:** 01 (上游失敗分類接縫).

**Status:** resolved

- [ ] Fixture 模擬 403／429／401，各自出現對應指引
- [ ] Muse Spark 預設推理行為不變
- [ ] 會話 id 方案零改動（ADR-0001）

## Comments

2026-09-22 追修：v0.2 初版只包了 `result()`，production 會話記錄證明
DSH 持久化的是串流 error 事件轉譯的 finish chunk（`failure.message` +
`code: AUTH`），result 映射完全碰不到。已改為同時包
`Symbol.asyncIterator`（只改寫 `type: error` 事件的 `errorMessage`，
其餘事件原樣轉發），回歸測試改斷言原始 error 事件。教訓：迴圈只驅動
`result()` 是不完整的迴圈，必須含事件迭代。
