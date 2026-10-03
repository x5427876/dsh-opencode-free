Status: open
Labels: ready-for-agent

# 相容性驗證（compat run）

相關：`CONTEXT.md`（探測、相容性驗證、匿名額度）、`docs/adr/0003-compat-run-not-in-ci.md`、`docs/adr/0002-catalogue-source-of-truth.md`。

## Problem Statement

每次 DSH 發新版，開發者都要回答同一個問題：Zen 提供的所有免費模型，在這個 DSH 版本搭配本插件時，還能不能用？

現在沒有可重複的做法。外掛內建的**探測（probe）**和 `scripts/test-live.mjs` 都直接呼叫 provider，沒經過 DSH，測不到「DSH 升級後 `PiAiAdapter` → 外掛」這一段，而升級最常壞的就是這段（rc.2 時 `context.tools` 被靜默丟棄，匿名請求變成 403）。目前的實機驗證是手動拼裝的：自己裝 DSH、自己建隔離環境、自己補服務、自己逐一指定模型，過程依賴個人機器，結果也無法比對。

另外，匿名額度（按出口 IP 共用）很脆弱：外掛啟動時的自動探測加上少數幾次呼叫就會耗盡，之後所有結果都是 429，分不清是外掛壞了還是額度乾了。

## Solution

提供一個單一指令的**相容性驗證**：指定一個 DSH 版本，它在隔離環境裡安裝該版本與目前 repo 打包出的外掛，逐一對 Zen 提供的全部免費模型，經過真實 DSH 送一則最低思考等級的請求，並產出一份矩陣報告，說明每個模型的結果與原因。

結果分成可行動的類別：模型正常、額度用完（不確定）、上游說模型不可用、閘門拒絕、外掛或 DSH 端的錯。只有「外掛或 DSH 端的錯」讓流程失敗；額度造成的未驗完用獨立的退出碼表示「沒壞，稍後再跑」。任何開發者只需要 Node 和 pnpm，不需要 key，也不會碰到自己的 `~/.dsh`。

## User Stories

