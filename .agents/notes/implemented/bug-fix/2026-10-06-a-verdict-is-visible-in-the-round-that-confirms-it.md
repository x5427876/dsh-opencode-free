# Agent Note: 裁定在确认它的那一轮就要看得见

Status: implemented

## Problem

`state.models` 是轮次**开始之前**派生的。一轮里新确认的 Off 裁定落在 `state.probes` 与磁盘上，却不在选择器和面板读取的那份列表里。

后果正是用户描述的那种体验的最后一层：点「立即探测」，看一��全绿的进度条，**然后什么也没变**——尽管那一轮刚刚用九次请求确认了 `off: "none"`。要等到下一次目录同步（6–24 小时）或重启 DSH 才看得见。

它之所以没被当成 bug，是因为**它不丢数据**：`measuredEffortMap` 在派生时读 `record.probes`，所以证据一直都在，下一次同步一定会采用。它是延迟，不是丢失——但在「点了没用」这件事上，用户分不出这两者。

## Decision

轮次收尾时**用它刚写的证据重新发布列表**，并把派生收敛成**一个所有者**：

- 抽出 `deriveWithEvidence(state, deps, section)`——models.dev 字典 + 本进程已量测到的一切（Off 行、自述词表）。
- `adopt()`（暖启动）与轮次收尾**都调用它**。两个调用方不可能对同一份证据给出不同答案。
- 收尾时若 `state.cache` 非空就重建 `state.models`，随后 `applyMeasuredChannel` 重施已实测通道。

**刻意不调用 `adopt()`**：`adopt` 会**从 record 恢复** `state.reach` 与 probe map，那会把本轮刚推进的节奏条目回滚掉。暖启动与轮次收尾在这一点上是相反的方向，不能共用同一个入口。

## Alternatives considered

- **只在面板上加一行「已确认，下次同步后生效」**——诚实，但把成本转嫁给用户：一次 45 次请求的点击，要等最多 24 小时才知道结果。可用性问题没有被解决，只是被加上了脚注。
- **每写一条记录就重建一次列表**（与 `applyMeasuredChannel` 现在的时机一致）——更即时，但一次点击里会重建九次，而重建是对 36 条记录的纯计算。收尾一次足够，且语义更清楚：**一轮 = 一次发布**。
- **让 `applyMeasuredChannel` 顺便重建档位表**——把两件事塞进一个名字。它现在只改通道，混进派生会让「已实测的通道」这个可独立测试的小函数背上整份派生。

## Consequences

- **收益**：确认即可见。测试 `GUARD: a verdict is visible in the same round that confirms it` 钉住这一点，并同时断言 `contextWindow` 没有跟着动（防止重建顺手改到别的字段）。
- **代价与已知上限**：轮次收尾多一次对 36 条记录的纯计算，每轮一次，不可测为零成本。**没有网络请求**，不花额度。
- **代价**：`state.models` 现在会在轮次中途被换掉一次（收尾时）。任何持有旧数组引用的代码会看到旧值——`effectiveList()` 与 `current()` 都是每次重新读取 `state.models`，没有缓存引用；这条由现有测试全绿覆盖。
- **范围**：夹逼抬窗（`observeClamp`）写进 `probes[id].context` 后同样会经由这次重建生效——那是好事，但它的**自身**可见性仍取决于夹逼真的发生过，本条不改变那件事。

## Verification

- `GUARD: a verdict is visible in the same round that confirms it`：刷新后 `off === null`，跑完一轮后 `off === "none"`，且 `contextWindow` 不变。变异验证：删掉收尾的重建，测试失败。
- 其余 138 条目录测试通过；暖启动路径改用同一个 `deriveWithEvidence` 后行为不变（既有重启类测试覆盖）。