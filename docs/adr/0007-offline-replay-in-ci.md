# 離線重播進 CI，生產程式碼不留端點覆寫

離線重播（`pnpm replay`）在 CI 跑，與 [ADR 0003](0003-compat-run-not-in-ci.md) 不衝突：
0003 排除的是會消耗共用匿名額度的真實請求；重播把 `opencode.ai` 導向本機的假上游，
不會有任何請求到 Zen，結果不取決於出口 IP 上別人的用量，可重現。

**Status**: accepted

**Decision**:
- CI 另開一個 `replay` job，用 Node 24（無頭 DSH 要求 >= 24.9，高於 `check` job 的 22），
  DSH 版本取自 `package.json` 的 peer pin，升級時不必另改 workflow。
- 不在生產程式碼加端點覆寫（環境變數或設定）。`BASE_URL` 固定為
  `https://opencode.ai/inference/v1`；重播改在插件之下重導：測試專用的 preload 改寫
  `tls.connect`，並以 `NODE_EXTRA_CA_CERTS` 信任拋棄式 CA。

**Considered Options**:
- 加 `BASE_URL` 覆寫：實作最簡單，但會在使用者的安裝裡多出一個可把請求與憑證
  導向任意主機的開關。拒絕。
- 重播不進 CI：升級 DSH 時才發現壞掉，且靠人記得跑。拒絕。
- 在插件之下重導、進 CI（採用）：代價是 preload 依賴 Node 的 `tls.connect` 行為，
  需要 `openssl` CLI 和 npm registry。

**Consequences**:
- 重播的 DSH 以 npm 安裝，CI 會因 registry 故障而紅，那是環境問題，不是插件問題。
- 假上游不能重現真實閘門的准入檢查，重播不取代 compat run。
- 驅動程式在送出 probe 前，必須確認插件自己的模型清單請求到了假上游；否則中止，
  避免重導失效時把請求送到真實 Zen。
