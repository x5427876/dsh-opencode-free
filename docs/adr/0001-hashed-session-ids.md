# 用雜湊近似會話 id，不用時間戳

`x-opencode-session` 送 `sha256("opencode-zen-free:<dsh session>")`
映射出的 `ses_` id，而非真 CLI 的時間戳＋單調計數。時間戳要求插件持有
跨請求的可變計數器並處理時鐘回撥與 HMR 重載後的計數漂移；雜湊無狀態、
每會話穩定、會話間不同，已滿足上游的結構檢查。

**Status**: accepted

**Considered Options**:
- 時間戳＋進程內計數器：最像真 CLI，但引入可變狀態，多進程/HMR 下計數漂移。
- 純隨機（每請求新的）：結構合法但丟失會話親和，後端 prompt cache 全廢。
- 雜湊映射（採用）：無狀態、穩定、可重現；代價是時間字段為假（已標推論）。

**Consequences**: 若上游開始驗證時間單調性，全線 403；屆時切時間戳方案。
監控：`scripts/reverify.sh` ②號燈轉紅即重審本決策。
