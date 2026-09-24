# `scripts/gate/` —— 提交前的门 · 门层（O110）

> 这一层是**结构性重组**的产物：把原来散落的"判层 → 挂票 → gate → 拦截"约定，
> 收进一个**单一入口 + 统一审计模型 + 明确的"可绕但可发现"契约**。
> 语义原典：`docs/handover-vs-restart.md:232-265` §6.2「无环原则（acyclic approval）」。
>
> ★ 本目录是 B2 的 O110 方案在**主仓语境**下的重放件（`scripts/` 本来就在主仓里，
>   所以是"**叠加**"而不是"整层移植"）：与 B2 隔离树版本的差异逐条列在 §6。

---

## 1. 分层图

```
        触发点（薄，可逐行读完）                      引擎（厚，只此一份）
  ┌────────────────────────────────┐        ┌──────────────────────────────────────┐
  │ scripts/git-hooks/pre-commit   │──┐     │ scripts/gate/cli.mjs  （统一入口）    │
  │ scripts/git-hooks/post-commit  │  │     │   hook pre-commit / post-commit / …  │
  │ scripts/git-hooks/post-checkout│  ├────▶│   audit / install / status / gate    │
  │ scripts/git-hooks/post-merge   │  │     │   record / approve / list / ack-commit│
  │ scripts/git-hooks/post-rewrite │──┘     └───────────────┬──────────────────────┘
  └────────────────────────────────┘                        │
                                     ┌──────────────────────┴───────────────────────┐
                                     │ core/policy.mjs  —— 【唯一策略入口】           │
                                     │  watchdog()   hooksPath 还在不在（②告警面）   │
                                     │  reconcile()  git 历史 vs 日志（②发现面）     │
                                     │  ledgerHealth()  封条链 + 未封条批准（③）      │
                                     │  preCommit()  拦                              │
                                     │  postCommit() ★ 兜底观察（①发现面）           │
                                     └───┬───────────┬───────────┬──────────────────┘
                                         │           │           │
                     ┌───────────────────┘           │           └───────────────────┐
                     ▼                               ▼                               ▼
        ┌────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
        │ core/chain.mjs          │   │ core/ledger.mjs           │   │ core/journal.mjs          │
        │ 封条链 + 锚点（底座）   │   │ 权限流（谁能提交什么）    │   │ 事实流（门看到了什么）    │
        │ 任意 JSONL 都能用      │   │ out/pending-approval/…   │   │ out/gate/journal.jsonl   │
        └────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘
                     ▲                                                     ▲
                     └──── 锚点都写在工作树之外 —— <git-dir>/dsh-gate/*.anchor ┘
                           （★ 链接工作树里 <tree>/.git 是**文件** ⇒ 用 `git rev-parse
                              --absolute-git-dir` 解析，见 core/repo.mjs:gitDirOf）

        判层规则（**单一来源，未另写一套**）：scripts/change-classify.mjs
```

**统一审计模型 = 两条流**：

| 流 | 文件 | 回答的问题 | 由谁写 |
|---|---|---|---|
| **权限流** `ledger` | `out/pending-approval/records.jsonl` | 谁**被允许**提交什么（pending / approved） | `pre-commit`（自动挂票）、`cli record`、`cli approve` |
| **事实流** `journal` | `out/gate/journal.jsonl` | 门**看到了**什么（放行/拦住/绕过/对账/漂移/篡改/确认） | 每一个触发点 |

`journal` 的条目种类：`baseline` `allow` `block` `seen` `bypass` `hooks-drift` `audit` `ack`。
其中 **`ack` 是"确认"而不是"擦除"**：对账发现"门没看见过的提交"后，只能由外部
`cli ack-commit <sha> --by … --note …` 显式确认；这条确认**本身是一条带 by/note 的封条行**，
永远留在日志里 ⇒ 绕过依然可发现，只是不再重复告警。

两条流共用 `chain.mjs` ⇒ 同一套封条口径、同一套锚点规则 ⇒ **一个复核脚本能同时体检两者**。

---

