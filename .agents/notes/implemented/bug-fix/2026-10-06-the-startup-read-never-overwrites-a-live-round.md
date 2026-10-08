# Agent Note: 启动时的缓存读取不许覆盖正在跑的轮次

Status: implemented

## Problem

「重启后点探测，闪一下，然后什么也没发生。」

探测功能本身没有坏——我在现场手工跑了一轮，`requests` 从 8 涨到 12、`done` 从 30 涨到 35，
`running` 如实从 true 变 false。坏的是**面板读到的东西**。

同一时刻端点报告的是：

```
running: false   requests: 0   done: 35/35   startedAt: <这一轮的开始时间>
```

`startedAt` 是**这一轮**的，`requests` 却是 0——这不是一份旧报告，这是一个**被覆盖过的活轮次**。

## Root Cause

启动时会做一次缓存读取（`warmStart`），它带 `restoreRound: true`，把磁盘上**上一轮**那份
「已完成」的报告恢复成当前进度。而这次读取**按自己的时序落地**，一轮完全可能先开始：
每日轮正是由 `getModels()` 触发的，而那正是重启后宿主会做的事。

于是：轮次刚开始（`running: true`、`requests` 在涨、`done` 在爬）→ 启动读取落地 →
`adopt(..., true)` 把 `probeRun` 整个换成上一轮的报告：`requests` 归 0、`done` 回到旧总数、
`running` 变 false。

面板立刻采纳这份「看起来已完成」的报告并停止跟随——**用户点的那一轮在后台静默跑完，界面一动不动。**

代码里其实有一条同源的注释（2026-09-30 复现过一次「4/2」），但那道守卫当时加在**调用点**，
而真正的覆盖发生在 `adopt` 内部。

## Decision

守卫放进 `adopt` 自己：

```
if (restoreRound && state.probeRun.running !== true && restored !== undefined && …)
```

**理由**：覆盖发生在 `adopt` 里，所以规则属于它；放在调用点意味着下一个调用者要重新发现这条规则。

## Alternatives considered

- **让面板忽略 `startedAt` 早于自己点击时刻的报告**——把同一个规则写进前端，于是同一件事
  有两个判断点；而且它只挡住「显示」，挡不住 `probeRun` 被换成 `running:false`，下一次读取
  进度依然会读到假状态。
- **让启动读取等轮次结束再 adopt**——给一个只读缓存加锁，代价大于收益。
- **不恢复轮次报告，只恢复裁定与样本**——最干净，但重启后面板会完全空白（那正是 2026-09-30
  修掉的症状）。保留恢复、只加守卫。

## Consequences

- **收益**：重启后的第一轮（尤其是每日轮）能被面板正常跟随——这正是「点了没反应」的形态。
- **代价与已知上限**：如果一轮真的在跑而启动读取落地，缓存里的**裁定与样本仍然会被采纳**
  （那部分必须采纳，否则重启后已得的知识会丢）；只有**轮次报告**被跳过。这是刻意的：
  裁定是知识，进度是过程。
- **不依赖时序**：无论启动读取早到还是晚到，两种顺序都安全——早到时轮次还没开始，恢复是应该的；
  晚到时守卫挡住。

## Verification

- `GUARD: restoring a cached round never overwrites a round that is running`：用两个普通对象
  直接驱动 `runProbeRound`（与本文件其它轮次级用例同一手法），轮次在飞时调用
  `adopt(..., true)` 喂一份磁盘上的旧报告，断言 `running` 仍为 true、`done` 与 `requests`
  均未被改动。
- 变异验证：去掉 `state.probeRun.running !== true`，测试失败。
- ⚠️ 这条测试的第一版**没有抓住缺陷**：它想从 `createCatalog` 触发启动读取，但那个读取在
  构造时就发起，夹具的缓存文件写得太晚，读到的是空目录、根本没有 adopt。改成直接驱动
  `adopt` 才真正覆盖到所有者——**又一次「测试能过但什么都没证明」的形态**。
- 其余 275 条测试通过。