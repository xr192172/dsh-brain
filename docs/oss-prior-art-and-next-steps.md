# 下一步 & 开源界的同类先例（2026-09-20）

> 触发：用户问两点 ——「那其实这还是在蓝绿交替的架构上，**那么下一步是什么**？」
> 以及「**开源社区里有没有同样思路的插件、或相似的基础设施**？」
> 本文只讲这两件事；架构本身的口径在 `docs/two-service-custody-review.md`（含 §8 的实验设计）。

---

## 一、下一步：**不是再改架构，而是把"判据"那一半做出来**

先接受你的判断：§8 那套 **仍然在蓝绿的路子上**（开新进程 → 实验 → 接管 → 退役）。
这不是退步，而是**分工**：蓝绿解决"怎么安全地换"，判据解决"凭什么说换得对"。
现在**只有前一半**（而且前一半刚被 09-16 修好），后一半**一行都没有** ——
连上游也没有：按 `eval` 关键词搜 `@deepseek-ai` 是 **0 命中**（2026-09-20 实测）。

⇒ 所以"下一步"是：**把自进化的闭环补上，而不是去拆服务。**

| 里程碑 | 做什么 | 判据（怎么算完成） | 需要两服务吗 |
|---|---|---|---|
| **M0**（阻塞） | 真机验收 drain：起 switchboard → 空档 `?cmd=handover` → `node scripts/verify-drain-after-swap.mjs` | `FAIL 0`，且 R9b 无"新增 seq gap" | 不需要 |
| **M1** | **实验（影子）最小闭环**：冻结任务集 + 挑战者跑在**只读沙箱** + 与现行**成对比较** + 出报告 | 对同一批任务能给出"现行 vs 挑战者"的逐项差异（成功率/工具调用数/token/延迟），且报告可复现 | **不需要**（今天的 switchboard 就能编排） |
| **M2** | 把 M1 的结论**接进现有验证闸**：`verifyCmd` + `VERIFY_ALLOW` 已经是现成接口（`tool_apply` 的 `verify=` 参数就是它） | 一次 `tool_apply(verify=…)` 在实验不达标时**真的被拒**（且记录原因） | 不需要 |
| **M3**（触发式） | 才轮到 custody 拆分（写权收授 + 前门搬家） | **触发条件**：替换频率高到"每次都要跑实验/停机"不能接受 | 需要 |

★ M1/M2 的关键判断：**"开 2 号进程做实验"不需要先把服务拆开** ——
switchboard 今天就能 spawn 一个只读沙箱里的挑战者，把同一批任务喂给两代，然后比对。
**拆服务是"替换变高频"之后才划算的优化**，不是实验的前提。这一点纠正上一轮的顺序感。

### M1 的判据设计（沿用项目既有的判据纪律，且全部可自动判定）

1. **结构/契约层**（已有）：能启动、插件树装全、工具数、`session.seq` 契约、prompt 前缀不漂移、能力注册表门。
2. **行为层**（缺的就是它）：**delta testing** —— 同一批冻结任务，量"新比旧好多少"，而不是量绝对分。
   指标分四层（这也是开源界的共识分法，见 §二表格）：
   - 质量：任务成功率、格式合规
   - 路径：工具调用次数/序列是否正确、重试次数
   - 经济性：token/任务、延迟 p50/p95
   - 漂移：与上周同类任务分布的变化
3. **holdout 冻结且放居留方**（`topics/self-evolution-design.md` 的判据阶梯）——
   评测集不能放在被评测的脑里，否则它会去优化评测集而不是任务。
4. **自动回退触发器**：不止"报错率"，还要 **cost/task、tool-call/task、latency** 越界即回退（开源界的共识做法）。
5. **环境状态污染是头号陷阱**：Agent 会改环境（文件/配置），两次实验起点不同就不可比。
   对策（开源界同样口径）：**离线重放前重置环境**；在线只做**并行、各自独立环境**的对比。
   ⇒ 我们已经有条件：`sandbox: read-only` + `sessions.fork()`（分叉会话）。

### 可以直接复用的现成件（都在**今天的**安装里，不用升级）

- `dsh-sandbox-local` / `dsh-sandbox-windows-acl` / `dsh-fs-sandbox` / `dsh-bash-sandbox` / `dsh-pwsh-sandbox`
  （profile 已装配；权限预设里已有 **`sandbox: read-only`**，见 `out/profile-dump.txt:114`）