## 2. "可绕但可发现"契约（**本层的交付物就是这张表**）

| # | 绕法 | 本地能不能**堵死** | 本层的处置 | 可执行判据 |
|---|---|---|---|---|
| ① | `git commit --no-verify` | 不能（该选项的语义就是跳过钩子） | **在提交当时就发现**：`--no-verify` **不跳过 `post-commit`**（实测）⇒ 引擎发现"R0/R1 落地但无已批准记录" ⇒ **记账(kind=bypass) + 告警 + 挂 pending 票** | `out/gate/journal.jsonl` 出现 `kind=bypass`；stderr 出现绕过横幅 |
| ② | `git -c core.hooksPath=<别处> commit` | 不能（钩子目录是本地配置） | **必然被对账追上**：该提交不会被记 `seen`；`reconcile()` 在**下一次任何钩子触发**或 `cli audit` 时把"门没看见过的提交"列出来 ⇒ 告警(kind=audit)；另加 `watchdog` 对 hooksPath 本身告警(kind=hooks-drift) | `cli audit` 退出码 3；`journal` 出现 `kind=audit` 且 `unaccounted` 非空 |
| ③ | 直接往台账 append 一行 `approve` | 不能（文件本地可写，且无本地可信身份源） | **伪造留下无法自洽的痕**：只有**带封条**的 approve 才构成"已批准"；手写行缺封条 ⇒ 门**不认** + 告警(kind=tamper)；连封条一起伪造 ⇒ 还要同步改 `<git-dir>/dsh-gate/ledger.anchor`，否则封条链判"被改过"⇒ **fail-closed 拦住** | 伪造后 `cli gate --level R1` 仍**拦住**；`journal` 出现 `kind=tamper` |

★ **三条都在**；① 是"提交当时当场抓住"，②③ 是"必然被记账/告警 + fail-closed"。

---

## 3. 形状选择（为什么这么做，而不是别的）

* **为什么用 git 钩子而不是"必须走包装命令"**：门要拦的是**机器动作本身**，不是提醒（沿用 O115 的判断）。
* **为什么 `post-commit` 是①的关键**：`--no-verify` 跳过的是 `pre-commit` / `commit-msg`，
  **`post-commit` 不在其中**。这把"一步绕过"变成"一步绕过 + 当场记账"。
* **为什么锚点放 git 目录下**：封条链自己写在 `out/` 里（本地可写），锚点写在**工作树之外**
  ⇒ 只改日志不改锚点 = 链断；只改锚点不改日志 = 也对不上。
  ★ 这是"提高伪造成本到必须同步改两处"，**不是**"防得住知情伪造"。
* **为什么判层规则一行不改地复用 `change-classify.mjs`**：层级推断必须只有一处。
  本层只**补了四条 R1 规则**（见 §5），不复制规则表。
* **为什么 `record/approve` 也在本层**：让"写台账"这件事只有一个入口，
  这样封条才可能**每条都带上**（既有脚本 `pending-approval.mjs` 未被改动 ⇒
  它写的行没有封条 ⇒ 被登记为 `unsealed`，**不构成放行证据**）。

---

## 4. ★ 边界（**不许把这些说成已闭环**）

1. **本地没有可信身份源。** `approvedBy` 是自述字符串。本层**不能**证明"批的人不是 agent"。
   本层能做且只做了：让"没有封条的批准"不被采信。
2. **锚点仍在本地。** 一个**知情**的攻击者可以同时改日志与 `<git-dir>/dsh-gate/*.anchor`。
   真正封死它需要把检查放到**被治理者够不到的地方**（远端 `pre-receive` / CI、
   控制面自身、判据根离机）。本次**没有**做这三件（代价大 / 属控制面 / 判据根只读）。
3. **`git -c core.hooksPath=` 在提交当时确实没有告警** —— 因为连钩子都不跑。
   本层的承诺是"**必然被对账追上**"，不是"提交当时被堵"。
4. **`pre-commit` 与 `post-commit` 都被换掉时，只有对账**；对账要有人/有钩子触发才跑。
   `post-checkout/post-merge/post-rewrite` 是额外的触发机会，但仍非"任何时刻"。