1. As a 外掛維護者, I want to 指定一個 DSH 版本並一次驗證所有免費模型, so that 每次 DSH 升級我都能用同一個流程判斷插件是否還相容
2. As a 外掛維護者, I want 驗證經過真實的 DSH 而不是直接呼叫 provider, so that `PiAiAdapter` 到外掛這一段的回歸能被抓到
3. As a 外掛維護者, I want 版本參數必填且沒有預設值, so that 我不會悄悄驗到錯的 DSH 版本
4. As a 外掛維護者, I want 當 `package.json` 的 peer 釘選與指定的 DSH 版本不一致時流程立刻停止並說明, so that 我不會在注定被 DSH 略過的組合上浪費額度
5. As a 外掛維護者, I want 驗證用目前 repo 打包出的外掛，而不是 npm 上已發布的版本, so that 我驗到的就是準備發布的東西
6. As a 外掛維護者, I want 驗證在暫存的隔離環境執行, so that 我現有的 `~/.dsh` profile 和正在運行的 DSH 完全不受影響
7. As a 外掛維護者, I want 流程不啟動、停止或重啟任何既有的 DSH, so that 符合專案對安裝與驗證的安全規則
8. As a 外掛維護者, I want 跑完自動清掉暫存環境, so that 不會在機器上留下大量檔案
9. As a 外掛維護者, I want 一個 `--keep` 選項保留暫存環境, so that 結果可疑時我能進去除錯
10. As a 外掛維護者, I want 流程自己挑空閒的本機埠並只綁 127.0.0.1, so that 不會跟我正在跑的 DSH 衝突，也不會暴露到網路
11. As a 外掛維護者, I want 流程補上外掛所需的 `webServer` 服務, so that 外掛能在 headless 下啟用而不必改外掛本身
12. As a 外掛維護者, I want 驗證的模型清單來自即時資料（Zen 的模型列表與 models.dev 標為免費者的交集）, so that 剛上架、外掛內建清單還沒更新的模型也會被驗到
13. As a 外掛維護者, I want 報告列出「內建清單有、即時清單沒有」的模型, so that 我知道哪些模型已被下架或需要更新內建清單
14. As a 外掛維護者, I want 每個模型都用它自己發布的最低 effort 等級送請求, so that 外掛的 reasoning 轉換路徑也被走到
15. As a 外掛維護者, I want 沒有發布等級的模型（toggle 型或無清單）用預設並在報告標示「無等級可選」, so that 我知道這個模型沒驗到 reasoning 轉換
16. As a 外掛維護者, I want 每個模型驗證時要求非空的文字回覆, so that 「連線成功但沒內容」不會被當成通過
17. As a 外掛維護者, I want 每個模型在獨立的進程中驗證, so that 一個模型的失敗或掛起不會影響其他模型
18. As a 外掛維護者, I want 驗證前先做一次暖機，讓外掛的自動探測跑完, so that 之後各模型的進程不會再各自觸發探測而多耗額度
19. As a 外掛維護者, I want 暖機的探測結果當作 L0（模型在 DSH picker 中且在 Zen 列表裡）的資料, so that 暖機花掉的額度不是浪費
20. As a 外掛維護者, I want 流程不讀外掛內部快取檔的格式, so that 外掛改快取格式時驗證流程不會跟著壞
21. As a 外掛維護者, I want 模型之間有固定的間隔, so that 不會用突發流量加速耗盡匿名額度
22. As a 外掛維護者, I want 遇到 429 時退避後重試有限次數, so that 暫時的限流不會直接變成「未驗證」
23. As a 外掛維護者, I want 連續多個模型都回 429 時整輪中止, so that 額度已乾時不再繼續消耗
24. As a 外掛維護者, I want `rate-limited` 的模型標成「不確定」，既不是通過也不是失敗, so that 額度問題不會被誤認為外掛壞了，也不會被誤認為已驗證
25. As a 外掛維護者, I want 上游明確說模型不可用（例如 Model/Endpoint is unavailable、500）時標成 `upstream-down`, so that 上游問題和外掛問題分得開
26. As a 外掛維護者, I want 閘門 403 標成 `gate-refused`, so that 我知道是 Zen 的准入政策變了，需要重審 bypass
27. As a 外掛維護者, I want `NO_ADAPTER`、外掛沒啟用、回覆格式壞掉等標成 `plugin-fault`, so that 真正需要修的問題一眼可見
28. As a 外掛維護者, I want 只有 `plugin-fault` 讓退出碼為 1, so that 上游的問題不會讓流程永遠是紅的
29. As a 外掛維護者, I want 有模型是 `rate-limited` 或未驗證時退出碼為 2, so that 我知道「沒壞，但沒驗完，稍後再跑」
30. As a 外掛維護者, I want 同時有 `plugin-fault` 與未驗完時退出 1, so that 真正的失敗優先於「沒驗完」
31. As a 外掛維護者, I want 全部驗過且沒有 `plugin-fault` 時退出 0, so that 腳本可以被其他流程當成通過訊號
32. As a 擁有 Zen key 的開發者, I want 設了 `OPENCODE_API_KEY` 時，對匿名結果是 `rate-limited` 或 `gate-refused` 的模型補跑一次帶 key 的對照, so that 能區分「外掛壞了」與「額度乾了或閘門變了」
33. As a 沒有 key 的開發者, I want 流程完全不需要 key 也能執行, so that 任何人都能驗證
34. As a 外掛維護者, I want 帶 key 的對照只在需要時才跑, so that 匿名路徑（外掛最核心的承諾）仍是驗證主體，不被 key 路徑掩蓋
35. As a 外掛維護者, I want 一個選用的 `--tools` 旗標做工具往返驗證（L2）, so that 閘門與工具名稱映射的回歸能被抓到，而預設流程仍然快
36. As a 外掛維護者, I want 工具往返用每次隨機產生的 nonce 判定, so that 模型編一個答案不會被誤判為通過
37. As a 外掛維護者, I want `read` 與 shell 兩步各自判定並在報告中標明是哪一步失敗, so that 我知道是檔案讀取還是 shell 名稱映射出了問題
38. As a Windows 開發者, I want shell 那一步走 `pwsh`、其他平台走 `bash`, so that 工具名稱映射在各平台都被驗到
39. As a 外掛維護者, I want 預設只把報告印到終端並把 JSON 寫到暫存目錄, so that 一般執行不會弄髒我的工作區
40. As a 外掛維護者, I want 用 `--out` 才把報告寫進 repo, so that 我要留存某次升級的證據時可以明確選擇
41. As a 外掛維護者, I want 報告檔頭固定記錄 DSH 版本、外掛版本、日期、作業系統與是否帶 key, so that 一份報告脫離上下文也看得懂
42. As a 外掛維護者, I want 報告同時有人讀的矩陣與機器讀的 JSON, so that 我能閱讀也能比對不同版本的結果
43. As a 外掛維護者, I want 報告對每個模型寫出判定、驗到哪一層、使用的思考等級與失敗原因, so that 不用重跑就能知道為什麼
44. As a 外掛維護者, I want 報告明確列出「未驗證」的模型, so that 沒驗到的部分不會被當成通過
45. As a 外掛維護者, I want 相容性驗證不進 CI, so that 結果不受同一出口 IP 上別人的用量影響（見 ADR 0003）
46. As a 外掛維護者, I want `AGENTS.md` 的 DSH 升級流程把相容性驗證列為發版前必跑, so that 這個流程不靠記憶
47. As a 外掛維護者, I want 前置條件只有 Node 與 pnpm, so that 流程在 Windows、macOS、Linux 上都能跑
48. As a 後來接手的開發者, I want 流程的術語與 `CONTEXT.md` 一致（探測 ≠ 相容性驗證）, so that 我不會把兩套機制搞混
49. As a 外掛維護者, I want 驗證流程不依賴外掛的 `webServer` 硬依賴是否被修掉, so that 這兩件事可以各自演進

