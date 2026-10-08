# Agent Note: 状态码要压过上游复用���那句话

Status: implemented

## Problem

上一个提交把 `Endpoint is unavailable` 提到 `classifyZenFailure` **之前**判读，
当场就被现场抓到了：

```
ling-3.1-flash-free   灰 未测到   code=endpoint-unavailable   http=429
```

一个 **429**。而它的正文是：

```
{"error":{"type":"server_error","message":"Error from provider (Console):
  Upstream request failed: Endpoint is unavailable."}}
```

**上游把同一句话用在了额度拒绝上。** 两条通道、同一个 provider、逐字相同的一句——
区别只在状态码：`ling-3.0-flash-fin-free` 是 400（端点确实不可达），
`ling-3.1-flash-free` 是 429（额度用尽）。

面板于是说「上游端点不可达」，而真正的处置是「等额度窗口」。这不是文案瑕疵，
它把用户的注意力引向一个不存在的故障。

## Decision

**状态码说话时状态码说了算，正文只在状态码沉默时用来破平。**

```
if (FORMAT_SCOPED_PATTERN.test(body)) return "unknown";   // 形状，永远先于状态
const kind = classifyZenFailure(status, body);
if (kind === "unknown" && ENDPOINT_FAILURE_PATTERN.test(body)) return "endpoint-unavailable";
```

理由是这个 provider **复用句子**。ADR 0004 §七 已经记下过同一种形态：泛用 400 既可能是
参数非法也可能是上下文溢出。当同一个词面被复用于多个状况时，**能分辨它们的就只有状态码**，
而状态码只在它明确说话时才可信（429 永远是额度，与正文无关）。

`format-scoped` 保持在最前面是有意的：形状那句话是**关于请求本身**的，它一旦成立，
状态码也就不再说明任何问题（走错通道时的 401 正是如此）。

## Alternatives considered

- **在正文里区分额度与端点**（例如看是否同时含 429 的其它措辞）——上游复用的就是同一句，
  正文里没有更多信息可挖。
- **两者都归 `unknown`，让面板自己看状态码**——把判断从**唯一**读正文的那一层挪到
  只读状态码的一层；面板本来就拿到 http，但它不该重新推导分类，那会造出第二个真相来源。
- **端点不可达不再单列，回到 `unknown`**——回到「红 失败」的老问题，等于撤销上一条提交的一半。

## Consequences

- **收益**：`ling-3.1-flash-free` 恢复成「额度用尽」灰点——那是对它当下唯一正确的处置；
  `ling-3.0-flash-fin-free` 仍然是「端点不可达」，因为它的 400 不说任何事，正文是唯一证据。
- **代价与已知上限**：一条**429 且正文说端点不可达**的失败会被读成额度用尽。若上游真的
  在额度耗尽时只是路由挂了，这会误导一次——但 429 的语义就是额度，而实测的样本支持现在的判读。
- **不改变**：两种情况都不再问第二条通道（都在 `isCallerScoped` 里），所以每轮仍然只花一次请求。

## Verification

- `GUARD: a quota refusal stays a quota refusal even when the body blames the endpoint`：
  429 + 那句逐字相同的正文 → 断言 `code === "quota-exhausted"` 且**不是**
  `endpoint-unavailable`。变异验证：把 `kind === "unknown" &&` 这个限定去掉，失败。
- 与之配对的 `GUARD: an unreachable endpoint is a route problem, not a model failure`
  （400 + 同一句）仍然通过——两条用例共用一句正文、只差状态码，所以它们同时也是
  「那句话本身不足以定性」的证据。

## 一次关于顺序的教训

我修 `Endpoint is unavailable` 时，把它**放在**了 `classifyZenFailure` 之前，理由是
「状态码在这里什么都不说」。对 `ling-3.0` 成立，对 `ling-3.1` 不成立，而后者是我**同一天**测到的。
**我有一个当天的样本，却没把它放进同一张表去对比。**

判据应该是：**当同一个正文被复用时，任何「正文优先」的规则都是错的**，除非它同时检查了
所有用过这句话的状态码。

## 一次值得庆祝的机制

这条缺陷不是我读代码读出来的，也不是变异验证读出来的——是**现场的一行数据**
（`http=429` 配 `endpoint-unavailable`）与代码里的顺序对不上，当场发现的。
从这一轮开始，「面板某行的 code 与 http 是否自洽」成了每次现场核查的固定检查项。