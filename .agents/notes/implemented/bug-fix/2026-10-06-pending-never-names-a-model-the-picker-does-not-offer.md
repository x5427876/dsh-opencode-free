# Agent Note: 「仍在测量中」不能点名一个选择器里根本没有的模型

Status: implemented

## Problem

上一条 Note 加的 `pending`，上线第一天就报错了。线上读数：

```
pending: 28 个模型
其中 Zen 已经不再供应（本轮 not-listed）: 23 个
```

面板（以及任何读这个字段的人）被告知「还有 28 个模型在测量中」，而其中 23 个**根本不在用户的模型选择器里**，也不会再进去——它们是 Zen 已经下架、闸门过滤掉的模型。

`pendingEffortIds` 遍历的是 `state.models`，那是**闸门之前**的目录。于是这个字段在用户最需要读它的时刻（刚点完探测）说的第一句话就是错的，而且错得很具体：它叫用户为一个永远不会出现在列表里的模型继续点击。

这与 A4 同源：「目录、选择器与面板共享同一套可见性判断」——我加了一个共享可见性的字段，却没让它读同一套可见性。

## Decision

`pendingEffortIds` 改为遍历 `effectiveList(state.models, state.zenIds, state.probes)`，也就是**选择器读到的那一份**：闸门过滤 + 排除已判死的模型。

闸门未知（`zenIds === null`）时，`effectiveList` 返回全部候选——这是它既有的语义，也是对的：闸门没问到不等于模型不在场，此时报全部比报空更诚实。

## Alternatives considered

- **在面板里过滤，而不是在这里**——前端可以再滤一遍，但一个字段**先说错再由消费者纠正**，等于把同一套可见性判断复制成两份。A4 要求的是共用同一个来源，不是共用同一个形状。
- **用 `notListed` 排除而不是走 `effectiveList`**——更贴近本轮的范围，但闸门没问到的轮次（`servedSet === null`）会把全部已下架模型算成欠账，而这正是同一个错误的另一种形式。
- **只在字段里保留数量不保留 id**——数字同样会错（28 这个数字本身就是错的），而且丢了「是谁」就没法指导下一步。

## Consequences

- **收益**：`pending` 现在恰好等于「选择器列表 − 已测完的模型」，这正是它该断言的东西。
- **代价与已知上限**：闸门没问到时仍会包含已下架的模型（那正是 `effectiveList` 在闸门未知下的既有行为，不是本条引入的）。闸门本身每 30 分钟问一次，正常情况下它是有值的。
- **范围**：只改这一个字段的来源。轮次本身的范围（`targets`／`notListed`）本来就由闸门决定，没有被牵连。

## Verification

- `GUARD: "still measuring" never names a model the picker does not offer`：打上闸门（只供应两个模型），断言 `pending` 恰好等于那两��，且不含任何被闸门挡下的 id。
- 变异验证：把 `effectiveList(...)` 换回 `state.models`，测试失败。
- 既有的「空闲读数」与「实时读数」两处 `pending` 期望值随之更新：实时那处现在**不含**本轮判死的 `deepseek-v4-flash-free`——一个选择器不再提供的模型，不欠任何测量。