5. **`pre-commit` 有兜底分支，所以不是 fail-closed。** 本树按"叠加而非替换"的要求，
   保留了主仓原有的 `scripts/gate-commit-check.mjs` 分支（见 §6 差异 3）⇒
   删掉 `scripts/gate/cli.mjs` 会**回落到旧检查器**；两样都没有时按主仓原语义放行。
   ★ B2 的隔离树版本此处是 fail-closed —— 这一格本层**比 B2 弱**，如实标注。
6. **本层自己不判自己的级别。** 判层规则在 `change-classify.mjs`；本层**补了四条 R1 规则**
   把门层自身与判层脚本、台账脚本、钩子目录都划进 R1（见 §5）—— 补这条规则**本身是一次 R1 改动**。

---

## 5. 规则升级（补的**四条**，属一次 R1 改动）

`change-classify.mjs` 原规则下，`scripts/change-classify.mjs` / `scripts/pending-approval.mjs`
/ `scripts/gate/**` 都落 `R2`（落进 `R2-SCRIPTS-OTHER`）—— 也就是**"决定能不能自动批准的那段代码"
本身可以自动改**，正是 §6.2 条文②要防的环。本次补上：

* `R1-GATE-LAYER-SELF`（R1）`scripts/gate/**`
* `R1-APPROVAL-CLASSIFIER`（R1）`scripts/change-classify.mjs`
* `R1-APPROVAL-LEDGER`（R1）`scripts/pending-approval.mjs`
* `R1-GATE-HOOKS`（R1）`scripts/git-hooks/**`

⇒ 之后**任何对门层自身的改动都会被自家门拦住**，须外部 approve。
（判据：`node scripts/change-classify.mjs --paths scripts/gate/core/policy.mjs` ⇒ `"level":"R1"`。）

---

## 6. ★ 与 B2 版（隔离树）的差异（逐条 + 理由）

| # | 差异 | 为什么 |
|---|---|---|
| 1 | **锚点用 `git rev-parse --absolute-git-dir`** 而不是 `<tree>/.git/…` | 本树是**链接工作树**：`<tree>/.git` 是**文件**（内容 `gitdir: <主仓>/.git/worktrees/wt3`）⇒ B2 的写法在这里会 `ENOTDIR`。B2 报告 §7.8 自己把这条列为"未验证"。 |
| 2 | `install` **值已正确时不重写** `core.hooksPath` | `core.hooksPath` 住在**共享**的仓库配置里，本工作树与主仓共用 ⇒ 避免"在重放树里跑一次 install 顺手改了主仓配置"。 |
| 3 | `pre-commit` 是**叠加**：新层优先、**主仓原检查器兜底** | 任务硬要求"保留主仓原有语义"。代价见 §4.5（残差：删引擎会回落，不是 fail-closed）。 |
| 4 | 判定后的门层文件**全部新增**（`scripts/gate/**` + 4 个新钩子），`change-classify.mjs` 只做**增量**（4 条规则 + 改陈旧注释） | 主仓本来就有 `scripts/`；整文件照搬会与主仓既有内容冲突。规则增量行尾归一后与 B2 逐字节一致（见报告）。 |
| 5 | 没有 `scripts/git-hooks/legacy/*.orig` 留档 | 那是 B2 隔离树的产物。本树的原 `pre-commit` 就在主仓历史里（`git show <prev>:scripts/git-hooks/pre-commit`），**版本库本身就是留档**，不必再塞一个 `.orig`。 |
| 6 | 报告与实验产物落在 `out/_merge/`（不是 `out/_B2/`） | 这是重放，不是同一批交付。 |

---

## 7. 复现入口

```sh
node scripts/gate/cli.mjs install --repo "$(git rev-parse --show-toplevel)"
node scripts/gate/cli.mjs status
node scripts/gate/cli.mjs audit          # 有问题 ⇒ exit 3
node scripts/change-classify.mjs --paths scripts/gate/core/policy.mjs   # ⇒ R1（自指环）
```
