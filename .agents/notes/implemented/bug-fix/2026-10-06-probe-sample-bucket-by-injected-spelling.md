# Agent Note: 样本归入哪一桶，由「本探针是否注入了拼写」决定

Status: implemented

## Problem

轮次把每个探针回报的观测分成两类：`baseline`（省略参照）与 `candidate`（候选档位）。分类的唯一依据写在 [zen-provider.ts 的 `onPayload`](../../../../src/zen-provider.ts) 里：

```
injected.reasoning = deps.question !== "baseline" && !sent0
```

`sent0` 的含义是「在我动手之前，body 里已经有 reasoning 字段」。而存活性探测固定传 `reasoning: "low"`，pi-ai 的 `clampThinkingLevel` 对任何提供档位的模型都会把它写成 `reasoning_effort: "low"`——**本插件给每一个推理模型都发了默认阶梯**（`thinkingLevelMapFor` 恒产出 `minimal…high`，ADR 0004 §二十五 的明确取舍），所以 `sent0` 在真正要紧的模型上恒为 true。

于是 `injected.reasoning` 恒为 false，**每一个候选观测都被归档成基线**，`effortTokens` 永远是空数组。而轮次判定的触发条件是候选侧 `tokens.length >= EFFORT_SAMPLES`，所以即使仪表正常（见 [上一篇 Note](../../implemented/bug-fix/2026-10-06-probe-reads-normalized-reasoning-usage.md)），候选侧也永远攒不满，`working` 恒为 `undefined`。

这个判据本来的意图是对的，只是取错了量：它想问的是「这次请求带的是模型自己的默认，还是我们指定的东西」。正确的问题不是「动手前 body 是否为空」，而是**「本探针有没有往线上放一个拼写」**——注入动作本身就是答案，它发生在 `sent0` 被读取之后，并且**替换**掉 pi-ai 放的那一个。

## Decision

`onPayload` 先把「这一轮问的是什么」算成一个布尔量 `asks`，然后：

- `injected.reasoning = asks`——分类只由问题决定；
- `if (!asks) return body;`——早退与分桶共用同一个量，两处不可能再各说各话。

`asks` 为 false 的三种情形与原先一致：`question === undefined`（存活性探测）、`"baseline"`（省略参照）、`"settled"`（已有裁定，只测存活）。

**一个无档位模型把硬编码的 `low` 夹成省略，那次请求确实是省略基线**——但那正是轮次在这种情况下**所问的问题**（它会问 `baseline`），所以它不再需要任何额外规则。原注释里那条特例随之删除：它描述的是一个由「插件从不发空 body」这个事实造成的假象，而不是一条独立规则。

## Alternatives considered

- **改成「线上最终带的拼写是不是我们注入的那个」**（在早退之后回头读改写后的 body）——语义上等价，且更贴近「字节即事实」的既有原则；但它需要在同一段函数里既改写又回读自己刚写的东西，而问题参数在那一刻本来就是可靠的单一事实来源。取问题参数更直接。
- **在轮次侧按 `effortQuestion` 反推桶**——不动传输层。但轮次已经知道 `question`，再从观测里猜一次，就有了两个能互相矛盾的真相来源，正是 [measuredEffortMap 的注释](../../../../src/catalog.ts) 警告过的那类漂移。
- **让存活性探测改发一个必然被夹掉的档位（如 `xhigh`，opt-in 级多半不在 map 里）**，好让 `sent0` 变 false——这会去改一条与测量无关的生产请求来迁就一个分类 bug。为了让测试变绿而改被测系统的请求形状，是把 fixture 的需求错当成系统的需求。

## Consequences

- **收益**：候选观测第一次真正进入 `effortTokens`，基线与候选两侧各自累积，轮次才可能比较。离线路径复算（真实轮次代码 + 假上游）已可见：修完之后第 1–3 轮基线记 55，第 4 轮候选记 0，方向与 `tests/measured-samples.json` 里 mimo-v2.6-flash-free 的实测一致。
- **代价与已知上限**：判定现在依赖「`onPayload` 被调用」，因此**任何绕过传输层的探针**（未来的脚本直组 body）不会被这条规则约束。这是刻意的：它守的是生产路径，不是所有可能的调用方。
- **新暴露的问题**：分桶修好之后，「记录被整条重写、没重新推导的字段就消失」这件事第一次可见——见 [记录不得丢掉本轮没有重新推导的证据](../../implemented/bug-fix/2026-10-06-probe-round-preserves-earlier-evidence.md)。

## Verification

- 具名测试 `GUARD: a probe that injects a spelling files the sample as a CANDIDATE` 断言三种问题的分桶结果。只断言线上字段（`reasoning_effort === "none"`）**两条路径都会通过**，所以断言的是桶。
- 离线路径复算 `.scratch/verify/round-replay.mjs`（零配额、不入库）：修之前候选恒落基线桶，修之后第 4 轮候选进入 `effortTokens`。