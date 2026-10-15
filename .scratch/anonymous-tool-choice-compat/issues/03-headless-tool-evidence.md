Status: resolved
Labels: ready-for-agent

# 03: 以宿主 JSON 事件驗證文字、read 與 pwsh 往返

**Parent:** [功能規格](../spec.md)。

**What to build:** 相容性驗證使用 DSH 0.2.1-alpha.3 正式支援的 headless JSON 事件，證明指定宿主工具實際取得本輪隨機內容。命令與報告能分別呈現文字、read、pwsh 的證據判定，不再只憑 stdout 包含 nonce／雜湊判定工具成功。

**Blocked by:** None (can start immediately).

**User stories:** 27–32、39–42。

## Acceptance criteria

- [x] 既有 headless driver 的執行、事件解析、L1／L2 比對與安全報告接成完整路徑，沿用宿主正式介面，不新增測試專用公開 API。
- [x] L1 要求實際程序退出 0，且本次執行有唯一有效 final 與非空 assistant 文字。一般 session／status／thinking 事件或非空 JSON stdout 不算通過。
- [x] read 呼叫名稱正確，宿主參數指向本輪 nonce 檔案，呼叫 ID 與成功結果配對，工具結果與最終回覆均符合 nonce。
- [x] Windows shell 呼叫必須是還原後的 pwsh，具備宿主必要參數，並針對預定工作目錄執行本輪雜湊命令。呼叫與結果配對，工具結果與最終回覆均符合預期雜湊。
- [x] read 與 shell 使用不同隨機檔案；nonce 與預期雜湊不放進提示。工具結果 completed 本身不足以取代內容比對。
- [x] 路徑依測試工作目錄正規化，接受等價的絕對路徑及平台分隔符號。其他工具取得同一內容不能冒充指定工具通過。
- [x] 缺失、損壞、相關欄位截斷、重複 final、錯誤順序、無法配對的相關事件或內容不符均不算通過。正常額外狀態事件不造成誤判。
- [x] 原始 JSON input／result／text／thinking 僅在記憶體解析。報告只留工具名稱、完成狀態、配對及參數／內容比對判定等安全欄位。
- [x] 離線 fixture 同時走實際 driver 輸出處理與 runner 判定，覆蓋成功 read／pwsh，以及錯工具、錯參數、錯路徑／命令、結果失敗、final／結果不符等案例。
- [x] 保留既有隔離、最低已公布推理等級、無等級 default、有限重試與其他平台 shell 分支；不增加跨平台或所有推理等級成功宣稱。
- [x] 同步文字與工具驗收、事件欄位與資料保護說明。本票可由離線完整往返 fixture 展示，不發 live 推理請求。

## Context

精確宿主版本已提供 tool_call、tool_result、final。工具參數以還原後宿主契約判定：read 使用 file_path；pwsh 要求 description 與 command。L0 直接 provider 探測，不由此票冒充 adapter 證據。適用 A1、C1、Q1–Q4、S1/S2、D1、R4。





## Outcome

headless JSON 已接入 driver 與 runner。缺少工具事件的 nonce 回覆先紅後綠；錯工具、路徑、配對、截斷與 final 等回歸通過。原始事件不落盤。

