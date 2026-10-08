# Agent Note: 一次作答清零「再问一次」的节奏

Status: implemented

## Problem

`UNREACHABLE_BACKOFF_MS`（0 → 6h → 24h → 7d）是**按未达次数索引**的，而次数只会由 `nextReachAttempt` 递增。全文件没有任何地方在一次作答之后递减或删除它——`runProbeRound` 只在 inconclusive 的两处分支里推进过节奏。

注释却写着相反的话，且写在记录写入的正中间：

> An answer clears the cadence: whatever was wrong with reaching this model is not wrong now, so the next round must not wait.

那是承诺，不是实现。后果不是一个孤立的 bug，而是一个**单向棘轮**：模型失败两次、再恢复之后，它的下一次失败直接从 7 天起步，而不是 6 小时——尽管模型状态没有发生任何值得 7 天的变化。6 小时那一步只有「从未失败过两次」的模型才够得着。

它同时解释了现场那类现象：`state.reach` 里已经积累的条目，永远等不到一个把它们清掉的作答。

## Decision

一次 `ok` 之后删除该模型的节奏条目：

```
if (outcome.kind === "ok") {
  applyMeasuredChannel(state.models, state.probes);
  if (state.reach[model.id] !== undefined) {
    const { [model.id]: _answered, ...rest } = state.reach;
    state.reach = rest;
  }
}
```

放在 `applyMeasuredChannel` 旁边，因为两者是同一句话：**这次轮次告诉我们的关于这个模型的事实，立即生效，不等下一轮。** 通道是「走哪条路」，节奏是「多久再问一次」，都由本轮刚得到的答案决定。

删除而不是归零：`ReachRecord.misses` 的语义是「连续失败了几次」，一次作答把这个序列打断了，所以正确的结果是不存在，而不是 0——虽然 `reachAllowsAttempt` 对两者行为相同，但保留 `misses: 0` 会让落盘的记录看起来像「它刚失败过」。

`untrusted` 与行徽标不受影响：一次作答仍然是 `ok`，面板照常画绿。

## Alternatives considered

- **把 misses 归零而不是删条目**——行为等价，但留下一个语义为空的条目；下一个读者会问「misses: 0 是什么意思」，而答案只能是「什么都不是」。
- **让退避阶梯不看历史次数，只看最近一次结果**（成功即 0，失败即 6h，永不升级）——更简单，但丢掉了本该保留的信号：一个持续 429 的模型（实测 ling-3.1-flash-free 连续七次 429）值得被少问，阶梯就是为它存在的。问题不是阶梯，是阶梯的输入没有在证据变化时更新。
- **在 `planRound` 里判断「上次是 ok 就当没失败过」**——把状态判断搬到调度层，于是「上一次是什么」这件事在两个地方各有一个答案。删除发生在写记录的地方，和其他本轮事实同处一地。

## Consequences

- **收益**：一个恢复的模型重新从 6 小时起步；6 小时那一步不再只有「从未失败过两次」的模型能用。具名测试用一条 429/429/ok/429 的序列证明恢复后的下一轮**被问了**。
- **代价与已知上限**：一个在 429 与 200 之间反复横跳的模型，会被问得比纯阶梯策略更频繁——因为每次作答都把阶梯清零。这是有意的：交替的成功与失败**正是**「它又活了」的证据，而共享桶的代价是一次请求换一次确定答复。
- **未解决（下一条 Note）**：`reach` 不落盘，所以 DSH 重启会清掉整个节奏。这条与本决定方向一致（更保守：重启后宁可多问一次），但它意味着「一周」从来跨不过一次重启。

## Verification

- 具名测试 `GUARD: an answer resets the ask-again cadence`：五轮（429 → 6h → 429 → 24h → ok → 6min → 429 → 6h），断言每一轮都被问到。变异验证：去掉那三行删除，最后一轮立刻变成「没被问」。