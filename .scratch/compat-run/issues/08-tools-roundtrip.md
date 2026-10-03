Status: open
Labels: ready-for-agent
Blocked by: 02

# 08: `--tools` 工具往返（L2）

Spec: `../spec.md`

## What to build

選用旗標 `--tools`，把驗證從 L1 提升到 L2：驗證經過 DSH 的工具往返，抓閘門與工具名稱映射的回歸（rc.2 時就在這一層壞過）。預設流程不跑，維持快速。

- 在隔離目錄建一個內容為每次隨機產生的 nonce 的檔案，要求模型讀取並回覆其內容。回覆含該 nonce 才算 `read` 步驟通過。nonce 無法被猜到，所以模型編一個答案不會被誤判為通過。
- 第二步要求執行一個印出另一個隨機 nonce 的 shell 指令：Windows 走 `pwsh`，其他平台走 `bash`，目的是驗工具名稱映射。回覆含對應 nonce 才算通過。
- 兩步各自判定，報告標明失敗的是 `read` 還是 shell。兩步都過才算 L2 通過。

## Acceptance criteria

- [ ] 不帶 `--tools` 時不執行任何工具往返
- [ ] 帶 `--tools` 時兩步各自判定，並在報告分別呈現
- [ ] nonce 不符不算通過；每次執行的 nonce 不同
- [ ] 只過其中一步時，報告標明是 `read` 或 shell 失敗
- [ ] Windows 與其他平台選用對應的 shell 工具
- [ ] 工具往返失敗歸為 `plugin-fault`；若原因是 429，仍依 #03 的規則歸為 `rate-limited`
