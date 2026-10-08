# Agent Note: 记录不得丢掉本轮没有重新推导的证据

Status: implemented

## Problem

探针记录每轮是**整条重写**的：

```
state.probes[model.id] = { verdict, at, ...本轮推导出来的若干字段 }
```

没有 `...prior`。任何本轮没有重新推导的字段就此消失——包括 `effortBaselineTokens`、`effortTokens`、`effortSamples`、`effortDiscord`、`effortFrozenAt`、`selfReported`、`context`、`contextHits`、`api`。

对档位轴来说这使**累积计数不可能成立**：候选轮不重写基线，基线轮不重写候选，于是每一轮都会把上一轮攒下的那半边清空。`EFFORT_SAMPLES = 3` 要求两侧各三个样本，而记录在两侧之间来回擦除，任何一侧都到不了三个。离线路径复算里可以直接看到这个形状：前三轮基线 `[55,55,55]`，第四轮问 `none`，基线当场变成空数组。

被连带擦掉的还有两类不属于档位轴的证据：

- `selfReported`——某次拒绝里自述的档位词表。它是**该模型唯一一次**说「我接受哪些值」的机会，擦掉之后只能重新花一次请求去撞同样的 400。
- `context`／`contextHits`——夹逼观测。实测过的上下文窗口因此可能被一轮无关的存活性探测抹掉，而那正是 C4 自我纠错写下的唯一副本。

## Decision

重写时**先铺开上一条记录**，再由本轮的推导结果逐字段覆盖。

```
state.probes[model.id] = { ...prior, verdict, at, ...本轮推导出来的字段 }
```

关键在于「铺开」不等于「什么都留」：`verdict` 与 `at` 每轮无条件重写，`reason` 在本轮没有理由时必须**显式删除**，否则一个曾经 `dead` 的模型答上来之后，行上还挂着旧的死亡说明，面板会把它当成当前状态展示（U2 禁止的正是这件事）。

于是分工变成：**本轮不推导的证据字段一律保留，本轮推导的一律以本轮为准，理由字段每轮重判。**

「不推导就保留」也是持久化契约的一部分：`writeCacheAtomic` 写的就是 `state.probes`，所以保留发生在写盘之前，写盘只是它的后果。

## 读盘一侧是同一条规则

`readProbes` 是这条规则的另一半，而它当时漏了三个字段，使**写盘那一半成了虚构**：

| 字段 | 读盘时的旧行为 | 后果 |
|---|---|---|
| `selfReported` | **完全不读** | 拒绝里自述的档位词表只存在于内存。ADR 0004 §33/§34 的整条「`zzz` 收割」通道，每次重启就归零一次 |
| `effortFrozenAt` | **不读** | 确认过的裁定在每次重启后立即被重新诉讼，30 天 TTL 形同虚设 |
| `effortQuestion` | 只接受 `none` 与 `minimal` | 任何**档位**问题被判非法而丢弃。space-bunny-free 的 `low` 因此在重启后被改问 `none`——正是 models.dev 梯级拒绝的那个拼写 |

现在三个字段都被读回，`effortQuestion` 的合法性由 `isEffortQuestion` 判定（`none`、`baseline`，或 pi-ai 词表里的档位名），而不是一份写死的两个字面量。`contextHits` 也一并读回：它原本被注释称作「仅内存」，但既然轮次每轮都写它、而夹逼抬窗需要连续两次观测，**不读回等于让重启替用户重置置信度**——方向上是更危险的一侧。

读盘的防御性保持不变：形状不对的条目仍然丢弃而非抛错，非法字段逐个过滤而不是整条作废。

## Alternatives considered

- **只显式补回那几个已知字段**（`...(isBaseline ? {} : { effortBaselineTokens: prior?.effortBaselineTokens })` 一类）——看起来更保守、不动任何其他字段。但它把「本轮没推导」这个判断复制到了每一个字段上：新增一个证据字段的人必须记得给它补一行，否则同样的丢失换个地方再发生一次，而丢失是静默的。铺开一次比守住 N 个出口更可靠。
- **把记录改成不可变更新（`Object.assign({}, prior, patch)`）**——与铺开等价，只是把「删掉 reason」这件事藏进 patch 里，少一处可读性，收益为零。
- **把证据从 `ProbeRecord` 拆到并列的 `evidence` 字段**——结构上确实更干净（裁定与证据不再混在一张记录里），但那是 schema 迁移，会牵动读盘、指纹校验与全部既有测试；当前缺陷不需要这么大的动作，先把正确性拿回来。

## Consequences

- **收益**：基线与候选可以同时累积，`EFFORT_SAMPLES` 第一次有意义；`selfReported` 与 `context` 不再被无关的一轮擦掉。三者都不需要新字段、新接口或新请求。
- **代价与已知上限**：`...prior` 让一条**过时的**证据也能存活到下一轮。指纹守卫（`effort.fp`／`context.fp` 对当前声明）正是为此存在的：声明一变，读侧就丢弃那份测量。铺平不检查指纹——指纹由 [measuredEffortMap](../../../../src/catalog.ts) 在应用时校验，而不是在保存时。
- **代价**：`contextHits` 现在会跟着记录落盘并在重启后从断点继续。这不改变正确性——`clampVerdict` 只把它当计数用——但它意味着抬窗需要的是**累计**两次夹逼观测，而不是每个进程两次。这是更保守的方向：不会因为重启而重复触发抬窗。
- **代价**：读盘放宽后，一个手工编辑过 `catalog.json` 的用户可以塞进一个本模块不会去问的问题。`isEffortQuestion` 是这条边界的全部防线；它接受的每一个值，`nextEffortQuestion` 都确实会再问一遍。

## Verification

- 具名测试（`tests/catalog.test.mjs`）驱动真实轮次：先跑一轮基线，再跑一轮候选，断言基线样本仍然在记录里、候选样本进了 `effortTokens`。
- 离线路径复算 `.scratch/verify/round-replay.mjs`：修复后第四轮应同时持有 `[55,55,55]` 与 `[0]`；修复前第四轮的基线为空数组。