## Implementation Decisions

- **一個入口，一個核心。** 流程的邏輯集中在一個核心函式 `runCompat(options, deps)`，輸入為選項與注入的依賴，輸出為報告物件與退出碼。命令列腳本只是薄薄一層：解析參數、接上真實依賴、印出報告。
- **選項**：DSH 版本（必填、無預設）、`--tools`、`--keep`、`--out <dir>`，以及是否帶 key（由環境變數 `OPENCODE_API_KEY` 偵測，不是選項）。
- **注入的依賴**有三個：取得即時模型清單、在隔離環境對單一模型跑一次 headless 並回傳 stdout/stderr/退出碼的驅動器、`sleep`。真實版本分別接上 Zen 與 models.dev、真實的 DSH 進程、真實計時。
- **前置檢查先於任何安裝或請求。** peer 釘選與指定版本不符，直接以明確訊息結束，不進入驗證，也不消耗額度。
- **隔離環境。** 在系統暫存目錄安裝指定版本的 DSH，並把 `DSH_HOME` 指到暫存目錄；對目前 repo 打包外掛並裝進隔離的 `headless` profile。不碰使用者的 `~/.dsh`。預設結束時清除，`--keep` 保留。
- **驅動 DSH 的方式**：隔離 `DSH_HOME` + 內建 `headless` profile + 以 `--patch` overlay 補上 `webServer` 服務（自選空閒埠、綁 127.0.0.1），同時以 overlay 指定預設模型與 `reasoningEffort`。路徑與 web 相同，都經過 `PiAiAdapter`，但不是使用者實際使用的 profile；這個差異要寫進報告的說明。
- **暖機。** 先用一個進程讓外掛的每日探測跑完。其結果作為 L0 的資料來源，並使後續各模型進程不再觸發探測。暖機結果透過 DSH 與外掛的公開行為取得，不讀外掛內部快取檔的格式。
- **模型清單**：Zen 模型列表 ∩ models.dev 標為免費者。報告同時列出內建清單與即時清單的差異。
- **驗證層級**：L0（在 picker 且在 Zen 列表）與 L1（經 DSH 取得非空文字回覆）為預設；L2（`read` 與 shell 工具往返）由 `--tools` 開啟；不做逐等級的驗證（L3）。
- **最低思考等級**：取每個模型 `thinkingLevelMap` 中有發布的最低 effort 等級。沒有發布等級的模型使用預設，並在報告標示「無等級可選」。
- **判定分類**：`ok`、`rate-limited`、`upstream-down`、`gate-refused`、`plugin-fault`。`rate-limited` 為不確定，不算通過也不算失敗；`upstream-down` 與 `gate-refused` 只進報告；只有 `plugin-fault` 使退出碼為 1。
- **退出碼優先序**：有 `plugin-fault` 為 1；否則有 `rate-limited` 或未驗證為 2；否則為 0。
- **限速與退避**：模型之間間隔 3 秒；遇到 429 依序退避 30 秒、60 秒各重試一次，仍為 429 則標 `rate-limited`；連續 3 個模型都 429 即中止整輪，剩餘模型標未驗證。整輪不設總等待上限。暖機探測回答 `ok` 的模型先驗、其餘依 Zen 順序在後（2026-10-03 實測：Zen 順序的前 3 個模型退避後仍 429，而暖機剛看到另外 5 個模型正常回覆；連續 429 規則在問到這 5 個之前就中止了整輪）。
- **帶 key 的對照**：匿名為主。僅在偵測到 `OPENCODE_API_KEY` 且匿名結果為 `rate-limited` 或 `gate-refused` 時，對該模型補跑一次帶 key 的請求並在報告中並列。
- **工具往返（L2）**：在隔離目錄建一個內容為隨機 nonce 的檔案，要求模型讀取並回覆其內容；再要求執行一個 shell 指令（Windows 用 `pwsh`、其他平台用 `bash`），印出另一個隨機 nonce 檔的 SHA-256 前 16 碼；nonce 不寫進提示，模型不跑指令就無從得知答案。回覆包含對應值（不分大小寫）才算該步通過；兩步各自判定並分別報告。
- **報告**：人讀的矩陣加機器讀的 JSON。檔頭記錄 DSH 版本、外掛版本、日期、作業系統、是否帶 key。預設印到終端並把 JSON 寫到暫存目錄；`--out` 才寫進 repo。
- **執行環境**：只需要符合 `engines` 的 Node 與 pnpm；以 Node 的子進程介面呼叫，不使用 shell 專屬語法，三個平台一致。
- **文件**：`AGENTS.md` 的 DSH 升級流程加入「發版前必跑相容性驗證」；`README` 或維護者文件說明如何執行與判讀退出碼。`CONTEXT.md` 已定義兩個術語，ADR 0003 已記錄「不進 CI、429 為不確定」。
- **既有機制不動**：外掛內建探測、`scripts/test-live.mjs`（provider 層、語意不同）、外掛的 `webServer` 硬依賴都不在這次修改範圍。

