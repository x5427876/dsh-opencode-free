# Agent Note: 我们注入的拼写被拒，是关于那个拼写的样本

Status: implemented

## Problem

轮次在探针回来之后先分三路：`ok` 记证据、`dead` 记退休、其余一律「本轮没测到」。`inconclusive` 那一支做两件事：写进不可达退避（0→6h→24h→7d），并且**不写任何记录**。

问题在于，探针回来的 `inconclusive` 里混着两种完全不同的东西：

1. 「我不知道」——超时、传输失败、429、403、被闸门挡下。
2. **「我问的那个拼写你不接受」**——上游确实收到了请求、解析了 body、回了一个 400。

第 2 种被归进了第 1 种。实测代价是双重的：space-bunny-free 对 `reasoning_effort: "none"` 在两条通道上都回硬 400，而同一个模型省略该字段时正常作答（ADR 0004 §31）。于是这个 400 既被当成「这轮白跑了」，**又把模型静音六小时**——而 ADR §31 的 fallback 规则正是靠这个 400 触发的（「问一次 `none`，被拒就换模型自己的最低档位」）。fallback 因此永远问不到。

讽刺的是 `MeasuredEffort` 早就有一个 `rejected` 类型，`effortVerdict` 也能对它计数，`thinkingLevelMapFor` 也认它（R4 → `off: null`）。整条链路只差一个把「被拒」送到轮次手里的信号。

## Decision

轮次在分路之前先判一次：**这一轮问的拼写被拒了吗？**

```
const spellingRefused =
  outcome.kind === "inconclusive"
  && question !== "baseline" && question !== "settled"
  && (outcome.http === 400 || outcome.http === 422);
```

- 命中时，它**不是** inconclusive：它是一个 `rejected` 样本，走与其它样本同一条记账路径。
- `verdict` **不**被改写。存活性这一轮什么也没证明，所以模型已有的裁定原样保留——这也顺带避免了往 `ProbeRecord` 里塞一个 `ProbeVerdict` 根本不承认的值。
- 通道按「本轮问的那条」记：拒绝没有自己的通道信息，但请求确实是被那条通道答复的，而一条说不出通道的裁定 `thinkingLevelMapFor` 会拒绝采用。
- 自述词表照旧从拒绝里收割（fledge-alpha-free 正是这样给出它真实的档位集合的）。
- **不退避、不置 `untrusted`**：模型被问到了，而且回答了「不」。

边界收到很窄：**只认 400/422，且只认本轮真的问过的拼写。** 403/429 说的是调用方、404/410 说的是模型，两者在上游已经分类完毕，不会走到这里。ADR 0004 §7 警告过「泛用 400 也可能是上下文溢出」，但探针自己的请求是 `hi` 加 1024 token 预算，那个形态在它身上不成立。

## Alternatives considered

- **在传输层判定并回传一个新字段**（`refusedSpelling: true`）——把「我发的是什么」交给发的人，边界更干净。但轮次现在**已经有**那个值（`question` 是同一个变量推导出来的），再让传输层回传一遍就是第二个来源；而且失败路径的类型要多改一处。判据留在轮次，因为它已经把「这一轮问了什么」握在手里。
- **任何 4xx 都算被拒**——更简单，但 401/404 会被误记成「拼写不被接受」，而它们其实说的是凭据或路由。收窄到 400/422 之后，misclassification 的方向是**少记**（回到 inconclusive，退避一次），而不是**错记**（冻结一个假的档位裁定）。
- **被拒不计入一致性计数，直接进 fallback**——省三轮请求，但 ADR 0004 §32 的教训正是 big-pickle 的 `none` **间歇性**被拒：九次里三次 400。以间歇失败为证据立刻改题，等于把上游抖动写进用户的控件。仍然走三次一致的纪律，只是第一次分歧就换 fallback（`EFFORT_FALLBACK_AFTER = 1`）这件事本来就已实现。

## Consequences

- **收益**：ADR 0004 §31 的决策树第一次能跑完——`off → 最低可用檔位 → 無此檔位者才 null`。两条具名测试分别钉住中途（一次被拒即换到该模型自己的 `low`，并确认它）与终点（三次一致 → `rejected` → `off: null`）。
- **代价与已知上限**：一个**真的**因为别的原因回 400 的上游，会被记成「该拼写不被接受」，最坏结果是退避一次；连续三次才会冻结为 `rejected` → `off: null`，而那本来就是「不提供这一行」的诚实答案。代价上限是「少一个控件」，不是「给一个假控件」。
- **代价**：被拒的轮次不再计入 `probeInconclusive`，所以面板的「本轮有模型没能测到」不再包含它们。这是对的——它们测到了——但如果上游开始对**所有**拼法回 400，这条提示会消失而卡片看上去一切正常。`lastRound.results` 里的 `status: "failed"` 与 `http` 仍然是逐行证据。
- **未解决**：模型被问到的**前提**仍受不可达退避影响。一次 429 之后的模型要等 6 小时才被再问一次，哪怕它当时就能回答。这条与本决定分开修。

## Verification

- `GUARD: a refusal to the spelling we asked counts as a sample, not a silence`：十轮里断言问题序列是 `baseline×3 → none → low×… → settled`，且最终裁定是 `level-works/low`。
- `GUARD: three refusals of the same spelling end at no Off row, never a wrong one`：全程 400，断言最终 `effort.kind === "rejected"`、无 `level`、且派生出的 `off` 是 `null`。
- 两者都做过变异验证：把 `spellingRefused` 判据改成 `false`，两条测试立刻失败。