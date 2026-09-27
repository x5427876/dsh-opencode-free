# 01: 上游失敗分類接縫＋錄製報文測試

**What to build:** 純函式分類接縫：上游失敗（狀態碼＋報文特徵）映射為匿名被閘、
額度用完、key 錯誤、未知四種之一並附指引鍵；錄製報文鎖死映射，Zen 改字即紅燈。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [ ] 四類各至少一錄製報文進、正確指引出
- [ ] 未知報文不誤判為已知三類
- [ ] 只用 glossary 詞彙（匿名額度、bypass）；不碰會話 id 方案（ADR-0001）
