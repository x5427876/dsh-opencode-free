# Agent Note: 被点名的「不可用」压过一句话都没说的兄弟通道

Status: implemented

## Problem

使用者报告 `deepseek-v4-flash-free` 已被官方关闭，却仍留在模型列表里、每轮被问。
取证结果（`GET /zen/v1/models`，零推理额度）：

| 事实 | 值 |
|---|---|
| Zen 自己的 `/models` | **仍然列着它**（86 个 id 里；真下架的 `glm-4.7-free` 确实不在） |
| 插件**在它实际应答的那条通道上**拿到 | `HTTP 400` — `Upstream request failed: Model is unavailable.` |
| 另一条通道 | `HTTP 500` — `Internal server error`（**对模型一字未提**） |

所以事实是：**Zen 的目录还挂着它，而它自己说不可用**。插件两条路都判不出来：
- 目录说它在 → 不会因成员资格被剔除；
- 探测拿到 400 的「不可用」→ **被判成 `dead`，然后被兄弟通道的 500 否决**。

## Root Cause

`probeModel` 的排序：`silent`（任何未结论）优先于 `last`（`dead`）。
这条规则本身是对的（ADR 0004 §二十二：一条**从未答完**的通道没有对模型说过任何话，
而走错通道时健康模型会回一句与死亡几乎相同的「不支持 for format …」）。

但它把两种完全不同的东西并成了一类：

| 信号 | 是不是「走错通道会产生的」 |
|---|---|
| 裸 404／410，正文一字未提 | **是**——正是走错通道的样子，必须被兄弟通道否决 |
| 正文点名「Model is unavailable.」 | **不是**——走错通道的那句话带 `for format`，早已被 `FORMAT_SCOPED_PATTERN` 排除 |

于是**一句 500（什么都没说）压过了一句点名的话**。`isModelUnavailableFailure`
其实早就认得这句话——它的第一条模式的注释里甚至点名了 `deepseek-v4-flash-free`。

## Decision

**区分「状态说死了」与「上游点名说死了」，并只让后者压过沉默。**

- `isNamedModelUnavailable(status, body)`：闸门／额度／key／端点／format 五种排除之后，
  只要 `MODEL_GONE_PATTERNS` 有一条命中，就算「被点名」。
- `probeOnce` 的 `dead` 带 `named: true`。
- `probeModel` 把被点名的 `dead` 收进 `namedDead`，在所有通道问完后**先于** `silent` 返回。

**否决规则没有被削弱，只是收窄到它存在的那个信号上**：裸 404 依然必须有一个兄弟通道
不同意才能成立，那条 `GUARD: dead is only concluded when every channel that was asked finished`
仍然原样通过（它的 fixture 已从带措辞的 404 改为**裸 404**，因为它要模拟的本来就是前者）。

## Alternatives considered

- **保持否决，等 500 通道也说点什么**——上游那条 500 是通用服务端错误，与模型无关，
  等它等于等一个永远不会到来的结论。这就是现状，也是模型在列表里留了几周的原因。
- **同通道再问一次作为佐证**——比跨通道更贴切（重复同一句话不是走错通道能产生的），
  但要多花一次请求，而被点名的句子**本来就已经排除了走错通道的那一句**（`for format`），
  没有第二次问的必要。
- **把 500 也算作「关于模型的失败」并直接剔除**——那是把沉默当证据。某条通道整体 500
  会让一批可用模型一起消失，正是 ADR §二十二 用六个通道样本换来的纪律要防的事。
- **让使用者手动隐藏**——`hiddenModels` 已经在做，而且使用者之前就是这么处理的。
  但那需要他知道哪个模型坏了；让插件把「自己说不可用」的模型剔掉是它本来就该做的判定。

## Consequences

- **收益**：`deepseek-v4-flash-free` 会在下一轮拿到 `dead` 并**从选择器移除**，
  恢复方式与任何 `dead` 相同（删缓存后重量）。**同状况的模型一律如此**——
  只要它自己应答的那条通道点名说不可用，就直接剔除，不再问第二遍。
- **代价与已知上限**：如果某模型在通道 A 上回「Model is unavailable」、
  在通道 B 上其实能答，我们仍会剔除它——**因为「能答」的那条结果会被更早的 `ok` 短路**
  （`if (outcome.kind === "ok") return …` 在扫描里优先），所以真正的风险只剩
  「A 先说不可用、B 只在更晚才被问到且答了」这一种，而扫描顺序是先问推断通道。
- **代价**：多一个布尔字段。纯本地判断，无额外请求。
- **不可逆性**：`dead` 是永久裁定，与既有规则一致；这意味着**误判的代价是模型消失**，
  所以被点名的句子必须强到能排除走错通道——`FORMAT_SCOPED_PATTERN` 是那道闸门，
  它在 `isNamedModelUnavailable` 里被原样保留。

## Verification

- 新增 `GUARD: a NAMED unavailability survives a silent sibling channel`：400「Model is unavailable.」
  + 500「Internal server error」→ 断言 `kind === "dead"`、`named === true`、**两条通道都被问过**
  （`calls === 2`，证明扫描没被绕过）。变异验证：去掉 `namedDead` 的优先返回，失败。
- 既有的否决测试改用**裸 404**，断言沉默仍然否决——保护的是 ADR §22 的原始场景。
- **线上实测**（`pnpm build` 后）：`deepseek-v4-flash-free` 同样两次请求，
  修复前 `inconclusive / unknown`，修复后 `dead / named: true`。