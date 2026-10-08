# Agent Note: 被节流的���动探测要明说，不要装作开始了

Status: implemented

## Problem

手动轮次有一个 5 分钟的下限（`FORCED_PROBE_MIN_INTERVAL_MS`），理由写在代码里：POST 路由自己没有限流，而每一轮都要从按出口 IP 共享的桶里花掉每个模型一次请求；没有下限，一次连点就能把整个办公室的额度花光。

被拒绝的点击当时是**静默**的：

- `forceProbes()` 返回 `void`；
- 路由无论轮次是否真的开始，一律回 **202 accepted**；
- 客户端 POST 成功后进入等待链，用 `startedAt` 判断「我这一轮还没发布」，于是继续轮询；
- 30 秒后（`AWAIT_GRACE_MS`）放弃，回到上一轮的报告。

于是用户看到的是：点了「立即探测」，转圈半分钟，什么都没发生，也不知道为什么。这与「点了没用」是同一种体验，尽管这里的按钮其实是**正确地**拒绝了。

## Decision

拒绝必须是一个带数字的答案，三处各承担一件事：

1. **`forceProbes()` 返回 `ProbeStart`**——`{ started: true }`，或 `{ started: false, reason: "cooldown", retryAfterMs }`，或 `running`／`unavailable`。轮次已经开始 → 202；被下限挡住 → 429 + 剩余毫秒。
2. **路由用 `probeStartResponse()` 把这个结果映射成状态码**——一个纯函数，可以离线断言，不必为测试驱动真实轮次。
3. **客户端把 429 读成「冷却中，还有 N 分钟」**——立刻释放按钮、清掉等待态，面板保持原样；不是错误，是解释。字典新增 `probeCooldown`（中英同键集），`t()` 增加 `{name}` 插值，因为这条文案必须带那个数字。

`running` 与 `unavailable` 仍然回 202：前者确实有一轮在跑，后者只发生在没有装配探针的宿主上，两者都不该让卡片报「失败」。

## Alternatives considered

- **把下限从 5 分钟放宽到 30 秒**——用户的抱怨会消失，因为点击更少被拒绝。但下限是额度决定，不是 UX 决定；放宽它等于提高误点与脚本连点的成本。正确方向是**把拒绝说清楚**，不是让拒绝变少。
- **去掉下限，改在客户端做节流**——按钮不会被静默吞掉，但 CSRF 面上的那条注释（`POST /probe` 没有服务端限流，一次恶意页面就能花光共享桶）就失去了唯一的防线。服务端下限必须留。
- **在 GET 进度读数里带 `cooldownUntil`，让面板 proactive 地显示**——更彻底，但要动 `ProbeProgress` 的契约（那里有一个测试断言精确的键集合）并改多处渲染。反���点击时的答案 + 现有提示行已经够用；真要做，属于下一轮的面板改造。
- **沿用 202，靠客户端比较时间戳自行判断**——客户端已经有 `Date.now()`，可以在点击时记下时间，超过 5 分钟就提示。但那个下限值只存在于服务端，客户端要么硬编码一份（第二权威），要么靠时间漂移猜；两边不一致时用户看到的还是错的答案。

## Consequences

- **收益**：被拒绝的点击有名字、有数字、按钮立刻可用；点击不再有「转圈半分钟然后什么都没发生」这一形态。中英两种语言都有对应文案，键集由既有的 parity 测试守住。
- **代价与已知上限**：429 是一个新的 HTTP 状态码出现在本插件的路由上。旧客户端（已经加载在页面里的那份 bundle）会把它当成失败并显示 `probeFailed`——**旧文案说「探测请求失败，可重试」，比原来的静默更糟一点点**。重载页面即可；插件升版本来也要重载宿主侧 bundle。
- **代价**：`ProbeStart` 是 `forceProbes()` 的返回值，`Catalog` 接口随之变化。唯一调用方是这条路由，无兼容负担。
- **范围**：`t()` 的插值是这次顺带补的能力——之前它只接受 `key`，任何带数量的文案都无法落地。没有别的调用点传入第二个参数。

## Verification

- `tests/catalog.test.mjs`：`GUARD: a manual round inside the floor says why it refused`——第一次点击 `{started:true}` 且探针被调用一次；60 秒后返回 `cooldown` 且 `retryAfterMs` 正确、探针**没有**被再调用；越过下限后又能开始。变异验证：把原因改成 `running`，测试失败。
- `tests/model-visibility.test.mjs`：`probeStartResponse` 的四种输入映射（undefined／started／running／cooldown）。
- `tests/client-render.test.mjs`：`a throttled click says so, with the number, instead of spinning`——POST 回 429 时卡片显示分钟数、**不**处于「探测中」、按钮立即可用。变异验证：客户端去掉 429 分支，测试失败。
- U3：新增文案键同时进中英两本字典，既有 parity 测试守住键集。