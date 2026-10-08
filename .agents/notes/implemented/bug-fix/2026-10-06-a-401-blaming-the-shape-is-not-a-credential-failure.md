# Agent Note: 说「形状不对」的 401 不是凭据问题

Status: implemented

## Problem

使用者指出一个矛盾，而矛盾是真的：**「你正在对话的这个模型就是 space-bunny，
探针却说它测不到。」**

2026-10-06 的逐项取证，每种请求各探五次：

| 请求 | 结果 |
|---|---|
| 省略（存活性） | **200，5/5** |
| `reasoning_effort: "low"` | **200，5/5** |
| `reasoning_effort: "none"` | **被拒，5/5** |

模型完全可用。不可用的是**某一个拼写**。而两条通道对同一次拒绝的措辞不同：

```
completions → HTTP 400  {"type":"invalid_request_error","message":"… invalid request"}
responses   → HTTP 401  {"type":"error","error":{"message":
                          "Model space-bunny-free is not supported for format openai"}}
```

## Root Cause

**按状态码分类，先于正文。** `classifyZenFailure` 里 `status === 401` 直接落进
`bad-key`，而 `ANON_GATED_PATTERN`／`QUOTA_PATTERN` 都不匹配这句正文——
它根本没被读过。于是：

1. 这句 401 被判成**凭据问题**；
2. `isCallerScoped` 立刻 `return`，**丢弃了另一条通道的答案**；
3. 轮次得到 `inconclusive`，面板画灰点「未测到」。

而这个模型本来只需要退到它自己的最低档位（`low`，200 且把推理从 35 降到 0/9/22）就能拿到 Off 行。
**一个可用模型被永久标成「测不到」，而它要的只是一次 fallback。**

代码里其实已经有 `FORMAT_SCOPED_PATTERN`，注释写着「走错通道时健康模型会回这句」——
但它**只**用在「是否判定为模型已死」上，**没有**用在「这是不是凭据问题」上。
同一个词，正文里的事实被读了一半。

## Decision

**形状必须活着穿过分类。**

1. `failureKindFor`：正文命中 `FORMAT_SCOPED_PATTERN` 时直接给 `unknown`——
   它说的是**请求**，不是**发请求的人**，所以不能变成 `bad-key`／`anon-gated`
   （我上一条提交为匿名凭据把 401 改读成 `anon-gated` 的规则，在形状被点名时同样不适用）。
2. `ProbeResult`／`ProbeOutcome` 带 `formatScoped: true`，把这个事实送到轮次。
3. 轮次把「形状被拒」并入 `spellingRefused`：与 400/422 同等对待。

**归属为什么成立**：轮次只在**同一通道上已经有三次成功的省略样本之后**才问拼写，
所以失败的请求与一个刚刚成功过的请求**只差被注入的那一个字段**——
这正是 ADR 0004 §二十六 要求的对照。

## Alternatives considered

- **把 401 全部当成「参数被拒」**——凭据错误会因此被记成档位拒绝，模型会退到最低档位
  并**拿到一个假的能力行**。形状要靠正文认，不能靠状态码猜。
- **只在轮次里看 `http === 401`**——轮次拿不到正文，无法区分凭据与形状；这个事实必须
  由**看过正文**的传输层带出来，放在轮次里判断只会再写一遍同样的猜测。
- **让上游那条 generic 400 触发 fallback（它是第一个通道的回答）**——不够。generic 400
  在这个 provider 上既表示参数被拒也表示上下文溢出（ADR §七），单看它无法归属；
  **带 `for format` 的那句才是有信息的那个**，所以修的是它被丢弃的路径。

## Consequences

- **收益**：`space-bunny-free` 回到可达状态，走 fallback 得到 `off: "low"`——
  与 ADR §三十一 实测的 0/9/22 对基线 35/42/55 一致。**用户正在用的模型不再显示「未测到」。**
- **代价与已知上限**：走错通道时上游回同一句话，这条请求现在会被记成
  「该拼写被拒」。但扫描仍在跑：若另一条通道答得上来，`probeModel` 先返回 `ok`，
  不会记录拒绝；**只有两条通道都拒**才会记 `rejected`。那时「这个拼写在两条通道上都被拒」
  仍然是关于拼写的合理证据。
- **代价**：多一个布尔字段，无额外请求、无额外状态。
- **不影响**：真正的凭据问题（`invalid api key` / `unauthorized`）仍走 `bad-key`，
  形状被点名的正文才会绕开它。

## Verification

- `GUARD: a 401 blaming the request shape is not read as a credential failure`（传输层）：
  喂真实正文，断言 `formatScoped === true` 且 code **不是** `bad-key`／`anon-gated`。
- `GUARD: a 401 that blames the request shape is a refusal of the spelling, not of the caller`（轮次层）：
  用 space-bunny 的形状（`none` 被拒、`low` 可用），断言轮次**移动到 `low`**、确认
  `level-works/low`、该行**不是**「未测到」。
- 两处都做了变异验证（把任一半改回去，对应测试失败）。
- 其余 272 条测试通过。