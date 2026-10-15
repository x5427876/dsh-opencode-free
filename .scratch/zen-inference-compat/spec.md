Status: open
Labels: ready-for-human

# 0.3.4：新 inference 准入相容性與單模型相容性驗證

## Problem Statement

使用者無法透過 `dsh-opencode-free` 使用免費模型。現有 0.3.4 仍使用舊 Zen 端點、以雜湊近似 session 的時間區段，並假設匿名請求只要宣告名為 `read` 與 `bash` 的工具就能通過准入。

差分診斷已在 Node 原生 fetch 上證明：相同官方請求換成新端點可由 403 變為 200；有效時間編碼與雜湊時間區段的 session 結果不同；完整工具定義可通過，佔位描述或空 schema 被拒絕。暫存診斷對策已使套件真實 provider 收到非空回覆，但正式插件與真實 DSH 工具往返尚未修復或驗證。

使用者希望保留插件版本 0.3.4 與既有 DSH 精確釘選，支援新的上游准入規則，並跑一次單一模型的相容性驗證。此處的 `compat` 指相容性驗證，不是對話壓縮或上下文整理。

## Solution

讓目前工作樹中的 0.3.4 在不更換 Node 傳輸、不依賴 OpenCode 安裝或真實 API key 的前提下，使用新 inference 端點、有效且穩定的 session 身份，以及不破壞 DSH 執行語意的匿名工具相容處理。

先以離線行為測試鎖住回歸，再以目前工作樹打包的插件，在隔離的 DSH 0.2.1-alpha.3 環境對 `muse-spark-1.3-contributor-free` 執行一輪相容性驗證，包含探測、非空回覆、讀檔與 Windows shell 工具往返。只有實際成功才報告通過；403、429、逾時或空回覆不能由退出碼 0 掩蓋。

本次不發布、不升級使用者的 DSH，也不變更現有 profile 或執行中的 DSH。

## User Stories

1. As a 免費模型使用者, I want 插件請求送往目前可用的新 inference 端點, so that 舊轉發路徑不會使我的請求被拒絕。
2. As a 免費模型使用者, I want 不需要真實 API key 就能走匿名路徑, so that 插件保留原有的免登入使用方式。
3. As a 免費模型使用者, I want 不需要額外安裝 OpenCode 或 Bun, so that 修復不增加新的執行環境前提。
4. As a DSH 使用者, I want 這次修復保留插件版本 0.3.4, so that 工作樹修復與另行授權的發布作業不會混在一起。
5. As a DSH 使用者, I want DSH 相容版本仍精確釘選 0.2.1-alpha.3, so that 上游准入修復不會順便改變宿主契約。
6. As a 免費模型使用者, I want 模型目錄與推理請求使用一致的目前端點, so that 模型雖可見卻走到過期路徑的問題不再發生。
7. As a 已有快取的使用者, I want 舊快取不使請求繼續使用舊端點, so that 更新工作樹後不需要刪掉 profile 或手動清除整份資料。
8. As a 已有模型偏好的使用者, I want 端點遷移保留模型隱藏與既有判定, so that 修復不重設我的模型選擇。
9. As a 長對話使用者, I want 同一 DSH session 的上游身份保持穩定, so that 不會因每個請求更換身份而丟失親和與快取。
10. As a 免費模型使用者, I want session ID 含有效的時間編碼而不是假時間, so that 身份格式相同卻仍被拒絕的回歸能被解除。
11. As a 免費模型使用者, I want 不同 session 不共用同一個上游身份, so that 對話不會互相混用親和識別。
12. As a DSH 使用者, I want session 標頭與 payload 的親和欄位保持一致, so that 修正時間編碼不會製造新的身份不一致。
13. As a 維護者, I want session 身份不需要持久化登入或新增憑證儲存, so that 修復保留既有隱私與安全界限。
14. As a Windows 使用者, I want DSH 的 `pwsh` 工具仍能正常執行, so that 仿冒 CLI 身份不會把 PowerShell 指令錯交給另一種 shell。
15. As a DSH 使用者, I want `read` 的實際參數與讀檔語意被保留, so that 上游准入處理不會讓模型產生 DSH 無法理解的工具呼叫。
16. As a DSH 使用者, I want 發送、回傳與歷史中的工具名稱和參數能正確往返, so that 後續對話與重播不會因工具改寫而失效。
17. As a 呼叫 provider 的開發者, I want 呼叫端的 transcript、工具定義與選項不被原地修改, so that 修復不影響同一份 context 的其他用途。
18. As a 無工具請求的使用者, I want 探測與其他無工具請求具有符合准入要求的補位策略, so that 空 schema 的舊策略不再讓整輪探測被拒絕。
19. As a DSH 使用者, I want 補位工具不被當成真正可執行的宿主工具, so that 通過准入不會以誤執行或虛構工具能力為代價。
20. As a 使用 Zen key 的使用者, I want 原有 key 優先順序與帶 key 請求被保留, so that 匿名路徑的修復不會降級或污染我的認證。
21. As a 使用其他 provider 的使用者, I want 全域 fetch 與 Node HTTP 守衛不碰其他 origin 或相似但不屬於目標的路徑, so that 插件不影響其他連線。
22. As a 使用 direct transport 的開發者, I want main、compat 與既有守衛涵蓋相同的新目標路徑, so that 旁路呼叫不會因修漏一層而仍得到 403。
23. As a 維護者, I want 回歸測試走既有公開 provider 與傳輸接縫, so that 測試能抓到實際請求行為而不是只比對常數。
24. As a 維護者, I want 離線測試不使用網路、不消耗匿名額度、不讀取使用者 profile, so that 日常驗證保持可重複且安全。
25. As a 維護者, I want 單模型相容性驗證使用目前工作樹打包出的插件, so that 驗到的是修復版本而不是 npm 上的既有發布品。
26. As a 維護者, I want 單模型相容性驗證只對指定免費模型發送模型請求, so that 不會意外跑整份目錄而消耗不必要的匿名額度。
27. As a 維護者, I want 暖機與探測也限制在同一模型, so that 單模型模式的額度範圍在所有階段一致。
28. As a 維護者, I want 真實 DSH 取得非空文字回覆, so that HTTP 200 或 provider 層成功不會被誤報為宿主相容。
29. As a 維護者, I want 模型透過 `read` 取得未放進提示的隨機檔案內容, so that 讀檔通過不能由模型猜測或回顯冒充。
30. As a Windows 維護者, I want 模型透過 `pwsh` 計算另一個隨機檔案的雜湊, so that shell 往返與名稱、參數還原確實被驗到。
31. As a 維護者, I want 403、429、逾時與未驗證項目被誠實記錄, so that 沒有真正回覆的單模型測試不會因退出碼 0 被宣稱通過。
32. As a 使用者, I want 測試不啟停我的既有 DSH、不刪除 profile、不更改儲存的憑證, so that 驗證不干擾目前工作。
33. As a 維護者, I want 留存人讀與機器讀的驗證結果, so that 後續可核對插件版本、DSH 版本、模型、測試層級與限制。
34. As a 後續維護者, I want session 身份 ADR 與雙語說明更新, so that 舊的假時間與空工具假設不會再次被當成目前規格。
35. As a 維護者, I want 單模型成功不被推廣成全部模型或所有平台成功, so that 相容性宣稱與實際證據一致。

