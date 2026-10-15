Status: resolved
Labels: ready-for-agent

# 01: 遷移新 inference 端點

**What to build:** 讓工作樹中的 0.3.4 從模型可見性到實際推理都使用新 inference 端點，既有快取不使請求回到舊路徑，傳輸守衛也不干擾其他 provider。

**Blocked by:** None (can start immediately).

## Acceptance criteria

- [x] 保留插件版本 0.3.4、DSH 精確釘選 0.2.1-alpha.3 與對應 pi-ai 契約，不發布、不升級宿主。
- [x] 透過真實 provider 與離線 HTTP fixture 先重現舊端點問題，再驗證 main 與 compat 推理請求使用 `/inference/v1`；模型可用性請求也使用新端點。
- [x] 端點與模型傳輸身份保留單一所有者，不新增各路徑獨立的硬編碼副本或舊路徑成功回退。
- [x] 載入舊快取後，公開目錄／provider 行為仍使用目前端點與身份，同時保留使用者模型隱藏、既有判定與無關資料；不要求清除快取或 profile。
- [x] fetch 與 Node HTTP 守衛只涵蓋指定 HTTPS origin 的精確基底路徑及其子路徑；相似前綴、其他 origin、協定與 port 不被改寫。
- [x] 既有 String、URL、Request 與 Node options 呼叫形式受到適當涵蓋，非目標請求保留原始參數；卸載不移除其他 wrapper。
- [x] 回歸測試採既有公開 provider、目錄與守衛接縫，不直接測私有函式；測試離線、隔離 DSH_HOME 並還原全域及環境。
- [x] 相關測試、型別檢查與建置通過；更新此變更涉及的雙語說明與未發布變更紀錄，區分本地修改與已發布 0.3.4。
- [x] 不宣稱本票已通過上游准入、工具往返或真實 DSH 相容性驗證；其他准入修正與最終驗收由後續票處理。

## Context

Parent: 新 inference 准入相容性與單模型相容性驗證規格。

本票涵蓋規格中的端點、快取身份與守衛作用範圍；上游診斷已證明同一個 Node 請求在舊端點得到 403、新端點得到 200，但只改端點不足以修復整個插件。

前三張票沒有功能依賴，卻會修改同一個 provider 模組，建議依序實作，避免同時修改的整合衝突；這不是額外的 blocking edge。

## Comments

已完成端點、目錄與守衛遷移。快取原本只持久化 models.dev metadata，暖啟動會以目前模板重新派生模型，因此沒有新增 schema 或清除資料。Request 原有認證與自訂標頭保留。

驗證：新回歸測試先出現 4 個失敗，再修正；`pnpm run build`、`pnpm run typecheck` 及 inference-admission／compatibility 共 34 個離線測試通過。雙語 README 與 Unreleased 紀錄已更新。未執行 live 驗證。
