# Spec v0.2：匿名被閘時的可用性

## Problem Statement

`opencode-zen-free` 在對話模型選單可見、可選，但匿名出口被上游閘住時
（`403 FreeTierError`），DSH 只顯示通用的「API 密钥无效」，使用者無法
分辨：是匿名額度被閘、額度用完、還是自己的 key 填錯——於是回報成插件
bug，或在錯誤的方向上重試（重啟、重裝、換模型都沒用）。v0.1 只保證
「路是通的」，沒保證「不通時指得出路」。

## Solution

上游失敗時給出可行動的指引：匿名被閘→掛 key；額度用完→等重置或掛 key；
key 錯誤→檢查 key。Key 的設定路徑（plugin config 與環境變數）寫到
使用者找得到的地方，並可用不耗額度的方式驗 key 有效。

## User Stories

1. As a keyless user whose egress IP is anonymous-gated, I want the chat
   error to name 匿名額度 gating and point to key setup, so that I stop
   retrying things that cannot help.
2. As a keyless user hitting quota exhaustion, I want the error to say
   wait-for-reset-or-key instead of key-invalid, so that I choose the right
   response.
3. As a Zen key holder, I want a wrong key to be reported as key-invalid,
   distinct from anonymous gating, so that I fix the key instead of doubting
   the plugin.
4. As a DSH Desktop user with no shell environment, I want to set the key
   through plugin config alone, so that I am not forced onto env vars.
5. As a CLI user, I want the env var path to keep working unchanged, so that
   my existing setup does not break.
6. As a key holder, I want to verify the key without spending chat quota,
   so that setup mistakes surface before real use.
7. As a user picking a free model, I want removed models to fail with
   model-unavailable guidance rather than a generic error, so that I reselect
   instead of debugging.
8. As a user behind shared NAT, I want docs to explain the shared bucket,
   so that simultaneous failures across machines make sense.
9. As a Muse Spark user, I want the default reasoning behavior unchanged by
   this release, so that output quality does not regress silently.
10. As a maintainer, I want all upstream-failure interpretation in one seam,
    so that the next Zen wording change touches exactly one place.
11. As a maintainer, I want recorded failure fixtures asserting the mapping,
    so that drift is caught offline without spending quota.
12. As a maintainer, I want the live reverify loop to cover the new mapping,
    so that manual verification stays a single command.
13. As an Agent following the install guide, I want the verify section to
    mention the key-optional live check wording, so that agents do not promise
    anonymous success.
14. As an upgrading user, I want zero breaking config changes, so that v0.1
    installs keep working untouched.
15. As a new user, I want the bypass nature disclosed before I rely on it,
    so that the next upstream breakage is expected, not a betrayal.
16. As a maintainer, I want ADR-0001 revisited automatically when anonymous
    behavior changes, so that the session-id approximation never rots silently.

## Implementation Decisions

- 新增唯一的分類接縫：把上游失敗（狀態碼＋報文特徵）映射為四種之一——
  匿名被閘、額度用完、key 錯誤、未知——並附指引鍵。純函式、無 I/O，
  由請求路徑、文件、重驗腳本三方共用。
- 請求路徑在傳輸失敗時查該接縫，轉為帶穩定代碼的錯誤並附指引文字；
  DSH 顯示訊息即指引，不另建 UI。
- Key 設定維持雙路徑：plugin config（Desktop 可用）與環境變數（CLI 可用），
  優先順序不變；config 保持非 volatile（改 key 走 HMR 重載，現已成立）。
- 目錄維持打包基線＋公開端點交集；不做背景自動刷新（副作用與額度成本），
  新鮮度以重驗腳本①號燈為信號，文件載明。
- 訊息用語遵守專案 glossary：共用 bucket 稱匿名額度；bypass 性質在 README
  揭露一次為限，不在每次錯誤重複。
- 尊重 ADR-0001：本版本不動會話 id 方案；匿名行為變化時重審該 ADR。
- 錯誤指引只測外部行為（給定狀態碼＋報文→指引），不斷言 header 內部。

## Testing Decisions

- 好的測試只測外部行為：錄製的失敗報文進、指引出；不測傳輸內部。
- 測試位置：沿用現有純函式接縫（分類函式單元測試）與註冊接縫
  （沿用錄製 fetch 的 fixture 風格補失敗路徑）。
- Prior art：既有相容測試的錄製 fixture 模式；重驗腳本的 live 記錄模式。
- Live 測試不新增耗額度項目：分類映射用錄製報文離線斷言；
  重驗腳本維持現有三盞燈，key 燈沿用。

## Out of Scope

- 設定頁／client UI、額度卡片、`/login` 持久登入、OAuth。
- pi-ai 0.86 transcript 升級（被 DSH peer 鎖版擋住）。
- 背景自動刷新目錄、多 key、按模型分流。
- 匿名恢復後的自動切回（維持手動，行為可預測）。

## Further Notes

- 本 repo 尚無 issue tracker（非 git repo、無 `.scratch`），本 spec 暫存於
  `docs/spec-v0.2.md`；tracker 就緒後需發布並掛 `ready-for-agent` 標籤。
- 整個功能是 bypass 性質：Zen 一改報文用詞，分類映射即漂移；
  重驗腳本是唯一的漂移偵測器。
