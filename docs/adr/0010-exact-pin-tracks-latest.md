# 精確 pin DSH，以自動 PR 追蹤 npm `latest`

**Status**: accepted, 2026-11-27.

每個插件版本只支援一個 DSH 版本（[standards C1](../standards.md)），peer 依賴寫成精確版本。
代價是 DSH 換版後，插件要等維護者發現並升版才裝得上，中間會落後。

## 決策

- peer 依賴維持**精確 pin**，不改成版本範圍。
- 只追蹤 npm `@deepseek-ai/dsh` 的 **`latest`** dist-tag；`alpha`、`next` 等其他 tag 不觸發升版。
- `pnpm dsh:latest` 回答「`latest` 是否比目前的 pin 新」：輸出 `none` 或 `bump <版本>`；
  查詢失敗或 metadata 格式錯誤時以結束碼 `2` 結束，絕不當成「沒有新版」。
- 每天由 GitHub Actions 執行；有新版時開出（或更新）一個升版 PR，附上 check 與 offline replay 的結果。
  PR 只是候選：合併前仍要照 [release checklist](../release.md) 檢查 manifest、跑 compat run。

## 為什麼不用版本範圍

DSH 的小版本之間，請求內容到達 provider 的方式會變：rc.1 與 rc.2 對 pi-ai 的
`Context` 處理不同，pi-ai 0.86 起舊的 `Context` 會轉成 `TranscriptContext`，只有這種形式能到達
provider；寫入 `context.tools` 的閘門調整在其中一版有效，在另一版被靜默丟棄。版本範圍會宣稱
支援兩種行為的聯集，但只有其中一種被實測過，也讓 CI 的 typecheck 解析到當天剛好符合的版本。

## 取捨

只追 `latest` 代表 alpha 與 rc 的變動要等它們成為 `latest` 才會被發現；這是刻意的，
因為使用者裝到的預設版本就是 `latest`。自動 PR 只縮短發現的時間，不取代 compat run 與人工發行。
