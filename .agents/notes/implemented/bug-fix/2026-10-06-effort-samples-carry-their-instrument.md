# Agent Note: 测量格式变了，旧样本必须作废（带仪表版本）

Status: implemented

## Problem

修好仪表之后，**已经写进用户缓存里的坏样本不会自己消失**。

第一条修复让探针真的去读 `usage.reasoning` 之前，每一个档位样本都是硬编码的 0。现场缓存里就是这样：`effortBaselineTokens` 是 `[0]`、`[0,0]`，而这些 0 从来不是读来的。

它们不能靠**值**识别：一个被要求 `low` 的模型回报零推理是完全可能的，所以「0」既可能是假的也可能是真的，凭值判断就是猜测——正是整条轴存在的理由要防的那种事。

而留着它们的代价不是「精度下降」，是**永久卡死**：`median([0, 0, 37]) === 0`，于是 `effortVerdictFrom` 的 `base <= 0` 守卫命中，模型从此每轮都在问同一个问题、永远得不出结论。用户升级插件后会看到「还是没反应」。

## Decision

样本带着**写它们的仪表版本**落盘：`ProbeRecord.effortReading`，常量 `EFFORT_READING = 2`。

- 写入：本轮只要碰过档位样本、已有版本、或得出裁定，就写上当前版本。
- 读取：`effortReading !== EFFORT_READING` 的记录，丢弃它的
  `effortSamples`／`effortQuestion`／`effortFrozenAt`／`effortDiscord`／
  `effortBaseline`／`effortTokens`／`effortBaselineTokens`——于是该模型**重新量**，而不是拿着没读过的数字去判定。

**已确认的 `effort` 裁定照旧采用**（读侧条件是 `entry.effortReading === EFFORT_READING || isMeasuredEffort(entry.effort)`）。这不是为了照顾旧数据，而是因为旧仪表**根本无法产出确认裁定**：`base <= 0` 一直在拦截。所以「带裁定」本身就证明它是新仪表写的。

`CACHE_VERSION` 不动：这是一次测量格式的失效，不是目录结构的迁移，而版本 bump 会连带丢掉用户已经拿到的 `verdict` 与 `api`（ADR 0004 明确否决过为此 bump）。

## Alternatives considered

- **在值上过滤：把 0 当作「没量到」丢掉**——最省事，也最危险。它会把「这个模型真的不推理」和「我们没读到」混为一谈，而这正是 `inconclusive` 与 `ok` 分开的全部理由。已拒绝。
- **`CACHE_VERSION` bump，让用户删缓存重来**——ADR 0002/0004 已经否决过一次：代价是丢掉 `verdict` 与 `api`，换一天降级路由；而用户根本不知道要删什么。
- **把样本数组定长（比如只留最近三个）**——顺手解决了「新样本被旧毒样本的中位数拖住」，但**救不了这个场景**：毒样本是 `[0,0]`，再来一个真实样本变成 `[0,0,37]`，中位数仍是 0，而轮次此时已经转去问 `none` 了，不会再补基线。窗口再小（1 个）会把中位数判定整个换掉，超出本次修复范围。
- **只清 `effortBaselineTokens`**——毒数据确实都在基线侧，但候选侧同样可能是全 0，且两个数组要靠同一条规则一起作废，拆开处理等于承认它们是两回事。

## Consequences

- **收益**：升级后**不需要用户做任何操作**，坏样本自动作废、模型自动重量；这是唯一一个让前面几条修复对既有部署真正生效的环节。
- **代价与已知上限**：从 0.3.1 升上来时，每个未确认的模型要重新花几轮请求（三样本基线 + 候选）。这在共享桶上是**一次性**成本，方向也正确——用一次真实测量换掉一个永久卡死的轴。
- **代价**：`ProbeRecord` 多一个可选字段，`readProbes` 多一条守卫。这条守卫是**必要**的：少一个守卫，毒数据就能从别的路径（手改缓存、旧版本回滚）绕回来。
- **不影响**：上下文轴（`context`）有自己的指纹守卫，本条不碰它；夹逼观测（`contextHits`）也不是这次量测的产物，照旧读回。

## Verification

- `GUARD: samples from an older instrument are re-measured, not judged`：种入一份**没有** `effortReading` 且基线是 `[0,0]` 的记录（就是现场那份），跑十轮后断言基线变成 `[37,37,37]`（不是 `[0,0,37]`）、裁定是 `none-works`、派生的 `off` 是 `none`。变异验证：把 `failed` 的判据改回「任何样本都算失败」，这条测试立刻失败——因为那样 `none` 会在第一次成功后被换成 fallback，而 `minimal` 的 16 对 37 恰好以 0.09 token 落在阈值外。