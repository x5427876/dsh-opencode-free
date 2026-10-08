# Agent Note: 模型自述的档位只能证明「被接受」，不能证明「可用」

Status: implemented

## Problem

我在上一轮把「`muse-spark-1.3` 的 `max` 被扣住」列为待办，理由来自 ADR 0004 §三十三：

> `muse-spark-1.3-contributor-free` returned the same form listing `max`, which models.dev does NOT publish, at 516 reasoning tokens — the strongest mode that model has, confirmed twice.

用户指出**该档位不对个人开放**。核对之后：**用户是对的，那条 ADR 断言不成立。**

- 仓库里唯一持久的档位证据是 `tests/measured-samples.json`，它对 `max` 记的是
  **`http: 200, tokens: null, n: 1`**——**一个推理 token 数都没有**。
- 「516」这个数字在**全仓库找不到出处**：`.scratch` 里唯一的 516 是上下文报文的另一个数。
- 也就是说：**「被遵守」与「被静默降级」从未被区分过**。而 models.dev 刻意不发布 `max`，
  这正是一个不对个人开放的档位该有的样子。

代码里也确实照着这条断言实现了：`thinkingLevelMapFor` 把 `selfReported` 的档位并入
`named`，从而**解锁** opt-in 的 `xhigh`／`max`；仓库里还有一条测试
（`a level the model NAMES is offered even when models.dev omits it`）把「自述就提供」
写成了断言。所以这不是文档笔误，是一条会**真的把不存在的档位发给使用者**的规则。

## Decision

**自述不再解锁任何档位。** `thinkingLevelMapFor` 接受 `selfReported` 参数，但**不**用它决定
提供什么：

- 一个 400 里的 `allowed values: [...]` 回答的是**解析器接受哪些字串**。
- 提供一列是对**使用者会得到什么**的声明。
- 上游完全可以收下 `max` 然后路由到 `xhigh`，仍回 200——**这正是用户的假设 (c)**。

所以 opt-in 级的唯一来源回到两条：**models.dev 的声明**，或**我们量到它确实起了作用**。
自述的词表**仍然记录在案**（`selfReported` 字段照旧落盘）：它是证据，只是不再是授权。

这不是新发明，是本文件 §十九 已经拒绝过的东西在另一层的重演：**声明的「形状」没有预测力**。
模型枚举出来的词表也是一种形状。

## Alternatives considered

- **只对 `xhigh`／`max` 关闭解锁，普通档位照旧**——普通档位本来就会被提供（`else if (!OPT_IN)` 那支），所以「照旧」等于没有效果；区别只在 `named` 是否记录。保留记录更诚实，所以两者都留在 `published` 之外、但参数保留。
- **改成「自述解锁，但标注为未验证」**——把一个不可区分的控件交给用户，代价是他无法知道自己拿到的行为。
- **要求自述之外再加一次独立量测才解锁**——这是本决定隐含的规则（第二条来源），不需要额外机制：量测路径本来就会写入 `effort`。
- **删掉 `selfReported` 这条链路**——它是诊断证据（ADR §33 用它交叉验证过 fledge 的声明逐字吻合），删掉会丢失「这个模型到底接受什么」的唯一记录。保留。

## Consequences

- **收益**：一条会向使用者提供**并不存在的档位**的规则被移除。`muse-spark-1.3` 的徽章继续显示 `xhigh`——那是 models.dev 声明的、且线上确实拿到了 `level-works/minimal` 裁定的档位。
- **代价与已知上限**：如果某个模型**真的**支持一个未声明的档位（例如 muse-spark 的 `max` 若对机构开放），插件仍然不会提供它。要提供，必须先**量到它与相邻档位行为不同**——这是 ADR §二十四 的纪律（「凡打算把『某参数发出去』当作正确性证明的，必须同时测该参数取值梯度上的邻接点」）。**这个代价是有意的**：多给一列可能什么都不做的控件，比少给一列更糟。
- **无感知变更**：线上没有任何模型采到过词表（本轮核对：`catalog.json` 中无任何 `selfReported`），所以**当前部署的行为一个字都不会变**。这条修的是规则，不是现状。
- **文档同步**：ADR 0004 §三十三 与 §三十八 第 3 条已就地更正——「516 tokens、最强模式、两次确认」标注为作废，并写明它在持久证据里没有出处。这正是它误导我的地方，不改就会误导下一个人。

## Verification

- `a level the model NAMES is not thereby OFFERED`（原名 `…is offered even when models.dev omits it`）：断言无证据时被扣、**被模型点名后仍被扣**、而 models.dev 已发布的档位照旧提供。
- `the levels a host offers follow models.dev, per model`：同一断言在集成层再钉一次。
- 变异验证：把 `for (const level of selfReported ?? []) … named.add(level)` 加回去，两条测试都失败。