## Testing Decisions

- **好測試的標準**：只驗外部行為，也就是給定選項與依賴的回應，核心函式回傳的報告與退出碼；不驗內部呼叫順序、不驗私有輔助函式。
- **只有一個 seam：`runCompat(options, deps)`。** 取得模型清單、單一模型的 headless 驅動器、`sleep` 都由測試注入假的實作；因為 `sleep` 被注入，退避與間隔的測試不需要真的等待。
- **要覆蓋的行為**：
  - peer 釘選不符就停，且不呼叫驅動器、不消耗任何請求。
  - 判定分類：`ok`、`rate-limited`、`upstream-down`、`gate-refused`、`plugin-fault` 各自由哪些輸出觸發。
  - 429 退避：30 秒、60 秒各一次，仍 429 則 `rate-limited`；連續 3 個模型 429 即中止，剩餘模型標未驗證。
  - 退出碼 0、1、2 及其優先序。
  - 最低 effort 等級的選取，以及沒有發布等級時的「無等級可選」。
  - 即時清單與內建清單的差異出現在報告中。
  - 有 key 時只對 `rate-limited` 與 `gate-refused` 的模型補跑對照，沒有 key 時完全不補跑。
  - `--tools` 時兩步工具往返各自判定；nonce 不符不算通過。
  - 報告檔頭欄位齊全，`--out` 才有寫入 repo 的動作。
  - 暖機結果成為 L0 資料，且各模型進程之後不再重複探測。
- **真實 DSH 與 Zen 不進自動測試**，依 ADR 0003 它不進 CI。它靠一次手動的實機執行驗證，結果記在驗收說明裡。
- **前例**：`tests/compatibility.test.mjs` 以注入的 `fetch` fixture（`gate(429, …)` 一類）測請求路徑與失敗分類；本流程沿用同樣的「注入依賴、不打真實上游」風格。

## Out of Scope

- 把相容性驗證接進 CI（ADR 0003 已決定不做）。
- 修改外掛對 `webServer` 的硬依賴使其可選；另開 issue 追蹤。
- 逐一驗證每個模型的每個思考等級（L3）。
- 透過 `web` profile 的 HTTP/WebSocket 協議驅動 DSH。
- 修改或取代外掛內建探測與 `scripts/test-live.mjs`。
- 自動修復 `upstream-down` 或 `gate-refused`；流程只負責報告。
- 持久儲存歷次報告或做跨版本的趨勢比較（`--out` 只是讓維護者自行留存）。

## Further Notes

- **三個設計時留下的假設已於 2026-10-03 實機確認**（見 `issues/01-verify-design-assumptions.md` 的 Answer；暖機經外掛面板路由 `POST /refresh`、`POST /probe`、`GET /probe`、`GET /catalog` 取得）：
  1. 在 overlay 補上 `webServer` 服務後，headless 進程能穩定啟用外掛。先前實機只做到被 429 擋下，沒有拿到過完整的模型回覆。
  2. 暖機進程的探測結果可以不讀外掛內部快取檔就取得。
  3. 以最低 effort 等級送出的請求，Zen 不會回 `UNSUPPORTED_REASONING_EFFORT`。
- **額度風險**：驗證本身消耗匿名額度（暖機一輪加每個模型至少一次請求）。若機器的匿名額度已乾，第一次實測只能得到 `rate-limited`，此時只驗得到 L0。實作時要先用 fixture 驗證判定邏輯，再用真實額度做一次實機驗證，並在額度不足時誠實回報而不是宣稱通過。
- **已知的上游壞模型**：先前實測中 Ling 3.0 回 `Endpoint is unavailable`，屬上游問題；它應被歸為 `upstream-down`，不應造成失敗。
- 隔離的 `headless` profile 不是使用者實際用的 profile；報告需註明驗證路徑，避免被誤讀成「web UI 已驗證」。
