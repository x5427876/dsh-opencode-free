# 文件索引

[English](README.md) | **繁體中文**

依任務選擇文件，不需要通讀整個目錄。安裝與快速開始請見[專案 README](../README.zh-TW.md)。

## 使用者

| 任務 | 閱讀文件 |
|---|---|
| 模型清單、探測、快取復原、API key | [使用指南](usage.zh-TW.md) |
| 回報問題 | [疑難排解](../README.zh-TW.md#疑難排解) |

## 貢獻者與維護者

| 任務 | 閱讀文件 |
|---|---|
| 修改或審查程式碼 | [工程標準](standards.md)、相關[已知差距](standards-gap.md) |
| 理解免費層檢查什麼（可引用、可重現） | [免費層檢查說明](free-tier-gate.zh-TW.md) |
| 理解請求調整方式 | [協定分析紀錄](protocol-notes.md) |
| 修改目錄、身份或驗收政策 | 相關的 [ADR](#決策) |
| 驗證真實 DSH 相容性 | [相容性驗證指南](compat-run.md)；實際請求須取得授權 |
| 評估是否升級 DSH | [升級評估](upgrade-evaluation.md)（英文） |
| 升級 DSH 或發布版本 | [發布檢查表](release.md) |
| 處理 Issue | [GitHub 工作流程](agents/issue-tracker.md) |

## 決策

- [0001：Session 身份](adr/0001-hashed-session-ids.md)
- [0002：執行期目錄與可見性](adr/0002-catalogue-source-of-truth.md)
- [0003：實際連線相容性驗證不進 CI](adr/0003-compat-run-not-in-ci.md)
- [0004：官方動態驗收目標](adr/0004-official-dynamic-compat-targets.md)
- [0005：官方模型清單是免費模型的唯一來源](adr/0005-official-model-list-as-free-model-source.md)
- [0006：以 OpenCode CLI v1 線作為請求內容的仿照依據](adr/0006-opencode-v1-as-payload-reference.md)

## 範圍

文件只描述目前版本。相容性驗證輸出不存放在儲存庫：它隨環境、版本與時間而異。

Issue 與規格維護於 [GitHub Issues](https://github.com/x5427876/dsh-opencode-free/issues)，
不再使用本地票檔。Agent 安裝安全流程仍以 [AGENTS.md](../AGENTS.md) 為準，
領域術語則見 [CONTEXT.md](../CONTEXT.md)。
