Status: open
Labels: ready-for-agent
Blocked by: 03, 05, 06, 07, 08, 09

# 10: 文件與升級流程

Spec: `../spec.md`
ADR: `docs/adr/0003-compat-run-not-in-ci.md`

## What to build

讓這個流程不靠記憶：升級 DSH 時，開發者與 agent 都知道要跑它、怎麼跑、怎麼判讀。

- `AGENTS.md` 的 DSH 升級支援流程，把相容性驗證列為發版前必跑的一步。
- 維護者文件說明：如何執行、需要什麼前置條件、各選項的用途、五種判定的意義、退出碼 0 / 1 / 2 的意義（2 表示「沒壞，但沒驗完，稍後再跑」）、驗證會消耗匿名額度。
- 說明它與外掛內建探測（probe）的差別，用 `CONTEXT.md` 的術語，避免兩者混淆。
- 說明它不進 CI 的原因，連到 ADR 0003，不在文件裡重複探測的歷史（那在 ADR 0002）。
- 若 `docs/reverse-engineering.md` 有描述手動實機驗證的做法，加一條指向本流程的註記，不改寫歷史紀錄。

## Acceptance criteria

- [ ] `AGENTS.md` 升級流程含「發版前必跑相容性驗證」
- [ ] 文件說明執行方式、前置條件、選項、判定與退出碼
- [ ] 文件使用 `CONTEXT.md` 的術語，並區分探測與相容性驗證
- [ ] 文件連到 ADR 0003 說明不進 CI
- [ ] 沒有編造任何尚未實作的選項或行為
