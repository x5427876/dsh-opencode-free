# 04: Key 設定雙路徑文件＋離線驗證

**What to build:** Desktop 走 plugin config、CLI 走環境變數，兩條路寫到
使用者找得到的地方；key 有效性可用不耗聊天額度的方式驗出；分類不斷言
新增耗額度項目（錄製報文離線驗）。

**Blocked by:** 01 (上游失敗分類接縫).

**Status:** resolved

- [ ] 照文件走能在不發聊天的前提下驗出 key 有效／無效
- [ ] 環境變數路徑行為不變（既有設定免動）
- [ ] config 保持非 volatile（改 key 走 HMR 重載）