## Implementation Decisions

- **範圍與版本。** 修復目前工作樹的 0.3.4；保留 DSH 0.2.1-alpha.3 與對應 pi-ai peer 契約，不進行宿主升級或發布。
- **端點單一所有者。** 既有 provider 保持推理端點與身份的單一所有者，目錄可用性請求、模型紀錄、main、compat 與守衛使用新 inference 目標。不要各自新增硬編碼副本或以舊路徑當成功回退。
- **快取相容。** 舊模型紀錄的傳輸身份須在載入／使用時與目前 provider 身份一致，保留使用者隱藏、模型判定與其他無關資料；不要求刪除快取、profile 或憑證。是否需要調整快取 schema，僅由實作時確認的必要性決定。
- **Session 身份。** 採用已取得成功證據的有效 descending 時間編碼；不再把 session 的時間區段填成 SHA-256 片段。相同 DSH session 在目前進程中須維持同一上游身份，不同 session 須區分；不新增持久登入或憑證資料。
- **親和一致。** 既有 session 親和標頭與 payload cache key 在 main 與 compat 路徑保持一致，不能只改 session 標頭卻保留舊 cache key。其他 session 欄位如被保留或新增，亦須使用同一有效身份。
- **Request 身份。** 診斷未證明 request ID 是這次拒絕的必要修正，不順便改變它的策略，除非既有契約需要一致調整且有回歸證據。
- **重審既有 ADR。** 原「雜湊假時間足以通過」的決策前提已被實測推翻，更新或替代該 session 身份決策，保存取捨與診斷依據。模型目錄的 source-of-truth 與相容性驗證不進 CI 的既有決策保持不變。
- **工具准入與執行分離。** 匿名工具相容處理不能只補空 schema 與佔位描述；但也不能把官方完整定義盲目套到 DSH。既有宿主可執行工具的名稱、描述、schema、參數與歷史需作為同一個往返契約處理。
- **Windows 工具語意。** 保留 `pwsh`／`bash` 的既有名稱還原，若准入相容需要額外參數轉換，出站、歷史與回傳必須成對轉換且不變更實際 shell 語意。`read` 同樣不得因 wire schema 改寫而執行錯誤的路徑或範圍。
- **尚未證明的工具細節。** 尚無最小准入描述／schema 的完整規格，也未證明 DSH 原生工具一定被拒絕。實作先核對實際宿主工具；如需準入定義，依已驗證的一手來源選擇最小必要調整，並以往返測試與真實相容性驗證確認。不把猜測的字串匹配規則寫成永久合約。
- **無工具請求。** 探測與既有無工具呼叫共用可接受的補位策略；補位不是新的宿主執行能力，不能允許不存在的工具被誤執行，亦不能重寫使用者對話內容來假裝通過。
- **帶 key 的路徑。** 保留 config、環境變數、匿名 public 的既有優先順序，不把匿名工具變換擴大到帶 key 請求，不覆蓋已解析的有效認證。
- **守衛作用範圍。** 只攔截指定 HTTPS origin 的精確 inference 基底路徑及其子路徑，不能用會匹配其他路徑的裸字串前綴。保留其他請求的原始參數，以及既有卸載與 wrapper 所有權。
- **不引入新傳輸。** 保留 Node 原生傳輸與既有 pi-ai 序列化、SSE 解析，不加入 TLS 仿冒、Bun 執行依賴、代理伺服器或隱藏客戶端證明。
- **相容性驗證。** 沿用既有 compat 流程，指定精確 DSH 版本、唯一模型與工具驗證，在暫存 DSH_HOME 以當前工作樹 tarball 執行。限定匿名路徑；若環境存在真實 key，僅對測試子進程移除，不修改使用者環境或憑證。
- **報告與完成判定。** 新報告不能覆蓋既有未提交的診斷或相容性報告。完成判定要求指定模型的探測、非空回覆、讀檔與 shell 步驟實際通過；退出碼只是補充訊號。
- **文件。** 更新雙語使用說明、未發布變更紀錄、相關身份決策與目前准入說明，清楚區分歷史觀察、推論、離線測試與真實 DSH 證據。0.3.4 已發布品與本地修改的 0.3.4 必須分清楚。
- **聚焦修改。** 遵循架構、型別、相容性、測試、安全與文件的相關工程規則，不順便修復與本次行為無關的既有 gap。

