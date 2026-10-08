# Agent Note: 量过的上下文窗口要用起来，而它必须带着自己的指纹

Status: implemented

## Problem

这是本轮工作**最后一项真正的能力埋没**，而且它落在用户开着的模型里。

`mimo-v2.6-flash-free` 在 models.dev 上声明 `limit.context: 200000`，而上游自己在 2026-10-06 的报文里写着：

> `[400] This endpoint's maximum context length is 1048576 tokens. However, you requested about 1048659 tokens (1048516 of text input, 79 of tool input, 64 in the output).`

**5.24 倍**。两个 mimo 回的是逐字相同的报文，所以过时的是**声明**，不是一个模型变了。

这一条低报的破坏方式，是整个量测体系里最阴的一种：它**不产生任何 HTTP 错误**。pi-ai 的 `clampMaxTokensToContext` 把 `max_tokens` 夹到 `max(1, ctx − 估算 − 4096)`，于是越过约 196K 之后该值塌成 **1**；实测 `max_tokens: 1` 返回 **HTTP 200、`finish_reason: length`、零字符、零错误**。DSH 的压缩阈值同时变成 `floor(0.8 × 200000)` = 160K，而不是 838K——**提前 5.24 倍丢弃已经累积的工作**。

ADR 0004 §八已经量完了受害名单（mimo ×2、nemotron-3.5-lightning 3.81×、big-pickle >5.24×），C4 的夹逼自我纠错也写好了，**但那份证据没有任何地方可以进去**：`buildModel` 只读 `limit.context`，`contextWindowFor` 只在夹逼观测写进 `probes[id].context` 之后才被调用——而夹逼要等**用户自己的会话**撞上悬崖两次才会发生。

## Decision

把量过的值接进派生，仍然**只接量过的**：

- `SEED_CONTEXT` 一张按 id 键的表，每条记 `{ declared, measured }`，注释里附上逐字报文与出处。
- `seededContextFor(record, id)` 在**声明仍等于当初量测时的那个数**时才返回，否则 `undefined`——即指纹守卫，与活体量测遵守同一条规则。
- `measuredContextFor(models, section, probes)`（与 `measuredEffortMap` 同形）在派生时收集窗口：**活体量测优先于记录值**，两者都在套用前对 `limit` 校指纹。
- 仍然是 C1：**没有量测值的模型继续用声明值**，不按区间、不按频率档猜。

**上限分两种证据强度**（2026-10-07 补记，事实就地更正）：

| 证据 | 上限 | 为什么 |
|---|---|---|
| **实测／端点自述** | 仅 `CLAMP_RAISE_CEILING`（1,048,576） | 第一人称陈述，无误判空间 |
| **推断（夹逼命中）** | `declared × 4` | 夹逼也会在**健康但上下文真的满了**的模型上命中 |

⚠️ 最初这里把 `declared × 4` 同时套在两者上，于是 `mimo` 只广告 800,000，而端点自己
说的是 1,048,576——**248K 的真实能力被一个为「推断」设计的阀挡掉了**。
`MeasuredContext` 因此带上 `source`，缺失时按 `inferred` 读（保守的一侧）。

## Alternatives considered

- **把上限从 ×4 放宽到「量测值就是真的」**——证据确实是上游自述，比夹逼猜测强得多。但 `×4` 是整套自我纠错的爆炸半径上限，两条路径共用它；为一张表单独开第二个策略，会让「抬到多少」有两个答案。现在 800K 已经拿回 4 倍，剩下的差额由 C4 在用户真的需要时再谈。
- **不落表，改成每次启动按需发一次超发请求**——最新鲜，且完全自我纠错。代价是每次启动每模型 1 次请求（ON 集 5 个 = 5 次），且需要新入口（新按钮或自动触发），是 UI 与成本的双重改动。ADR §38 已把「按需验证」列为 responses 通道的既定做法；本条只解决**已有证据无处可去**的问题。
- **按声明区间代入**（「≤262144 多半低报」）——ADR 0004 §四 已实测证伪：`ling-3.1-flash-free` 与 `nemotron-3.5-lightning-free` 声明**同一个** 262144，一个对一个错，数字格式无预测力。**明确拒绝**。
- **把 `big-pickle` 写成区间上界**（>1,048,576）——那是区间不是量测值；表里只存**实测接受过的那个尺寸**（1,048,576），应用时由上限统一裁剪。

## Consequences

- **收益**：`mimo-v2.6-flash-free` 与 `mimo-v2.5-free` 从 200,000 变成 **1,048,576**（端点自述值，5.24×），`nemotron-3.5-lightning-free` 从 262,144 变成 **1,000,000**（3.81×，端点自述），`big-pickle` 从 200,000 变成 1,048,576（该尺寸实测 200 OK）。用户取回的是**已经存在的能力**，不是新能力。
- **代价与已知上限**：这张表会随时间失真。缓解有三层——指纹（声明一变即作废）、上限（不超过声明的 4 倍）、以及失效方向的**可见性**（抬过头是响亮的 400）。若上游真的下调了某个模型的窗口而 models.dev 没跟着改，用户会看到 400 而不是静默死亡——**这正是我们要的方向**。
- **代价**：每个模型多一次 `contextFingerprint` 计算（纯字符串拼接），只在派生时发生。
- **未覆盖**：ADR §38 列出的「区间 >1048576 的两个模型（`big-pickle`、`longcat-2.5-preview-free`）只有下界」在本表里以「取上限」表达，不是精确值；`longcat` 声明 1000000 且与实测一致，不需要条目。
- **未解决**：本表只解决**已知受害者**。名单之外的模型仍按声明值广告，直到有人量过它们——这是「未量测不声称」的正常状态，不是遗漏。

## Verification

- `GUARD: a measured context window is used, and a changed declaration discards it`：
  - `mimo-v2.6-flash-free`（声明 200000，端点自述 1048576）→ **1,048,576**；
  - `ling-3.1-flash-free`（无条目）→ 262,144，声明值原样；
  - `mimo-v2.6-flash-free`（声明被改成 400000）→ 400,000，**种子作废**而不是沿用。
- 变异验证：去掉 `seededContextFor` 那一支，第一条断言失败。
- 派生的单一所有者不变：`deriveWithEvidence` 同时喂三条轴的证据，暖启动与轮次收尾共用它。