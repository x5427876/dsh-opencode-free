# Agent Note: 没有 key 时，401 不是「key 无效」

Status: implemented

## Problem

线上（2026-10-06）`space-bunny-free` 回 401，面板显示 **「key 无效」**——而这次部署**根本没有配置 key**：插件在没有 config、没有环境变量时发送的是字面量 `public`。

`classifyZenFailure` 只看状态码与报文：`status === 401 → "bad-key"`，于是 `ZEN_FAILURE_GUIDANCE` 里那句

> Zen key 無效。檢查 key 是否正確、過期或被撤銷

被交给一个**从未配置过 key 的用户**。这不是措辞瑕疵：它把用户的注意力引向一个不存在的东西，而真正发生的事是另一回事——**免费层被上游拒绝了**。

两者也导向不同的下一步：`bad-key` 暗示「去改配置」，`anon-gated` 说明匿名准入本身没通过，而后者已有的文案正是对的（「若有 Zen key，可透過 config.apiKey 或環境變數設定後重測」）。

## Decision

失败的**含义取决于发出去的是哪个凭据**。新增 `failureKindFor(status, body, apiKey)`：分类结果为 `bad-key`、而实际发送的凭据是空或字面量 `public` 时，**改判为 `anon-gated`**。

- 判据只有一处（`probeOnce` 的两个分类出口都走它），所以「匿名 401」与「带 key 的 401」不可能各说各话。
- **真正的 401（配置了 key）仍然是 `bad-key`**，那条建议对那类用户是对的。
- `isCallerScoped` 已经把两者都算作「关于调用方」，所以**退避与「不换通道重试」的行为不变**——只有**说的是什么**变了。

## Alternatives considered

- **只改文案**（把 `bad-key` 的提示改成中性措辞）——文案会同时服务两类人，于是对真正配了 key 的用户也变得不可操作。而信息（有没有 key）本来就该由**发送方**判断，分类器拿不到它，传输层拿得到。
- **在 `createCatalog` 里按有无配置改写 `code`**——把凭据知识搬到轮次层，于是同一个 `code` 在两层有两个含义。凭据是传输层的事实，分类属于传输层。
- **新增一个 `anon-refused` 类型**——名字更好，但 `anon-gated` 的既有文案、客户端词典与 `isCallerScoped` 都已经覆盖这个语义；新增类型只是让同一件事有两个名字。

## Consequences

- **收益**：匿名部署看到的是「匿名层被拒」，并被指向真正有用的动作（配置 key 后重测）；配了 key 的用户看到的仍然是 key 问题。
- **代价与已知上限**：分类现在依赖 `deps.apiKey`，而脚本与测试若显式传 `"public"` 却期望 `bad-key`，会读到 `anon-gated`——**这是有意的**（那个凭据确实不是 key）。相关测试已改为用真实 key，以免悄悄丢失 `bad-key` 这条路径的覆盖。
- **不改变**：请求本身、退避节奏、`untrusted` 标记、`inconclusive` 永不持久化的纪律。
- **范围**：`401` 报文里没有 `BAD_KEY_PATTERN` 命中、但状态码是 401 的情况同样适用——判据是**凭据**，不是报文的措辞。

## Verification

- `GUARD: a 401 with no key configured is the free tier refusing, not a bad key`：三种凭据（`public`、缺省、真实 key）各探一次，断言前两者是 `anon-gated`、第三者是 `bad-key`。变异验证：把改判那一行去掉，测试失败。
- 既有 `a gate or a quota wall is never retried on another channel` 改为用真实 key，它继续覆盖 `bad-key` 的通道跳过行为。