## Testing Decisions

### 接縫

沿用前一輪向使用者提出的三個接縫；使用者要求「開始」後依此整理規格，不再追加訪談或引入新的公開測試介面。

1. **主要接縫：真實 provider + 可注入的離線 HTTP fixture。** 驗證經 pi-ai 序列化後真正送出的 URL、身份、親和與工具宣告，以及 SSE 回傳如何還原成 DSH 工具呼叫。優先從既有 provider 介面觀察，不直接測私有轉換函式。此接縫不能證明實際上游准入或宿主執行成功。
2. **既有傳輸守衛接縫：公開 fetch／Node HTTP 包裝介面。** 驗證 main provider 之外的請求作用範圍、認證保留、原始參數轉交與卸載行為。只補 provider 接縫無法涵蓋的守衛情境，不增加新的一組抽象。
3. **驗收接縫：隔離真實 DSH 的單模型 compat。** 經既有 PiAiAdapter、插件、打包產物與上游完成探測、非空回覆、讀檔與 shell 往返。它不代表現有 web profile、Web UI、Desktop 或所有免費模型已驗證。

### 離線回歸

- 好測試只驗公開可觀察行為；只有外部 HTTP、時間、隨機性與檔案系統使用 fixture，不 mock 私有 gate 或序列化內部函式。
- 每個非平凡修復採 red → green：先以測試證明舊行為不符合要求，再做最小修正。先跑受影響測試，再跑完整離線檢查與打包。
- 端點：模型推理與可用性請求到新路徑；載入舊快取仍使用目前身份，且保留模型偏好與判定。
- Session：時間區段符合固定的一手來源例子，而非把實作算法抄回 assertion；同 session 穩定、不同 session 區分，親和標頭與 cache key 一致；必要時以固定時間或時鐘回撥 fixture 驗證本機身份策略，不聲稱已證明上游長 session 接受範圍。
- 工具：舊 Context 與 normalized transcript 均走到有效工具宣告；DSH 原生 read 與 Windows pwsh 的呼叫參數、歷史與串流回傳可往返；呼叫端輸入不被原地改動。
- 無工具：探測與短訊息不再宣告空 schema／佔位描述；補位不形成宿主可誤執行的能力。fixture 可驗證策略，不能將它當上游永久准入規格。
- 帶 key：原有 key 優先順序與工具保持行為不回歸。
- 守衛：新 inference 路徑有效；相似前綴、其他 origin、協定或 port 不被改寫；String、URL、Request 與 Node options 的既有呼叫形式均受適當涵蓋；卸載不移除其他 wrapper。
- fixture 使用匿名 public 或假 key，不輸出認證片段、對話、工具輸入或原始 request body。預設測試不使用實際網路，隔離 DSH_HOME 並還原全域與環境狀態。
- 沿用既有 provider／adapter 相容性、目錄快取與模型可見性、compat 流程 fixture 的測試風格；不新增涵蓋率門檻或無關測試框架。

