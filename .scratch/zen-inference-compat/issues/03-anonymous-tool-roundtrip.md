Status: resolved
Labels: ready-for-agent

# 03: 匿名工具准入與 DSH 往返相容

**What to build:** 讓匿名請求具有符合目前准入要求的工具宣告，同時保留 DSH 實際工具執行語意；有工具與無工具請求都不能以虛構宿主能力或破壞參數往返為代價。

**Blocked by:** None (can start immediately).

## Acceptance criteria

- [x] 先核對精確釘選宿主的實際 `read` 與 Windows `pwsh` 工具契約，不假設 DSH 原生定義必定被拒絕，也不直接把官方完整定義套進宿主。
- [x] 透過真實 provider 與離線 HTTP fixture，先重現舊空 schema／佔位描述策略，再完成最小必要工具相容處理；若需准入定義，使用已驗證的一手來源，不發明永久的字串匹配規則。
- [x] 舊 Context 與 normalized transcript 均產生一致的准入宣告，並涵蓋既有 main 與 compat 呼叫路徑；不引入額外公共測試介面。
- [x] 保留 Windows `pwsh` 出站為 `bash`、回傳還原為 `pwsh` 的既有語意；任何新增參數映射均成對處理出站、歷史與回傳，不能把 PowerShell 指令錯交給另一種 shell。
- [x] `read` 的路徑、讀取範圍與實際參數在出站／回傳映射後仍正確；SSE 事件與最終結果可交給 DSH 原有工具執行流程。
- [x] 工具歷史中的名稱與參數可重播；呼叫端 transcript、工具定義與選項不被原地修改。
- [x] 無工具探測與既有短訊息請求共用新的補位策略，不再依賴空 schema／佔位描述通過准入。
- [x] 補位工具不是新增宿主執行能力；不存在的工具不能被誤執行，也不透過重寫使用者對話假裝通過准入。
- [x] 帶 key 請求保留既有工具與認證行為，匿名改寫不擴大到 keyed 路徑。
- [x] 在既有公開 provider 接縫加入有工具、無工具、歷史、串流還原、呼叫端不變性與 keyed 路徑的 red → green 回歸；只 mock 外部 HTTP 等系統接縫，不 mock gate 私有實作。
- [x] 相關離線測試、型別檢查與建置通過；不使用上游、不讀使用者 profile、不保存或輸出對話、工具輸入、原始請求或認證片段。
- [x] 更新相關雙語模型體驗／限制說明與未發布變更紀錄；明確保留描述、schema 最小准入集合仍未完整驗證的界限。
- [x] 保留 0.3.4／DSH 0.2.1-alpha.3、Node 傳輸與宿主工具所有權；不新增 OpenCode／Bun 執行依賴、TLS 仿冒、代理或付費路徑。
- [x] 不宣稱離線 fixture 或暫存 provider 對策等同真實 DSH 工具往返；完整驗收由票 04 完成。

## Context

Parent: 新 inference 准入相容性與單模型相容性驗證規格。

新端點的成功對照只保留官方完整 `read`／`bash` 仍得到 200，但把描述改成佔位文字或 schema 清空各自得到 403；只替換為套件短訊息 input 得到 200。因此單有工具名稱不足，卻也沒有證據要求完整官方系統提示詞或 11 個工具。

尚未取得最小描述／schema 規則，不可把暫存診斷工具定義盲目當成 DSH 工具能力。與票 01、02 共享模組，建議依序實作，但不增加功能依賴。

## Implementation evidence

- 核對實際釘選 npm 產物：[DSH fs](https://registry.npmjs.org/@deepseek-ai/dsh-tool-fs/-/dsh-tool-fs-0.2.1-alpha.3.tgz)、[DSH pwsh](https://registry.npmjs.org/@deepseek-ai/dsh-tool-pwsh/-/dsh-tool-pwsh-0.2.1-alpha.3.tgz)。read 使用 `file_path`；pwsh 要求 `command`、`description`，timeout 單位為毫秒，另保留 workdir／背景／sandbox 欄位。
- 一手參照：[OpenCode read 宣告](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/tool/read.ts)、[read 使用說明](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/tool/read.txt)、[shell schema 與平台使用說明](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/tool/shell/prompt.ts)。說明依 DSH 真實能力調整，不照搬目錄、影像、PDF 或預核准暫存目錄宣告。
- 定義／歷史／SSE／結果成對轉換 file_path/filePath、timeoutMs/timeout、pwsh/bash；不修改輸入。保留 schema 限制與必填 description。keyed 不改寫。
- 無工具請求共用實質補位 schema；設定 tool_choice none，並拒絕上游意外回傳的不可用工具，不交給宿主執行。
- Red → green：新實質 schema／參數名稱測試先失敗後通過；兩檔 37 個離線測試通過。`pnpm run check`：型別、245 個離線測試、建置、打包通過（後續整合變更須再驗）。
- 最小上游描述/schema 集合仍未知；本票只證明離線往返。真實 DSH 匿名驗收仍由票 04 判定。
- 整合 review 後補齊兩 API、stream/streamSimple、main/compat/context 的往返矩陣及 Responses emitted cache/session assertion；後續 toolsRemoved 的補位回歸先紅後綠。最終完整離線測試為 248 個通過。票 04 的 live L1/read/pwsh 另取得成功證據，但 L0 probe 429，未完成嚴格整體驗收。
