# Agent Note: 探针的仪表读 pi-ai 归一化后的 `Usage.reasoning`

Status: implemented

## Problem

档位轴（Off 裁定）的全部证据来自探针回报的推理 token 数，而探针读的是**插件自己那份收窄过的 usage 副本**上的 `usage.reasoning`。那份副本只填 `input`／`output`，`ProbeUsage.reasoning` 这个字段**从来没有被写入过**——类型注释甚至写着「上游未上报时为 undefined」，读起来像是「上游有时不上报」，实际是「我们从不取」。

后果不是精度下降，而是一个常量：`probeOnce` 的 `Number(usage?.reasoning ?? 0)` 于是恒为 0，于是落盘的 `effortBaselineTokens` 全是 0。轮次分类器 [effortVerdictFrom](../../../../src/catalog.ts) 的第一道守卫是 `base <= 0 → 无结论`，基线恒为 0 意味着**任何候选值都无法被判定**，因此 `effort` 裁定永不落盘，`thinkingLevelMap.off` 永远停在 `null`。

用户可见的表现是：反复手动点「立即探测」，每轮照发请求、照写基线样本，但选择器里的能力行一个字节都不会变。实测缓存里 9 条 probe 记录的 `effortBaselineTokens` 全部是 `[0]` 或 `[0,0]`，而同一批模型在持久语料 `tests/measured-samples.json` 里的真实基线是 14／16／55（big-pickle）、36／45／77（longcat）、35（space-bunny）、37（mimo）、49／30（nemotron）。

更糟的是它对 CI 完全隐形：`tests/compatibility.test.mjs` 的 `okSse` fixture 的 usage 里根本没有 `completion_tokens_details`，任何断言都只能读到 0，于是「仪表坏掉」和「模型真的不推理」在测试里长得一模一样。

## Decision

`usageOf()` 把 `usage.reasoning` 透传出来，并且**只在真的取到数字时才带上这个键**（`reasoning === undefined ? {} : { reasoning }`）。

- 数字原样透传，不做换算、不做截断、不做 `|| 0`。
- 上游没报，就让这个键缺席。**「上游没上报」与「上游报了 0」必须可区分**：前者是未量测，后者是一个真实观测，语义完全相反。
- `usageOf` 返回 `undefined` 的条件从「input 与 output 都缺」放宽为「三者都缺」，这样只有推理明细的 usage 也不会被整体丢掉。

这个决定建立在 pi-ai 已经做过归一化之上，两条通道各有各的字段名，都落在同一个键上：

| 通道 | 线上的字段 | pi-ai 归一化到 |
|---|---|---|
| `openai-completions` | `usage.completion_tokens_details.reasoning_tokens` | `Usage.reasoning` |
| `openai-responses` | `usage.output_tokens_details.reasoning_tokens` | `Usage.reasoning` |

所以仪表读的是**归一化之后**的键，而不是上游原字段名——这也是为什么它对两条通道同时成立，而 ADR 0004 §十二 记录的「responses 通道不串流推理、只能读 usage」这件事，在这里不需要任何额外分支。

`probeOnce` 里的 `?? 0` 保留：它是**分类器入口**的兜底，语义是「没量到就按 0 参与本轮比较」，而不是「仪表说它是 0」。两者的区别正是不变式「未被实测的东西一律不对使用者声称」的落点。

## Alternatives considered

- **改读流里的 `reasoning_content` delta**（ADR 0004 §三／§十二 的原始思路）——这是第一个被否掉的方案，理由是它在 responses 通道上**结构上不存在**：实测该通道的帧型里没有 `response.reasoning_summary_text.delta`，尽管 pi-ai 併送 `summary:"auto"`。拿一个只在一半通道上存在的信号当唯一来源，等于把另一半通道重新变成未量测。
- **缺省填 0 而非留空**——代码更短，且对分类器没有区别。但它会把「这条路由没报推理明细」写成「这条模型推理为零」，正是本轮次体系存在的理由（`inconclusive` 与 `ok` 的分离）要防的那种谎报。
- **在 `probeOnce` 里直接读 `result.usage.reasoning`，不动 `usageOf`**——能修好同一个 bug，但会在探针里开第二个读取点。`usageOf` 是「上游报了什么」的唯一收口，让轮次去读一份结构不同的对象，正是这份 Note 要避免的第二权威。

## Consequences

- **收益**：基线侧第一次可能非零，[effortVerdictFrom](../../../../src/catalog.ts) 才可能给出结论，`effort` 裁定才可能落盘，落盘的 `effortBaselineTokens` 才从常量变回测量值。
- **代价与已知上限**：pi-ai 的 completions 解析器把缺失的 breakdown 写成 `0`（`reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0`），所以**一条从不上报推理明细的路由，读回来仍然是 0**，本决定修不好它，只能让「上报了却被丢掉」这一类不再发生。若某个模型因此长期停在未量测，那是路由侧的事实，不是分类器的判断。
- **代价**：ADR 0004 §九 已经实测过 `reasoning_tokens` 在极小预算下自相矛盾（`max_tokens: 4` 时上游报 8 而 `completion_tokens` 是 4）。档位探针固定 `max_tokens: 1024`，这条限制继续成立；任何新写的量测代码都必须沿用同一个预算下限。

## Verification

- 具名测试 `GUARD: the probe records the reasoning count upstream actually reported`（`tests/compatibility.test.mjs`）断言**非零**值能活到 `outcome.usage.reasoning`，并断言精确 0 与「没上报」可区分。它用的 `sseWithReasoning` fixture 带真实形状的 `completion_tokens_details`；旧的 `okSse` 不带，所以这个测试在仪表坏着的时候必然失败。
- 离线复算脚本（零配额，不入库）：`.scratch/verify/probe-instrument-proof.mjs` 用真实 provider 与假上游跑 `probeModel`，复现「上游报 55、插件记 0」。

## Related

- [ADR 0004 §三十一–§三十三 与 §三十七 规则一](../../../../docs/adr/0004-measured-capability-alignment.md)——「未測量 → 去測量。形狀不是預設值的依據」这条规则，本 Note 是它在测量入口的落地前提。