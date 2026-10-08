# Agent Note: fallback 计数的是「失败」，不是「不一致」

Status: implemented

## Problem

`EFFORT_FALLBACK_AFTER = 1` 的语义是「问一次 `none`，被拒就换模型自己的最低档位」（ADR 0004 §31）。但它计的是 `effortVerdict` 返回的 `discord`，而那个函数**必须**把第一个样本也判成 discord——没有先前的样本可以「一致」，`agrees` 只能是 false。

于是「一次测量」就足以把轮次从 `none` 上换走，**包括 `none` 恰好有效的时候**。实测数字：

| 模型 | `none` | fallback（`minimal`） | 基线 | 阈值 0.43×37 | 结果 |
|---|---|---|---|---|---|
| mimo-v2.6-flash-free | **0 tok（精确零）** | 16 tok | 37 tok | 15.91 | 16 > 15.91 → 判为无效 |

差 0.09 个 token。一个**拥有完美 Off** 的模型，会因为先问了一次正确的档位而被换到一个无效档位上，最后拿到 `off: null`——正是本轮要消灭的那种埋没。

## Decision

计数的是**这个问题的失败次数**，不是 tally 的形状：

- `failed = sample !== "none-works"`——被拒（`rejected`）或被忽略（`noop`）才算失败；
- 第一次成功**不**增加计数，于是轮次留在 `none` 上继续问，三次一致后确认成 `none-works`，`off` 就是 `"none"`；
- 问题切换时计数归零：fallback 是一次新尝试，`none` 的失败对它什么也没说。

落盘字段 `effortDiscord` 的含义因此从「tally 有过几次不一致」变成「当前问题失败过几次」——`nextEffortQuestion` 的读法不用改，它要的本来就是这个。

## Alternatives considered

- **让 `effortVerdict` 把第一个样本判成 `sample`**——最贴近字面。但那样 `none` 被拒时也要问满三次才换 fallback，而 big-pickle 的 `none` 是**间歇性**被拒（九次里三次 400）：等三次会把这个证据也写进裁定，方向与 §31 相反。计数「失败」而不是「不一致」正好绕开这个取舍。
- **把 `EFFORT_WORKING_RATIO` 调松**，让 16/37 也算有效——直接改的是分类器，而问题出在**问题被换走了**。调阈值会让 longcat 的 36/36 之类开始被误判为有效，是用一处放宽换另一处误报。
- **把「第一个样本」也算进 `EFFORT_CONCORDANCE`**——不解决换题，只会让确认更慢。

## Consequences

- **收益**：ADR 0004 §37 的单条规则被真正实现——`none` 精确零 → `off: "none"`；`none` 无效 → 退到该模型自己声明的最低档；两者都不行 → `off: null`。三条路径各自有测试。
- **代价与已知上限**：一个结果**反复横跳**的模型（`none` 时而 0 时而 16）会让计数停在 0 与 1 之间，可能在两个问题之间来回，直到某一边攒够三次。这与 §32「一致才持久化」的纪律一致，代价是几轮请求，不是错误裁定。
- **口径变化**：`effortDiscord` 的含义变了。字段名没变（不为了语义而改名，避免一次 schema 迁移），但**读旧缓存的人**会读到不同的含义——这正是上一条 Note 的 `EFFORT_READING` 要作废的东西：旧记录里那个计数是按旧口径写的，升级后会被整体丢弃。

## Verification

- `GUARD: samples from an older instrument are re-measured, not judged`：mimo-v2.6-flash-free 从 `[0,0]` 的毒基线恢复后，全程问 `none`，最终 `off: "none"`。变异验证：把 `failed` 改成「任何样本都算失败」，这条测试失败（正是上表那条 0.09 token 的路径）。
- `GUARD: a refusal to the spelling we asked counts as a sample, not a silence`：space-bunny-free 的 `none` 被拒 → 换到 `low` → 确认 `level-works/low`。计数语义改动后仍然通过。