### 單模型驗收

- 執行一輪 `pnpm compat --dsh 0.2.1-alpha.3 --model muse-spark-1.3-contributor-free --tools`，以獨立輸出位置留存報告。
- 執行前確認指定模型仍在即時免費交集中、打包產物與宿主版本相符。模型不在列時停止並回報，不自行換模型或改 paid 路徑。
- 「一輪單模型」不是「只發一個 HTTP request」：暖機探測、對話、兩種工具往返及既有有限退避會各自花費匿名額度；其他模型不得被詢問。
- L0：指定模型在目錄與 picker，且本輪探測實際成功。
- L1：經真實 DSH 得到非空文字回覆。
- L2：讀檔 nonce 與 shell 雜湊各自匹配；模型不能從提示取得答案。
- 只在 L0、L1、L2 全部成功時宣稱此次指定模型通過。gate-refused、rate-limited、upstream-down、逾時、空回覆或未驗證不得當成功，即使流程退出碼為 0。
- 保留既有安全退避與分類，不增加無限制重試。上游阻擋時保留 sanitized 證據與未驗證範圍，不靠清除 profile 或重新安裝反覆碰運氣。

## Out of Scope

- 升級 DSH、修改精確 peer 釘選或宣稱支援其他宿主版本。
- 增加版本號、打 tag、發布 npm／GitHub release、安裝到使用者現有 profile。
- 啟動、停止或重啟任何既有 DSH；刪除 profile、修改憑證或清空使用者資料。
- 全免費目錄 live 驗證、其他模型替代測試、逐 reasoning 等級驗證或跨平台支援宣稱。
- 對話壓縮／compaction 的專門 live 驗收；無工具路徑可以有離線回歸，但不宣稱已實測對話壓縮。
- Web UI、Desktop、使用者現有 web profile 的實際運作驗證。
- 把消耗匿名額度的相容性驗證加入 CI。
- TLS／JA3／JA4 仿冒、標頭順序猜測、額外客戶端證明、Bun runtime、代理或 paid route。
- 擴大修復無關工程 gap、重構整個 provider、改變模型目錄政策或增加持久登入機制。
- 宣稱上游要求逐字工具描述、特定最小 schema、ID 時效範圍或永遠不使用傳輸風控；目前證據不支持這些完整規則。

## Further Notes

- 診斷依據：規格撰寫時的 2026-10-14 UTC 本機差分紀錄（既有未提交報告，保留為本機工作資料，不隨此次提交）。該階段只證明 provider 診斷接縫成功，不是正式插件或真實 DSH 已修復。
- 術語依 [CONTEXT](../../CONTEXT.md)：探測是 provider 層面向使用者的輪次；相容性驗證是開發者經真實 DSH 的流程；匿名額度是共享 bucket，不是本機保證可用的額度。
- 需重審的決策：[ADR-0001](../../docs/adr/0001-hashed-session-ids.md)。保留 [ADR-0002](../../docs/adr/0002-catalogue-source-of-truth.md) 的目錄政策與 [ADR-0003](../../docs/adr/0003-compat-run-not-in-ci.md) 的 live／CI 分離。
- 實作遵循 [工程標準](../../docs/standards.md) 與 [gap ledger](../../docs/standards-gap.md)，重點為 A1–A3、C1、Q1–Q5、S1–S3、U1、D1、R2、R4；不因這份規格順便處理無關 gap。
- 複用 [既有 compat 流程](../../docs/compat-run.md)。其退出碼 0 也可能含 gate-refused，故本次驗收明確要求模型實際通過，不以退出碼單獨判斷。
- 上游准入不是第三方承諾；Node 上一次或兩次成功只證明當時的特定模型路徑。若正式實作需不同工具描述／schema，應先補一手依據與往返證據，而不是將暫存診斷定義直接變成宿主工具能力。
- 規格完成不等於程式碼已修改、離線檢查已通過或單模型相容性驗證已執行；這些是後續實作與驗收的工作。

## Implementation outcome

票 01–03 已完成；248 個離線測試、型別／建置／打包與 tarball consumer 檢查通過。唯一授權的隔離單模型 compat 已執行，L1、read nonce、Windows pwsh hash 成功，但 L0 probe 為 HTTP 429，故不宣稱完整驗收通過。

票 04 維持 open / ready-for-human；沒有第二輪，也不會未經另行授權重跑。[嚴格驗收報告](../../docs/compat-reports/zen-inference-2026-10-14-single-model-9c31d7a4/acceptance.md)及相鄰 JSON 保存結果與界限。