- `dsh-workflow-worker-thread` + `dsh-tool-workflow`（把编排脚本放到 worker thread，别占宿主事件循环）
- `dsh-subagent` + `dsh-tool-subagent-control`（`list_agents` / `interrupt_agent`）—— 实验编排的骨架
- 我们自己的：`boot-health.ts`（有界等待 + 正向信号）、`drain.ts`+`sealPlan`、`spawner.ts`、
  `verifyCmd`/`VERIFY_ALLOW` 闸、`measure-context-efficiency.mjs --snapshot/--compare`（A/B 方法论）

---

## 二、开源/工业界的同类先例（逐项核实过）

### 1) 单写者 / 围栏：我们的 09-15 事故在工业界有正式名字

| 先例 | 它怎么做 | 对我们的意义 |
|---|---|---|
| **Fencing token**（Kleppmann 2016，被 etcd/ZooKeeper/Redisson 等普遍采用） | 发号者给**单调递增**的 token，**资源侧**记住"见过的最高号"并拒绝更旧的写；关键是**强制必须发生在资源侧**，且要和写在同一个原子操作里 | ★ 我们的 `writerToken`/`freezeSeq` **只发了号、没人验号**（实测空转）⇒ 这解释了 09-15 为什么挡不住。要么在资源侧强制（上游 0.1.5 的 `open(id,'write')`），要么用"终止陈旧持有者"来替代强制 |
| **Akka Split Brain Resolver**（`keep-oldest` / `lease-majority`） | 分区时**主动 down 掉一侧**，理由是"terminating those JVMs so they **cannot act on stale ownership**" | 我们 09-16 的 `sealPlan`（未确认停写 ⇒ 交出前门之前强杀旧代）**就是这条策略**。它的名字可以借用：**fencing by termination** |
| **Akka Cluster Singleton + lease** | 租约丢失 ⇒ **终止** singleton 实例，再重试获取租约；还有 hand-over 重试与"卡住就自杀重启" | 与我们的 freeze→promote→flip 同构；"租约丢了必须自停"是我们要补的态度 |
| **k8s Lease API**（`renewTime` 心跳；新的 alpha：`ControllerManagerReleaseLeaderElectionLockOnExit`） | 不靠 TTL 到期，而是**主动在退出时释放**锁，加快接管 | 我们的 drain/`retire` 就是"主动释放"；可以把 lease 的 TTL 降级为"仅崩溃兜底" |
| **Restate Virtual Objects** | 单写者实体（内嵌 KV 保证同一实体只有一个活跃调用），幂等键去重 | 与我们"一个会话只允许一个写者"完全同构；可作设计参照 |
| **Orleans 虚拟 actor / grain** | 按 id 定位、自动激活/自动回收、状态在回收前持久化、节点挂了在别处重启 | "会话即 grain"的类比成立；它的 auto-deactivation + 持久化 = 我们的 session 生命周期 |

### 2) 交接 / 监督 / 自愈：OTP 是成熟答案，但它自己也说"蓝绿更省事"

- **Erlang/OTP supervision tree**：层级监督 + 反向顺序优雅停机 + **每个子进程独立的 shutdown 超时**（`shutdown: 5000`）。
  ⇒ 我们的 `drain`（有界等待）与 `spawner.stop()`（梯度强杀）是同一套东西的手写版。
- **OTP release handling（`.appup` / `relup` / `code_change`）**：真正的热升级 + 内置回退
  （"if the installation fails, the system can be rebooted; the old release version is then automatically used"）。
- ★ **但社区的主流意见反而是**："**just do blue-green and sidestep it all completely**"
  （HN 上关于 Erlang 热更新的长期讨论里，多位生产用户的结论）。
  ⇒ **我们选蓝绿不算落后**；连有热升级能力的生态都推荐它。真正稀缺的不是"换得快"，而是**"凭什么说换得对"**。

### 3) 替换 / 实验：影子流量是最接近我们 M1 的既有做法

