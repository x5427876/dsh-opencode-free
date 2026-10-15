# 以有效時間編碼生成穩定的 session 身份

**Status**: accepted; supersedes the original hash-time decision in this ADR.

## Context

原決策以 hash 的前 6 bytes 近似時間區段，避免跨請求計數與可變狀態，並保持同 session 的親和。早期上游只驗結構的假設已不成立：2026-10-14 UTC 的差分中，套件 hash session 被拒絕，而有效時間前綴可通過。本機自行生成 descending 時間前綴也已在 provider 路徑取得非空回覆。

依據：上述 2026-10-14 UTC 差分結果與[官方 identifier 實作](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/schema/src/identifier.ts)。

## Decision

每個 DSH session 首次出現時，使用有效 descending 時間編碼：毫秒時間乘以 `0x1000` 加單調計數，取反後保留 6 bytes，再加 14 個隨機 base62 字元。

進程內記住每個 session 的第一個上游 ID，所有親和標頭與 cache key 使用同一值；不逐請求重建、不保存到磁碟。時鐘回撥不倒退計數時間，同毫秒計數用滿時推進一毫秒。無 DSH session 的守衛使用同一個進程內 fallback，避免每個請求建立新的身份。

## Considered Options

- **Hash 假時間（原決策，否決）**：無狀態，但現在有獨立的拒絕證據。
- **每次請求生成新時間 ID（否決）**：不需 session 映射，卻破壞對話親和與 prompt cache。
- **首次生成、進程內保留（採用）**：新增少量可變狀態，換取有效時間與穩定親和。
- **持久化身份（否決）**：本次不需要；增加磁碟、隱私與跨進程生命週期責任。

## Consequences

- 映射與計數只活在目前模組／進程；重新啟動會產生新的上游身份，不新增登入或憑證儲存。
- 映射保留到進程結束，不做會破壞長 session 親和的定時清除。所需記憶體與該進程見過的 DSH session 數量成正比。
- 上游允許的時間範圍與長 session 是否過期尚未實測；本決策不把目前成功推廣成完整時間驗證契約。
- 原 request ID 策略不改：差分中單獨替換它仍可通過。
- 離線測試使用固定的一手來源例子與時鐘回撥，live 相容性驗證另行記錄，不進 CI。
