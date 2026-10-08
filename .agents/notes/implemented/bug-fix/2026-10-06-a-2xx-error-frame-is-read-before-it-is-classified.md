# Agent Note: 藏在 200 里的错误帧，必须在被分类之前被读到

Status: implemented

## Problem

`nemotron-3-ultra-free` 的行长期显示 `failed / unknown / HTTP 200`。我用**一次真实请求**查到了原因（`.scratch/verify/empty200.mjs`，走插件自己的探测通道）：

```
HTTP 200
data: {"error":{"type":"server_error","message":"Streaming response failed:
 [503] Upstream error from Nvidia: Service temporarily overloaded"}}
```

上游把 503 装在一个 **200 响应的 SSE 帧**里，并且**自己说清了是临时过载**。

而插件给不出这句话，原因在记录器：

```ts
if (!response.ok) body = await response.clone().text();
```

**只有非 2xx 才读 body。** 于是一个 `ok === true` 的响应，它的 body 在任何人看到之前就被丢掉了——**上游唯一会命名自己状况的地方，恰好是插件丢弃它的地方**。分类器拿到的 `body` 是空串，只能给 `unknown（HTTP 200）`。

这解释了一个我观察了好几轮却一直没查的现象：`unknown` 这一类里混着好几种真实状况，而它们全都是「上游已经说了、我们没听见」。

## Decision

**记录器读每一个响应的 body**，上限 8 KB。

- 上限是必要的：探针的预算是 1024 token，一个病态回复不该被整段缓冲。
- 成本可忽略：这个记录器**只包裹探测请求**（`probeOnce` 里创建），不碰生产流量。
- 分类规则随之补上一条 `upstream-overloaded`：正文里出现 `temporarily overloaded` / `service unavailable` / `overloaded` / `capacity` 时，读成「上游过载」而不是 `unknown`，并给出**可以照做的建议**（稍后重试）——这是这份清单里唯一一个读者只需等待的状况。

判定顺序放在 `bad-key` **之后**：`bad-key` 讲的是凭据，优先级更高；而 `unknown` 之前没有别的分支，所以过载不会与既有分类抢位置。

## Alternatives considered

- **在 `hasAnswer()` 失败时再去读一次 body**——此时流已被 pi-ai 消费，`clone()` 拿不到东西（body 用掉即失效）。必须在 fetch 时就取。
- **只对 `content-type: application/json` 的 2xx 抓 body**——本例是 `text/event-stream`，抓不到。治标不治本。
- **把「200 但无应答」直接当成不可判定、不再细分**——那正是现在的行为，也正是用户看到「unknown」却什么都不知道的原因。上游既然自述，就该被听。
- **把 `unknown` 的文案改成「未知（可能是上游暂时故障）」**——把一个**已��判定**的情况继续含糊下去。宁可漏判，不可谎报：正文说了什么，就说什么。

## Consequences

- **收益**：`nemotron-3-ultra-free` 这类行会显示「上游过载（稍后重试）」，用户知道**不必改任何配置、只需等**。同类的 `unknown` 只要正文自述了状况，都会得到对应分类。
- **代价与已知上限**：每次探测多缓冲一份至多 8 KB 的响应副本（两个分支都被读），换一句话的可诊断性。`hasAnswer` 的判定逻辑不变——**一个 200 里的错误帧仍然不是应答**，本条只改「我们能否说出它是什么」。
- **代价**：`ProbeUsage` / 面板语义未变；`classifyZenFailure` 多返回一个 kind，因此客户端词典、`FAILURE_WORDS` 与两本语言字典同步增加一项（U3：两本字典一起维护）。
- **边界**：泛用形态的 400 仍**不作归属**。ADR §七 已记录 `big-pickle` 的上下文溢出与非法参数回逐字相同的 400，那类情况不能靠正文分辨，本条不改变它。

## Verification

- `GUARD: an overload the upstream names is named, not filed as unknown`：喂一帧真实的 503-overload SSE（HTTP 200），断言 `kind === "inconclusive"`（**仍是没答**）、`code === "upstream-overloaded"`、`http === 200`；并断言一个非过载的 503 仍然是 `unknown`。
- 变异验证：把记录器改回 `if (!response.ok)`，测试失败（`actual: 'unknown'`）——这条正是它当初能长期存在的原因。