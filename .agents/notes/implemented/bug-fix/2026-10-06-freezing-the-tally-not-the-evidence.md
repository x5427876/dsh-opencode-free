# Agent Note: 冻结的是计数，不是证据

Status: implemented

## Problem

线上确认了一个我不该相信、又无法审计的裁定：`longcat-2.5-preview-free` 拿到 `level-works / minimal`，而 ADR 0004 §三十一 明确记着该模型 `minimal` = 36、省略基线 36–45——**没有降幅**，表格里它的结论是 `off: null`。

去查证时发现：**产生这个裁定的样本在确认那一刻被清空了。**

```
effortFrozenAt: stamp,
effortTokens: [],        // ← 证据没了
effortBaselineTokens: …
```

而紧挨着的注释写的是：

> Frozen: the samples that produced the verdict **are kept as they were**, so a later re-measurement starts from the declaration rather than from a median that has been quietly growing.

**注释说保留，代码做的是删除。** 这不是 tidiness：一个冻结裁定唯一的证据就是这些样本，证据没了，任何人（包括下一次测量）都无法复算那个中位数，也就无法知道这个裁定是对是错。这正是「分类器可以错而无人能察」的状态——ADR 0004 §三十二 用整节篇幅防的同一件事。

## Decision

**冻结的是计数，不是证据。** 确认时清空的是 `effortSamples`（判定计票），`effortTokens` 与 `effortBaselineTokens` **原样留下**。

两者的区别正是当初混为一谈的地方：

| 字段 | 是什么 | 冻结后的处置 | 为什么 |
|---|---|---|---|
| `effortSamples` | 判定计票 | **清空** | 它会随「已 settled 的模型仍被探测存活」而继续累加判定，而那些判定是针对一个已经冻结的裁定做的——那才是漂移 |
| `effortTokens` | 产生裁定的候选样本 | **保留** | 它是裁定唯一的证据。留着它，中位数可以被任何人复算 |
| `effortBaselineTokens` | 被比较的那一侧 | **保留** | 同上；没有它，复算连分母都没有 |

停止累加这件事**本来就不靠清空**：`nextEffortQuestion` 对已确认的模型返回 `"settled"`，探针在 `settled` 下不再注入拼写，而这一轮也不会再产生样本。所以保留证据不会带来 ADR §38 担心的「无界中位数漂移」。

## Alternatives considered

- **保留样本到一个单独字段**（例如 `effortEvidence`）——边界更干净，但同一份数字出现两处，且读取侧要多一条路径。留在原字段里更简单，且 `measuredEffortFor` 的指纹守卫照样覆盖它。
- **把样本写进日志而不是记录**——日志不进版本控制，用户看不到，而这次的问题恰恰是「用户需要能自己核对」。
- **不冻结、继续累加**——ADR §38 第一条已经用big-pickle 的 `minimal` 在 0 与 8 之间摆动证明了漂移是真实的。保留而不累加，两者不冲突。

## Consequences

- **收益**：每个冻结裁定都可复算。测试钉住的不只是「样本还在」，而是「**用保留下来的样本重算中位数，仍然解释得了这个裁定**」——这条断言在样本被清空时会失败。
- **代价与已知上限**：缓存里的数字变多（每模型多几个整数，可忽略）。以及一个诚实的下限：保留样本**不等于**裁定正确。`longcat` 那个裁定仍然存疑——只是现在**可以被查**了：下一次重测（TTL 到期或声明变化）会保留新样本，届时可以直接比对新旧两组。
- **未解决**：`longcat-2.5-preview-free` 的裁定**是否正确，本条无法判定**，因为原始样本已在上一个版本里被丢弃。修好的是「下一次不会再发生」，不是「这一次已经查清」。这一点必须对用户说清楚。

## Verification

- `GUARD: a confirmed verdict keeps the samples it rests on`：断言裁定存在、候选样本 ≥ `EFFORT_SAMPLES`、基线仍是 `[40,40,40]`、计票被清空，并且**用保留下来的样本重算的中位数仍然满足 `EFFORT_WORKING_RATIO`**。
- 变异验证：把 `effortTokens: []` 加回去，测试失败。