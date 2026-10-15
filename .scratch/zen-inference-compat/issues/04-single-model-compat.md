Status: open
Labels: ready-for-human

# 04: 打包並完成單模型相容性驗證

**What to build:** 以目前工作樹的 0.3.4 打包產物，在隔離 DSH 0.2.1-alpha.3 中驗證指定免費模型的探測、非空回覆、讀檔與 Windows shell 往返，留存誠實且可核對的結果，不干擾使用者現有環境。

**Blocked by:** 01 遷移新 inference 端點；02 有效且穩定的 session 身份；03 匿名工具准入與 DSH 往返相容。

## Acceptance criteria

- [x] 票 01、02、03 完成後，完整型別、離線行為測試與建置／打包檢查通過；驗證 tarball 可用，並確認不包含憑證、快取或私有診斷資料。
- [x] 套件仍為本地修改的 0.3.4，宿主及 peers 精確對應 DSH 0.2.1-alpha.3；不把本地產物等同 registry 上已發布的同版本內容。
- [x] 執行前透過公開即時清單確認 `muse-spark-1.3-contributor-free` 仍在免費模型交集中；模型不在列則停止回報，不自行換模型或改付費路徑。
- [x] 沿用既有 compat 流程，執行一輪指定 DSH 版本、唯一模型且啟用工具往返的相容性驗證；暖機與探測也只詢問此模型，不暗中驗整份目錄。
- [x] 使用暫存 DSH_HOME、內建 headless profile 與當前工作樹 tarball，走真實 PiAiAdapter → 插件路徑；測試子進程限定匿名 public，不讀取使用者憑證或改變父進程環境。
- [x] 若環境已有真實 Zen key，只對測試子進程移除；不啟用帶 key 對照來掩蓋匿名結果。
- [ ] L0 必須確認指定模型在 picker／可用性清單，且本輪探測實際成功。
- [x] L1 必須經真實 DSH 取得非空文字回覆；只有 HTTP 200、正常啟動或 provider 層成功不算通過。
- [x] L2 的讀檔結果須匹配未放進提示的隨機 nonce；Windows `pwsh` 須算出另一個隨機檔案的雜湊，兩步各自判定並記錄。
- [x] 僅當 L0、L1、讀檔與 shell 全部成功才宣稱指定模型通過；403、429、上游不可用、逾時、空回覆或未驗證都不算成功，即使既有退出碼為 0。
- [x] 沿用既有有限退避與分類，不增加無限制重試；上游拒絕或額度不足時留存 sanitized 訊號與未驗證事項，不靠刪 profile 或反覆安裝碰運氣。
- [x] 新的 Markdown 與 JSON 報告使用不覆蓋既有資料的輸出位置，記錄日期、OS、Node、DSH、插件、模型、匿名路徑、最低 effort、各步結果與退出碼。
- [x] 報告不包含認證片段、對話、工具輸入或原始 request body；明確區分型別、離線 fixture、產物與真實宿主 live 證據。
- [x] 不啟動、停止或重啟既有 DSH，不修改或刪除使用者 profile、憑證及無關插件；清理本票建立的暫存環境，不刪除預先存在的檔案。
- [x] 完成對整合 diff 的 Standards／Spec 檢查並處理本次變更造成的問題；既有無關工程 gap 不擴大修復。
- [x] 驗收說明及必要文件同步記錄實際結果；一個模型在隔離 headless 成功不能被推廣成全部模型、Web UI、Desktop、既有 web profile 或跨平台已驗證。
- [x] 不升級版本、不打 tag、不發布、不安裝至使用者 profile；不把本輪 compat 當成對話壓縮／compaction 的專門 live 驗證。

## Context

Parent: 新 inference 准入相容性與單模型相容性驗證規格。

使用者已授權一次單模型相容性驗證，包含工具往返。「一輪」不是一個 HTTP request：暖機、對話、讀檔、shell 與既有有限退避會消耗匿名額度，但其他模型不可被詢問。

既有 compat 的退出碼 0 可能包含 gate-refused 或 upstream-down，故本票以實際 L0／L1／L2 結果為完成依據。若准入或工具往返失敗，修正相應前置票並重跑必要的離線回歸；後續額外 live 輪次須另外取得授權，不宣稱本輪通過。

## Outcome — incomplete, requires separate authorization

- [Strict acceptance report](../../../docs/compat-reports/zen-inference-2026-10-14-single-model-9c31d7a4/acceptance.md) and adjacent JSON record the single authorized round, 2026-10-14T23:58:52.444Z.
- Windows 10.0.26200 x64 / Node v24.13.0 / isolated DSH 0.2.1-alpha.3 / local 0.3.4 tarball / anonymous public / minimal effort. Public free intersection and picker membership confirmed; warmup asked exactly one model.
- L0 probe: quota-exhausted, HTTP 429 — **not passed**. Warmup setup itself succeeded.
- L1 nonempty DSH reply, L2 read nonce, and L2 Windows pwsh hash: passed with existing bounded backoff. Compat exit code 0 and its row ok/L2 do not override the failed L0 requirement.
- No additional round was run. Ticket remains open/ready-for-human solely for authorizing a later quota-consuming verification; do not claim full acceptance or automatically retry.
- `pnpm run check`: typecheck/build/248 offline tests/pack passed. Tarball's 14-entry allowlist, extracted runtime/type consumer, client syntax and patch/export paths passed; actual DSH installed this working-tree tarball.
- Driver-owned temp environment was removed and absence verified; no existing DSH/profile/credentials changed, no release/tag/publication. Existing uncommitted reports and .env.local remain excluded from this commit.
- Standards/Spec review found and fixed the later-toolsRemoved admission bug with a red → green fixture. Added both APIs, both stream methods, main/compat/context matrix and emitted cache-key/session assertions. Model error summaries retain allowlisted signals, not echoed tool inputs or conversation content.
- Final parallel review: Standards found no new blocking documented breach; Spec found no new blocking code issue, with the L0 acceptance gap explicitly retained. Its checklist-status note was corrected here. Fragmented JSON argument fixtures were also added to both SSE channels and passed without further production changes or live requests.
