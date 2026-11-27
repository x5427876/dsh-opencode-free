# 匿名路徑盡力而為，自備 key 是穩定的付費替代

**Status**: accepted, 2026-11-27.

Zen 文件〈Endpoints〉寫明 *Free-tier chat models require OpenCode*，並請其他客戶端改用付費模型或 Go
（[Zen 文件](https://opencode.ai/docs/zen)）。OpenCode
[服務條款](https://opencode.ai/legal/terms-of-service)（2026-11-25 生效）限制使用方式的清單中，
第 5 項限制自動化擷取資料或輸出，第 13 項禁止反向工程。匿名 429 的 `FreeUsageLimitError`
同時涵蓋額度用盡與准入拒絕，單看回應無法分辨。

## 決策

- 匿名路徑是**盡力而為**：README（中、英）開頭說明它隨時可能失效，並附 Zen 文件與條款出處。
- 自備 Zen API key 是**穩定但付費**的替代：其他客戶端只能用付費模型，費用記在 key 所屬帳戶。
- 只對**實際觀察到的准入拒絕**做調整（有日期、有同 IP 官方對照的實測），不預先追逐官方客戶端的指紋。
- 匿名請求的 User-Agent 保留 `dsh-opencode-free/<版本>` 後綴，上游可以辨識並封鎖本插件。

## 取捨

拿掉 User-Agent 後綴、主動追蹤更多指紋，可能讓匿名路徑活得更久，但那是偽裝成官方客戶端，
與條款和文件的方向相反，也讓上游無從分辨流量來源。保留後綴的代價是：上游可以隨時只擋本插件。

把匿名路徑定為盡力而為，代表准入拒絕不算插件故障：compat run 回報為驗證未完成（結束碼 `2`），不是
`plugin-fault`；使用者被導向 key 或官方 OpenCode。

只對已觀察到的拒絕做調整，代表插件會落後於上游的變動；這是刻意的，因為未觀察到的規則無從驗證，
預先調整只會增加偽裝面。
