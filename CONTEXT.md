# dsh-opencode-free

本插件仿冒 OpenCode CLI 身份使用 Zen keyless 層。術語以此為準
（技術段落不用「模仿」，立場段落用「bypass」）。

## Language

**仿冒 CLI 身份**：
本插件送出與 OpenCode CLI 逐字節同構的身份（UA、會話 id、專案標記），使上游把請求當 CLI 發的。
_Avoid_: 模仿、假裝、偽裝

**bypass**：
在上游沒有第三方合約的情況下通過 keyless 層的准入檢查；200 不代表被允許。
_Avoid_: 借用、蹭用、繞過檢查（動詞片語，不作名詞）

**匿名額度**：
Zen 按出口 IP 共用的試用 bucket（input＋output＋reasoning 合計）；同 IP 重度使用會集體耗盡。
_Avoid_: 免費流量、免費額度（後者泛指一切不付費的量，含 key 帳戶的贈額）

**探測（probe）**：
外掛內建、面向使用者的可用性輪次，直接呼叫 provider，範圍是使用者打開的模型。
_Avoid_: 驗證、健檢（後者留給相容性驗證）

**相容性驗證（compat run）**：
面向開發者的流程：在指定版本的真實 DSH 上，逐一驗證 Zen 提供的全部免費模型能否經 DSH 搭配本插件使用；與使用者的模型開關無關。
_Avoid_: 探測、live test
