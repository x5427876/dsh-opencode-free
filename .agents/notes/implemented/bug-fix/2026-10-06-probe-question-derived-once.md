# Agent Note: 一轮只发问一次问题，裁定必须以发出去的那次为准

Status: implemented

## Problem

轮次对同一个模型**推导了两次**「这一轮问什么」：

```
// 发送时
nextEffortQuestion(record0, raw === undefined ? "minimal" : fallbackLevelFor(raw), settled)
// 记账时
nextEffortQuestion(prior)
```

第一次带了**该模型自己声明的最低档位**（`fallbackLevelFor`），第二次用的是函数默认的 `"minimal"`。当两者答案不同——也就是「基线已够、而候选有分歧、于是走 fallback」的时候——它们必然不同，因为 ADR 0004 §三十一 的 fallback 规则问的正是模型自己的最低档位，对 space-bunny-free 就是 `low`，而它不发布 `minimal`。

后果比「标签写错」更严重，因为**第二次推导的结果被写进了记录，而下一次轮次会读它**：`nextEffortQuestion` 见到一个既非 `none` 亦非 `baseline` 的 `effortQuestion` 就继续问同一个问题。于是实验中途换了问题，而记账还以为那是同一个问题。

离线路径复算（真实轮次代码，种子记录带三样本基线与一次分歧）：

| 轮 | 线上实际问 | 落盘 |
|---|---|---|
| 1–3 | `low` | — |
| 3 | `low` | `effortQuestion: "minimal"` ← 标签与请求不一致 |
| 4–5 | **`minimal`** ← 问题被自己写的标签改掉了 | `effort: { kind: "level-works", level: "minimal" }` 并冻结 |

于是最终冻结的裁定声称「`minimal` 连续三次有效」，而 `minimal` 实际只被问过两次，`low` 才是被问过三次的那个。这不只是命名难看：它把一个**模型从未发布过的档位**（invariant 3：map 里的字符串值只允许来自已发布档位名或 `none`）变成了发给使用者的 Off 行。

## Decision

问题**只推导一次**，并且记账读的就是发出去的那一个值：

```
let question: EffortQuestion = "baseline";
try {
  question = nextEffortQuestion(record0, raw === undefined ? "minimal" : fallbackLevelFor(raw), settled);
  outcome = await probe!(model, question);
} catch { … }
```

`question` 提升到 `try` 之外声明，后面所有的记账——`effortQuestion`、`effort.kind`、`effort.level`——都读它。**记录里写的标签与线上发的问题，从此是同一个变量。**

`fallbackLevelFor` 的调用点只有这一处，所以「fallback 是什么」也只剩一个答案。

## Alternatives considered

- **让第二次推导也带上 `fallbackLevelFor`**——最小改动，两次推导会一致。但「同一个问题推导两次、期望它们碰巧相同」本身就是缺陷的形状：下一次有人改其中一处的默认值，同样的漂移会再来一次。把值取一次，比让两处保持同步更可靠。
- **落盘时不写 `effortQuestion`，靠 `effortDiscord` 推断**——避免了标签，但丢掉「问题已经换过」这个事实，于是 fallback 每轮都会被重新评估一遍，`EFFORT_FALLBACK_AFTER = 1` 的「一次分歧即换问题」也就无从判断。标签是有用的状态，问题是它此前由错误的那一次推导写出来。
- **在写盘时校验标签与请求一致，不一致就丢弃裁定**——多一道防御，但会静默丢掉一次真实测量，而根因（两次推导）依然存在。修根因，不加兜底。

## Consequences

- **收益**：测量与声明从此指同一个档位；离线路径复算里五轮全部问 `low`，冻结的裁定是 `level-works / low`，`thinkingLevelMap.off` 也是 `low`。
- **代价与已知上限**：本决定修的是**标签**，不改变问题**何时**换。`EFFORT_FALLBACK_AFTER = 1` 仍意味着一次分歧就切换到 fallback，而 `EFFORT_CONCORDANCE = 3` 仍要求三次一致才写入；两者叠加的结果是：一个被拒的 `none` 会先问一次 fallback，再在 fallback 上重新累计三样本。这是 ADR 0004 §三十一 的原意（`off → 最低可用檔位`），不是本决定引入的。
- **新暴露的问题**：裁定写进记录之后，档位表要等到**下一次同步或重启**才重新派生，所以新出现的 Off 行在本轮内看不到。这是延迟而非错误，另行处理。

## Verification

- 具名测试 `GUARD: a confirmed verdict names the level the probe actually asked`：种子记录带三样本基线与一次分歧，五轮后断言「每一轮问的都是该模型自己声明的最低档位」、落盘裁定的 `level` 是它、以及重新同步后派生出的 `thinkingLevelMap.off` 是同一个值。把第二次推导改回去，测试立刻失败（变异已验证）。
- 离线路径复算 `.scratch/verify/round-replay2.mjs`（零配额、不入库）。