| 先例 | 形态 | 我们能借什么 |
|---|---|---|
| **Envoy / Istio 的 traffic mirroring（shadow）** | 把真实流量**复制**一份给新版本，新版本的结果只记录不外发 | 正是 M1 的"①影子只读"模式；"记录不外发"= 挑战者不许产生副作用 |
| **Argo Rollouts / Flagger** | 金丝雀 + 自动分析指标 + 失败自动回滚 | 自动回退触发器的工程形态（指标越界即回滚） |
| **Android A/B (seamless) update / NixOS generation + rollback** | 双分区/世代目录：整块切换 + 一条命令回滚到任一旧世代 | "上一版产物"与"回滚=切回旧目录"，比 git revert 更干净 |

### 4) 跨重启续跑：durable execution 是这一族的正式名字

- **Temporal / DBOS / Restate / Inngest / Hatchet**：把每步的输入输出记进 append-only journal，
  崩溃后**重放已完成步骤（用缓存结果，不重跑）**，从第一个未完成处继续；副作用靠**幂等键**去重。
- **关键澄清**（"Checkpointing is not durable execution"）：**checkpoint ≠ durable** ——
  checkpoint 只解决了"状态在"，**副作用去重仍要你自己做**。
  ⇒ 我们的 `session.jsonl` 已经等价于 journal/checkpoint（事件溯源 + `session/end-seed` + repair），
  所以"**重启不丢上下文**"这块我们**已经有**；**缺的是"重复副作用"的防护** ——
  而 09-15 的"两代并发写"正是这一类。**这条建议单独立案**（工具调用的幂等/idempotency key）。
- `dsh` 自己的 repair（合成 `turn/end(interrupted)`）就是"重放到一致状态"的做法，与这些引擎同族。

### 5) 判据 / 评测：工具很多，但**没有一家把环闭上**

| 开源/商业工具 | 定位 | 我们怎么用 |
|---|---|---|
| **promptfoo**（开源、本地、可进 CI） | YAML/JSON 定义任务集 + 多 provider 对比 + 回归门 | 最贴合我们"本机、无外部依赖、判据进 CI"的风格；M1 的 harness 形态可直接照它 |
| **Braintrust / LangSmith / OpenAI AgentEvals** | 托管平台：数据集、experiment 对比、trace | 偷它的**概念**（experiment vs baseline 的 diff 视图、delta testing），不必引入平台 |
| 四层指标 + 统计方法（Bootstrap / Bayesian / CUPED / SPRT） | 2026 年的通行做法 | 我们只需最朴素的一档（成对比较 + 简单置信区间），别过度工程 |
| ★ **闭环**（改动 → 非环判据 → 自动部署/回退） | **没有现成产品**：eval 平台停在"给人看报告"，部署工具（Argo/Flagger）不懂 LLM 质量 | **这一格是空的 ⇒ 我们的差异化就在这里**，也是自进化总纲要自己长出来的那部分 |

---

## 三、从先例里**现在就能采纳**的六条（都很便宜）

1. **给 fencing 正名并在资源侧强制**：`writerToken` 只发号不算围栏；要么走上游 `open(id,'write')`，
   要么明确写清我们的等价物是「**终止陈旧持有者**（fencing by termination）」——并把这点写进 lease 的注释与门。
2. **租约丢失必须自停**（Akka 态度）：任何"我可能已经失去写权"的信号 ⇒ 停止写入，绝不"继续写完再说"。
3. **主动释放优于等超时**（k8s 新特性）：`retire`/drain 主动交权，TTL 只做崩溃兜底。
4. **对齐 OTP 的停机语义**：父级逐个关停、每个子有独立超时 —— 我们的 drain 已经是有界等待，把语义写清即可。
5. **影子实验按 Envoy mirroring 的口径**：挑战者的结果**只记录不外发**，且跑在只读沙箱（我们已有）。
6. **把"重复副作用"单独立案**：durable execution 的教训是"状态在 ≠ 副作用不重复"；
   这与两代并发写同源，值得一个独立的判据（工具调用幂等键）。

---

## 四、一句话

**下一步不是拆服务，而是补上"实验/判据"这半边**（M1→M2：影子成对比较 + 接进现成的 `verifyCmd` 闸），
因为蓝绿负责"换得安全"、判据负责"换得对"，而后者**连工业界都还没有闭环产品**（eval 工具只报告、部署工具不懂质量）。
开源界能给我们的，是每一半的最佳实践：**fencing token / SBR 的"终止陈旧持有者" / OTP 的监督与停机 /
Envoy 的影子流量 / durable execution 的 journal+幂等 / promptfoo 式的本地评测门**。
