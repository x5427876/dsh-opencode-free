Status: resolved
Labels: ready-for-agent
Blocked by: 10

# 11: 在 DSH `0.2.1-alpha.1` 上做一次完整實機驗證

Spec: `../spec.md`

## What to build

用做好的相容性驗證，對 DSH `0.2.1-alpha.1` 搭配目前的外掛版本跑一次完整的實機驗證，這也是原本卡住的「確認所有模型可用」的答案。

- 以 `--dsh 0.2.1-alpha.1` 對全部免費模型執行；時間與額度允許時加 `--tools`。
- 用 `--out` 把報告存成留存證據。
- 結果如實記錄：額度不足時，被擋的模型標 `rate-limited`、沒輪到的標未驗證，**不宣稱通過**。退出碼 2 就是「沒驗完」，要說明。
- 若出現 `plugin-fault`，附上原因並另開票處理，不在本票內修外掛。
- `upstream-down`（例如 Ling 3.0 的 Endpoint is unavailable）只記錄，不視為外掛問題。

這張票依賴匿名額度，可能需要等額度恢復後重跑；在拿到完整結果之前保持 open。

## Acceptance criteria

- [ ] 實機執行完成，退出碼已記錄並解釋
- [ ] 報告已用 `--out` 存檔，檔頭含 DSH 版本、外掛版本、日期、作業系統、是否帶 key
- [ ] 每個免費模型都有判定與驗到的層級；未驗證者明確列出
- [ ] 沒有 `plugin-fault`，或每個 `plugin-fault` 都有對應的後續票
- [ ] 結論如實寫進 `## Answer`，沒有把 `rate-limited` 或未驗證寫成通過

## Answer

2026-10-03 13:44Z，`pnpm compat --dsh 0.2.1-alpha.1 --tools --out docs/compat-reports`（Windows 11、Node v24.13.0、外掛 `0.3.1` 由目前 repo 打包、匿名、無 key）。報告：`docs/compat-reports/compat-0.2.1-alpha.1-2026-10-03.md` 與同名 `.json`，檔頭含 DSH 版本、外掛版本、日期、作業系統、key: no、tools: on 與驗證路徑。

**退出碼 0**：全部模型都有判定，沒有 `plugin-fault`、沒有 `rate-limited`、沒有未驗證。

- 11 個 `ok`，全部到 **L2**（`read` 與 `pwsh` 兩步都通過）：big-pickle、muse-spark-1.3-contributor-free、muse-spark-1.2-contributor-free、mimo-v2.6-flash-free、space-bunny-free、longcat-2.5-preview-free、mimo-v2.5-free、nemotron-3-ultra-free、fledge-alpha-free、ling-3.1-flash-free、nemotron-3.5-lightning-free。有發布等級的模型用最低等級送出（muse-spark 為 `minimal`、space-bunny 與 fledge 為 `low`），都沒有 `UNSUPPORTED_REASONING_EFFORT`。其餘標「無等級可選」，表示這些模型沒有驗到 reasoning 轉換。
- 2 個 `upstream-down`（只停在 L0）：`deepseek-v4-flash-free`（`Upstream request failed: Model is unavailable`，暖機探測 HTTP 500）、`ling-3.0-flash-fin-free`（`Endpoint is unavailable`，與先前 Ling 3.0 的上游問題相同）。屬上游問題，不需另開外掛票。
- `ling-3.1-flash-free` 的 L1 第一次被 429，退避 30 秒後成功，所以實機上也走到了退避路徑。
- 暖機探測中 `nemotron-3.5-lightning-free` 標 `timeout`，但經 DSH 的 L1/L2 都通過。探測的逾時不是外掛相容性問題，這裡只做紀錄。
- 清單差異：即時清單比內建清單多 6 個（deepseek-v4-flash-free、space-bunny-free、longcat-2.5-preview-free、mimo-v2.5-free、fledge-alpha-free、ling-3.1-flash-free），沒有「內建有、即時沒有」的模型。

限制：驗證路徑是隔離的 `headless` profile 加 overlay，不是 web UI；只在 Windows 上執行；匿名結果反映這台機器在這個時間點的額度狀況。
