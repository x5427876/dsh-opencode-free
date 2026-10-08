# Agent Note: 裁定的种类来自样本，不是来自我们问了哪个拼写

Status: implemented

## Problem

2026-10-06 线上，`longcat-2.5-preview-free` 拿到 `off: "minimal"`。
而它**自己保存的样本**说的正好相反：

```
effortBaselineTokens: [36, 36, 36]      ← 中位数 36
effortTokens:         [1, 36, 36, 36, 36] ← 中位数 36
EFFORT_WORKING_RATIO × 36 = 15.48        ← 36 不小于 15.48
```

**它什么都没降低**，却拿到了一行 Off。这正是我在两天前就标记「存疑、无法审计」的那个裁定——
现在样本被保留下来了，于是它可以被复算，而复算的结果与记录矛盾。

## Root Cause

轮次在**确认那一刻**，把裁定的**种类**从问题拼写重新推导了一遍：

```ts
kind: spellingRefused ? "rejected" : question === "none" ? "none-works" : "level-works"
```

而**被确认的样本本身已经带着种类**（`none-works` / `noop` / `rejected`），
`effortVerdict` 正是靠它数满三次一致。这条重新推导把样本的种类**整个丢掉**：

- 确认了一个 `noop` → 因为当时问的是 `minimal`（fallback 档位），被写成 `level-works`；
- 只有 `none` 与「档位」的措辞被区分，**「无效」与「有效」没有被区分**。

`level-works` 与 `none-works` 本来是同一个裁定、只是用被问的那个档位说话；
`noop` 与 `rejected` 是另外两个意思，**从拼写里根本推不出来**。

## Decision

**种类取自已确认的样本**，拼写只用来决定「用哪个档位的词来说」：

```
kind = "noop" | "rejected"        → 原样，不带档位
       "none-works" + question="none" → "none-works"，不带档位
       "none-works" + question=档位   → "level-works"，level = question
```

`confirmed` 现在返回**样本种类本身**（而不是一个布尔），确认块直接用它。

## Alternatives considered

- **在确认时就把样本种���写进记录，之后靠读侧纠正**——同一个缺陷的另一种写法，且更晚才暴露。
- **把 `level-works` 这个种类删掉，只保留 `none-works` + `level` 字段**——更干净，但
  `noop` 与 `rejected` 仍然要存在，而它们与「none-works」是同一维度上的不同取值；
  把「有效」拆成两个字段会让 `thinkingLevelMapFor` 多一处判断。现状三种取值够用。
- **让 `level-works` 携带它判定的那个中位数，便于复核**——好主意，但不是这条缺陷的修复，
  而且记录已经保留了全部样本，复算随时可做。

## Consequences

- **收益**：`noop` 与 `level-works` 不再混同。longcat 这一类模型会拿到 `off: null`——
  **撤销一条错误的承诺，而不是继续保留它**。这与 ADR §三十一 的决策树一致：
  `off → "none"（实测精确零）→ 最低可用档位 → 无此档位者才 null`。
- **代价与已知上限**：**已有的裁定不会被追溯更正**。longcat 当前记录里的
  `level-works/minimal` 是旧代码写的；它会在 30 天 TTL 到期、或 models.dev 的声明
  变化（指纹失效）时被重新测量。要立刻更正，可以删掉那条记录的 `effort` 字段——
  我没有替使用者改他的缓存。
- **代价**：确认块多两个分支。无额外请求、无额外状态。

## Verification

- `GUARD: a spelling that reduces nothing does not become an Off row`：用 longcat 的真实
  数字（基线 36，候选全 36）跑一次手动轮，断言 `effort.kind === "noop"`、**不带档位**，
  且派生出的 `off` 是 `null`。变异验证：把种类改回「从拼写推导」，测试失败。
- 其余 271 条测试通过；`pnpm run check` 全绿。