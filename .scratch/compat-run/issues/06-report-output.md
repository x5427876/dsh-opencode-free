Status: resolved
Labels: ready-for-agent
Blocked by: 02

# 06: 報告輸出

Spec: `../spec.md`

## What to build

讓相容性驗證的結果一份報告就看得懂，並且預設不弄髒開發者的工作區。

- 人讀的矩陣加機器讀的 JSON。
- 預設只把矩陣印到終端，並把 JSON 寫到暫存目錄。
- 只有指定 `--out <dir>` 才把報告寫進 repo。
- 檔頭固定記錄：DSH 版本、外掛版本、日期、作業系統、是否帶 key，以及驗證路徑的說明（隔離的 `headless` profile，不是使用者實際使用的 profile，避免被誤讀成「web UI 已驗證」）。
- 逐模型列出：判定、驗到哪一層、使用的思考等級、失敗原因。

## Acceptance criteria

- [ ] 不帶 `--out` 時，repo 內沒有任何檔案被寫入
- [ ] 帶 `--out` 時，人讀矩陣與 JSON 寫入指定目錄
- [ ] 檔頭欄位齊全，並含驗證路徑說明
- [ ] 每個模型的判定、層級、思考等級與失敗原因都在報告中
- [ ] 未驗證的模型明確列出，沒有被當成通過
- [ ] JSON 可被機器解析，內容與人讀矩陣一致
