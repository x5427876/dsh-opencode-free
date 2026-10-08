# Agent Note: 上游用正文说的话，要按它说的读

Status: implemented

## Problem

这一轮剩下两个红行，各是一次误判，而且都是同一种形态：**上游用正文说了发生了什么，
插件却按状态码读。**

```
ling-3.0-flash-fin-free   400  "Upstream request failed: Endpoint is unavailable."
                          500  "Internal server error"          （另一条通道）
mimo-v2.5-free            410  {"type":"ModelDeprecated","message":
                                "… Model mimo-v2.5-free has been deprecated.
                                 Use mimo-v2.6-flash-free instead."}
                          500  "Internal server error"          （另一条通道）
```

- `Endpoint is unavailable` 说的是**路由**，不是模型——`ENDPOINT_FAILURE_PATTERN` 早就写着
  「走错端点时的句子」，但它只被用在「是否判定模型已死」上。400 本身什么都不说，于是
  `classifyZenFailure` 落到 `unknown`，面板画**红色失败**，而另一条通道还会被白问一次。
- `ModelDeprecated` 说的是**这个模型退役了，还告诉你该用哪个替代**。它以 410 到达，
  410 已在 `MODEL_GONE_STATUSES` 里，所以裁定本该是 `dead`——但兄弟通道的 500（沉默）
  把 `dead` 否决了（那条否决是对的：裸状态码正是走错通道会产生的形态）。结果一个上游
  已经明确退休的模型，在选择器里当了很多轮的红色「失败」。

## Decision

**两个正文各归各位：**

1. `endpoint-unavailable`：新的失败分类。`failureKindFor` 在正文命中
   `ENDPOINT_FAILURE_PATTERN` 时返回它（先于 401→`bad-key`），`isCallerScoped` 纳入它
   （端点对两条通道都不可达），客户端的 `CALLER_CODES` 纳入它（灰点而非红叉）。
2. `ModelDeprecated`：在 `MODEL_GONE_PATTERNS` 里加一条**以 model 为限定**的
   `models? … deprecat(ed|ion)`。它一进去就同时解决两件事：能被识别为 gone，
   **并且因为正文点名而被标成 `named`**——`named` 的「压过沉默」规则随即生效。

限定 `model` 是有意的：光秃秃的 "deprecated" 也用来描述请求字段和端点，那些不是模型。

## Alternatives considered

- **把 410／400 一律按状态判**——正是现在的错。状态码只说明 HTTP 层发生了什么，正文才说明
  上游想表达什么；ADR 0004 §7 已经记下这个 provider 上「同一句话既可能是上下文溢出也可能是
  非法参数」。
- **把 `Endpoint is unavailable` 归进 `upstream-overloaded`**——少一个分类、少一次文案改动，
  但两句话说的是不同的事（容量 vs 路由不可达），用户读到的建议也会不同。
- **让弃用只靠 410 状态、不读正文**——那正是它今天失效的原因：正文点名是它**压过沉默**的唯一依据。

## Consequences

- **收益**：`mimo-v2.5-free` 下一轮拿到 `dead` → 移出选择器（它上游推荐的替代品就是
  你已经开着的 `mimo-v2.6-flash-free`）。`ling-3.0-flash-fin-free` 的行变成灰点「上游端点不可达」，
  且每轮省下一次请求。
- **代价与已知上限**：`deprecated` 一词现在会把「模型被弃用」也算进 gone。与已有的
  `retired`/`sunset`/`discontinued` 是同一族，而上游用它的时候指的确实是模型。
- **端点不可达仍然不是 `dead`**：这正是 `ENDPOINT_FAILURE_PATTERN` 存在的理由——端点挂着的时候，
  说「这个模型没了」是不可靠的。它只是不再是模型的错了。

## 一次值得记下的实现事故

加那条正则时，我把 `\b` 写成了**退格字符（0x08）**而不是「反斜杠+b」——heredoc → python
字符串 → 文件这一路上转义多走了一层。编译通过、类型通过、文件里肉眼也像是对的，
但 `RegExp.source` 里根本没有 `\b`，于是它**永远不匹配**。

抓住它的是一个廉价的诊断动作：把模式数组临时导出，逐条打印 `source` 与 `test()` 的结果。
`source` 少了 `\b` 是肉眼看不出来的，因为 `\b` 与退格符在 `od -c` 里长得一样。

⚠️ 这已经是本会话第三次「看起来对而其实不成立」：拼错的 fixture、断言看着字典键而不是
插值后的文案、以及这一次的正则转义。三次里有两次是**靠变异验证抓住的**，一次是靠
「把内部导出来看」抓住的。**能自动检查的纪律都不代替这一步。**

## Verification

- `GUARD: a model the upstream deprecates in words is removed, not retried`：
  410 `ModelDeprecated` + 兄弟通道 500 → 断言 `kind === "dead"`、`named === true`、两条通道都被问过。
  变异验证：删掉那条正则，失败。
- `GUARD: an unreachable endpoint is a route problem, not a model failure`：
  400 `Endpoint is unavailable` + 500 → 断言 code 是 `endpoint-unavailable`、**不是** `dead`、
  且 `calls === 1`。变异验证：删掉那一行分类，失败。
- 其余 276 条测试通过。