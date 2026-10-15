# GitHub Issues 遷移索引

> 歷史對照；下列狀態只代表遷移當時，不代表目前 Issue 狀態。
> 日常工作使用[現行 GitHub 流程](../agents/issue-tracker.md)。

日期：2026-10-15。來源提交：`8e7b0b434e126ae657c0b50cd6820ab788964cb5`。

遷移 4 份規格與 25 張正式票，共 29 個 Issues。逐一核對標題、完整本文、狀態與標籤。
原本 resolved 的 23 張票保持關閉；其餘 6 個項目保持開啟。
其中 v0.2 規格原本未記錄狀態，不推定完成。原本開啟的父規格不因子票已完成而自動關閉。

父子關係：25/25 使用 GitHub 原生 sub-issues。
相依關係：29/29 使用 GitHub 原生 issue dependencies；完整阻擋關係也列於各票本文。
正式規格與票以 GitHub 為準。遷移完成後，本地 `.scratch/` 目錄與全部 30 份連結／說明檔已移除。
下表的原檔路徑僅作歷史索引，不代表檔案仍存在；請直接開啟對應的 GitHub Issue。
舊 drafts 目錄共 6 個 Markdown 檔已依使用者要求移除，沒有建立重複 Issues。

本次沒有推送程式碼或分支。Issues 中的原始碼與證據路徑指向本地來源提交，不宣稱未推送的檔案可從 GitHub 開啟。
遷移不改寫既有驗收結果；全模型驗收仍待官方分類資料完整。

## 對照

| 原檔 | GitHub Issue | 遷移時狀態 |
| --- | --- | --- |
| `.scratch/anonymous-tool-choice-compat/spec.md` | [#9](https://github.com/x5427876/dsh-opencode-free/issues/9) | open |
| `.scratch/anonymous-tool-choice-compat/issues/01-anonymous-tool-choice.md` | [#10](https://github.com/x5427876/dsh-opencode-free/issues/10) | closed |
| `.scratch/anonymous-tool-choice-compat/issues/02-official-dynamic-targets.md` | [#11](https://github.com/x5427876/dsh-opencode-free/issues/11) | closed |
| `.scratch/anonymous-tool-choice-compat/issues/03-headless-tool-evidence.md` | [#12](https://github.com/x5427876/dsh-opencode-free/issues/12) | closed |
| `.scratch/anonymous-tool-choice-compat/issues/04-strict-round-verdict.md` | [#13](https://github.com/x5427876/dsh-opencode-free/issues/13) | closed |
| `.scratch/anonymous-tool-choice-compat/issues/05-packed-full-model-acceptance.md` | [#14](https://github.com/x5427876/dsh-opencode-free/issues/14) | open |
| `.scratch/compat-run/spec.md` | [#15](https://github.com/x5427876/dsh-opencode-free/issues/15) | open |
| `.scratch/compat-run/issues/01-verify-design-assumptions.md` | [#16](https://github.com/x5427876/dsh-opencode-free/issues/16) | closed |
| `.scratch/compat-run/issues/02-core-skeleton-peer-pin-l1.md` | [#17](https://github.com/x5427876/dsh-opencode-free/issues/17) | closed |
| `.scratch/compat-run/issues/03-verdicts-and-rate-limit.md` | [#18](https://github.com/x5427876/dsh-opencode-free/issues/18) | closed |
| `.scratch/compat-run/issues/04-live-catalogue-and-min-effort.md` | [#19](https://github.com/x5427876/dsh-opencode-free/issues/19) | closed |
| `.scratch/compat-run/issues/05-warmup-and-l0.md` | [#20](https://github.com/x5427876/dsh-opencode-free/issues/20) | closed |
| `.scratch/compat-run/issues/06-report-output.md` | [#21](https://github.com/x5427876/dsh-opencode-free/issues/21) | closed |
| `.scratch/compat-run/issues/07-key-comparison.md` | [#22](https://github.com/x5427876/dsh-opencode-free/issues/22) | closed |
| `.scratch/compat-run/issues/08-tools-roundtrip.md` | [#23](https://github.com/x5427876/dsh-opencode-free/issues/23) | closed |
| `.scratch/compat-run/issues/09-real-driver-and-isolation.md` | [#24](https://github.com/x5427876/dsh-opencode-free/issues/24) | closed |
| `.scratch/compat-run/issues/10-docs-and-upgrade-flow.md` | [#25](https://github.com/x5427876/dsh-opencode-free/issues/25) | closed |
| `.scratch/compat-run/issues/11-live-acceptance-alpha1.md` | [#26](https://github.com/x5427876/dsh-opencode-free/issues/26) | closed |
| `.scratch/v0.2/spec.md` | [#27](https://github.com/x5427876/dsh-opencode-free/issues/27) | open |
| `.scratch/v0.2/issues/01-failure-classification-seam.md` | [#28](https://github.com/x5427876/dsh-opencode-free/issues/28) | closed |
| `.scratch/v0.2/issues/02-catalog-freshness-policy.md` | [#29](https://github.com/x5427876/dsh-opencode-free/issues/29) | closed |
| `.scratch/v0.2/issues/03-request-path-guidance.md` | [#30](https://github.com/x5427876/dsh-opencode-free/issues/30) | closed |
| `.scratch/v0.2/issues/04-key-setup-paths.md` | [#31](https://github.com/x5427876/dsh-opencode-free/issues/31) | closed |
| `.scratch/v0.2/issues/05-install-guide-and-release.md` | [#32](https://github.com/x5427876/dsh-opencode-free/issues/32) | closed |
| `.scratch/zen-inference-compat/spec.md` | [#33](https://github.com/x5427876/dsh-opencode-free/issues/33) | open |
| `.scratch/zen-inference-compat/issues/01-inference-endpoint.md` | [#34](https://github.com/x5427876/dsh-opencode-free/issues/34) | closed |
| `.scratch/zen-inference-compat/issues/02-session-identity.md` | [#35](https://github.com/x5427876/dsh-opencode-free/issues/35) | closed |
| `.scratch/zen-inference-compat/issues/03-anonymous-tool-roundtrip.md` | [#36](https://github.com/x5427876/dsh-opencode-free/issues/36) | closed |
| `.scratch/zen-inference-compat/issues/04-single-model-compat.md` | [#37](https://github.com/x5427876/dsh-opencode-free/issues/37) | open |
