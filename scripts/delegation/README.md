# scripts/delegation —— 把 DSH 会话当子代理用的一整套工具

> ★ **为什么在这个目录**：这一套原本住在 `out/` 下 —— 而 `out/` 是 **gitignore** 的
> ⇒ **不受版本控制 = 下一个会话看不到 = 等于不存在**（本项目"做完实质东西必须登记"那条纪律）。
> 2026-09-25 提升为受控脚本。
>
> ★ 配套 skill：`~/.workbuddy/skills/dsh-delegate-loop`（流程与坑）+ `verify-delegated-work`（核验产出）。

## 一、主入口

### `dsh-delegate.mjs` —— 派活 + 监督 + 采读数
```
node scripts/delegation/dsh-delegate.mjs --prompt <任务书> --tag <标签> --cwd <工作目录> \
  --preset standard --expect <交付文件> --rounds 3 [--budget-ms 2400000] [--stall-ms 420000]
```
做七件：建会话 → 选 preset（**回读断言**）→ 记 `before.asOfSeq` → 发指令 → 轮询到 settled
（`running:false` **且 `asOfSeq` 前进**）→ **`--expect` 交付文件不存在就自动追问**（最多 `--rounds` 轮）→ 采读数。

**退出码**：0 = 跑完且交付文件已产出；1 = 发不出去/超预算；3 = 用法错；4 = preset 回读不一致；
5 = settled 但**零工具调用**（疑似空跑）；6 = **有未决审批**（会话在等人点"允许"）；7 = settled 但 `--expect` 始终没产出。

★★ **四条已冻结的实测结论**（文件头注释里有全文，改之前先读）：
1. `session.prompt` 的形状**不是** `{sessionId, text}` —— 那样会 **HTTP 200 但什么都不做**；
   正解 `{sessionId, mode:'steer', content:[{type:'text',text}], clientTimeZone}`，端点 `POST /api/<method>`。
2. 完成判据**必须叠加 `asOfSeq` 前进**，只看 `running:false` 会把"还没起跑"判成完成。
3. **权限档位与审批应答都没有 RPC 通道** ⇒ **绝不提权**（提权 = 永久卡死，实测多轮）。
4. **运行时上下文每个 step 重发一次**，其中的「【代际身份】…【切换已完成】…恢复一切正常服务」
   会让 worker 读成"换代了，等指令"而**停工** ⇒ 这就是 `--expect`/`--rounds` 存在的原因。

## 二、半路纠正

### `steer.mjs` —— 向正在跑（或已停）的会话注入消息
```
node scripts/delegation/steer.mjs <sessionId> --from-file <文案文件>
```
- 对**正在跑**的会话：在下一个 step 边界注入；
- 对**已 settled** 的会话：**会重新起一个回合** ⇒ ★ **DSH 的"中断—继续"是天生就有的**，不需要另造机制。
- 典型用途：补边界（禁提权 / 隔离 `DSH_HOME` / 禁 `tool_apply`）、缩范围（"只做 ③④⑤"）。

## 三、观察与核验

| 脚本 | 用途 |
|---|---|
| `wait-sessions.mjs` | 前台带时限等待若干会话跑完（**不结束回合**；只在有变化时打印） |
| `last-say.mjs` | 读某会话**最近的 assistant 文本**（诊断停工点最有效） |
| `dump-session.mjs` | 导某会话的事件流（诊断协议/事件形状） |
| `audit-delegates.mjs` | ★ **委派审计**：越界写 / "上线换代"类工具 / 危险 git / 碰别的臂 / **工具失败率** |
| `find-injection.mjs` | 定位"运行时上下文重注入"发生在哪些 seq |
| `list-external-deps.mjs` | 查某脚本有没有**第三方依赖**（判断无 `node_modules` 的工作树能否跑） |

★★ **审计器的两个口径**（不写清会误判）：
- 它报的是**"企图"，不是"既成事实"** ⇒ 判"有没有真越界"**还要查目标文件在不在**。
- `git push` 之类正则**会误匹配写在报告正文里的字样** ⇒ 判据落在"命令开头/`&&`/`;` 之后"。

## 四、探针（当时的一次性实验，留着当证据）

| 脚本 | 结论 |
|---|---|
| `probe-permission.mjs` | **权限档位没有 RPC 通道**（12 个候选名全 404）；经 prompt 发 `/permission` 只当普通消息 |
| `probe-approval-answer.mjs` | **审批也没有编程应答通道**（17 个候选 + 4 个列举面全 404）⇒ 提权必挂 |

## 五、★ 哪些判据 worker **跑不了**（必须**主线代跑**）

沙箱（`workspace-write`）不区分"读"与"执行工作区外的二进制"，再加上 P2 宿主护栏会连**读**一起拦
⇒ 下面这几类判据**子代理注定跑不了**，任务书里要么**别写**，要么**明确让它写"未跑"**，
再由主线在真树里代跑。★ 这三条是我在三天里**重新发现过三次**的（L2/L3/合并各一次）。

| 判据 | worker 侧的现象 | 为什么 | 主线怎么代跑 |
|---|---|---|---|
| `scripts/gate-vector-run.mjs --impl <主仓>/out/gatecheck.exe` | `NEEDS-EVIDENCE` / `实现无法启动：EPERM`，退出码 2 | 要**执行工作区外的 `.exe`** | 主仓直接跑 ⇒ 实测 **16/16 exit 0** |
| `scripts/test-capability-gate.mjs` | 跑不动 | 它用 **`spawnSync` 起子进程**，被 sandbox/shim 拦 | 主仓跑 |
| `scripts/eval-validate.mjs`（holdout 的 R2 三段自证） | "因 spawnSync EPERM 未跑" | 同上（它要起 oracle 子进程） | 主仓跑；或让 worker **直接跑 oracle**（L3 的替代做法，如实标注） |
| 往 `D:/project_develop/_holdout/**` 写 | 被拒 / **提权后挂死** | 目标在**工作区外** | 主线代劳落盘（真 holdout 集就是这么放的） |
| 读 `packages/switchboard/**` | EPERM / 被 P2 护栏拒 | **P2 宿主护栏连"读"也拦**（每个 gen 都挂着 switchboard 这个 bundle） | 主线读；或给 worker **副本** / 只描述形状 |
| `taskkill` / 进程操作 | 被拒 | 沙箱 + 安全策略 | 主线做 |

★ **一句话**：**"能把活儿干完"与"能证明活儿干完了"在 worker 侧是两件事** ——
派活时就把后者规划到主线头上，别指望它。

## 六、与具体任务绑定的（**不是通用工具，别当通用工具用**）

- `ablate-l2-behavioral.mjs` —— 针对 `_l2/wt` 的**行为级消融**（驱动真 CLI 看真 verdict）。
  它证明了一件通用的事：**"只读源码文本"的消融是弱判据**，会给出**假结论**
  （实测：改 `verdict` 字段门纹丝不动 ⇒ 那个字段是死码；真正的闸门是 `add(..., ok)`）。
- `test-dev-mode.mjs` —— 验证控制面 dev 模式启动参数（`DSH_SWITCHBOARD_DEV`）落到子代 env，含**向后兼容**判据。

★ 这两份留在本目录是**当范本**：新任务要写判据时，先看它们**怎么把判据写成行为型**。

## 七、编排固化与按臂起代（G2）

### `round.mjs` —— 一轮委派的**一条命令**
```
node scripts/delegation/round.mjs --prompt <任务书> --tag <标签> [--cwd <工作目录>] \
  [--expect <交付文件>] [--rounds 3] [--steer <边界文案文件>] [--no-audit] \
  [--wt-new <分支名>] [--budget-ms 2400000] [--stall-ms 420000]
```
按固定顺序做完：派活 → 补边界（内置六条或 `--steer` 覆盖）→ 等第二轮 settle → 审计 → 核验交付 → 判层 → 回执表。
★ **绝不自动提交、绝不自动批票**。
- 内置边界文案来自 `out/_steer-boundary-v2.txt` 的六条（见 `DEFAULT_BOUNDARY` 常量）；`--steer <文件>` 可覆盖。
- `--wt-new` 因沙箱禁 `spawnSync` 无法自动建工作树，回执中会打印手动命令。
- ★★ **判层**已改为**调真的** `scripts/change-classify.mjs`（原内联版是子集规则 + 相对模式，
  而喂进去的是绝对路径 ⇒ 命中 0 条 ⇒ **一律落 R2 = 假绿**；已实测对照：真脚本判 R1、内联版判 R2）。
  另加 **`git status --porcelain` 回落**（worker 用 `pwsh` 重定向写时，工具参数里抓不到路径 ⇒ 曾静默漏判）。

### `launch-arm.mjs` —— 按臂起代（两种模式，必须显式选）
```
node scripts/delegation/launch-arm.mjs --arm <臂名> [--arms evals/arms.json] --mode print|flip
  [--record] [--i-know-this-flips-live]
```
- 读 `evals/arms.json`（用 `arms-registry.mjs` 的 `loadArmsRegistry`，不自己 parse）。
- 产出该臂这一代的启动规格（`profile` / `cwd` / `store` / 隔离 env）。
- `--mode print`（缺省）：**只打印**，不做任何副作用；加 `--record` 时往 `out/arm-gen-index.json` append 一条。
- `--mode flip`：**必须**同时给 `--i-know-this-flips-live`，否则 fail-closed 拒绝（非 0 退出）。
  ★ 即使给了 flag 也**只打印 URL，不实际发起换代请求**（安全约束）。
- 臂定义缺 `cwd`/`store`/`label` 任一字段 ⇒ 报错停下，不静默降级。
- `out/arm-gen-index.json` 为 append-only 索引（`{ arm, gen, profile, cwd, store, at, mode, note }`）。

### `evals/arms.json` 的 gen 绑定
★ 故意不改 schema（多脚本共享输入）。绑定走 `out/arm-gen-index.json`（append-only）。


### `isolated-instance.mjs` —— 起一套**隔离实例**（准备 + 打印，默认不 spawn）
```
node scripts/delegation/isolated-instance.mjs --arm <臂名> [--root <目录>] [--profile <剖面>] \
    [--dry-run] [--force] [--record] [--launch]
```
- 臂定义读 `evals/arms.json`（用 `arms-registry.mjs` 的 `loadArmsRegistry`，不自己 parse）。
- 缺省 `--root` = `D:/project_develop/_arms/<臂名小写>`（给用户用）；测试时须用 `--root` 覆盖。
- `--profile` 缺省 = `web`；必须真实存在于 `$DSH_HOME/profiles/`，否则 fail-closed。
- 准备内容：① `profiles/<profile>/`（`package.json`/`cordis.yml`/`cordis.patch.yml` 复制；
  ★ `node_modules` 是**真实目录 + 逐项符号链接**（不再 junction 到现役，避免改现役）；
  `@dsh-brain/arm-isolation` 额外 symlink 加入并写入 `dependencies` + `dsh.profile.bundles`）；
  ② `settings.yaml`（只改 `agent-presets.default` 为该臂的 `preset`，其余不动）；
  ③ `<root>/verifyout/`；④ key 经 env 传，不落盘。
- ★ 训练场身份：启动规格与终端命令中追加 `DSH_ARM_SELF=<臂名>` 与
  `DSH_ARM_DENY=<其它臂 cwd+store 逗号分隔>`（来源：`evals/arms.json` 经 `loadArmsRegistry`，
  不含自己）。这是 `packages/arm-isolation` 工具层护栏的输入（见 commit `594e2db`）。
- 端口段固定为 `33080/33081/33180/33190`，与现役 `3080/3081/31800/31810` 不冲突；
  ★ 若配置端口命中现役端口 ⇒ **拒绝**（防误起）。
- 缺省（无 `--launch`）：**只打印**启动规格 + JSON + 终端命令，**不 spawn**。
- `--launch`：真的 spawn（本任务禁用，仅留给用户终端）。
- `--dry-run`：完全不写盘。
- `--record`：往 `out/arm-gen-index.json` 追加 `{ arm, gen, profile, root, dshHome, ports, at, mode }`。
- 幂等：目标 `dshhome` 已存在且非空 ⇒ 拒绝（除非 `--force`）。
- ★ **限制**：脚本依赖现役 profile 的 `node_modules` 作为源（读 symlink 目标、复制 hoisted 包）。
  若现役 profile 不可读（如 P2 护栏阻断），则 `node_modules` 建不成完整版，但 `arm-isolation`
  symlink 仍会加入（目标指向 dsh-brain 仓库）。

## 八、已知限制

- `dsh-delegate.mjs` 只连**现役前门**（`:3080`），不自己起实例、不杀进程。
- `audit-delegates.mjs` 的输出默认落 `out/delegation/`（gitignore）。
- 这套工具**不替代** `verify-delegated-work` 的核验清单：核验必须**独立复算**，
  不能只跑子代理自己的脚本（那只能证明它没算错自己那套口径）。
- ★★★ **`round.mjs` 的"第 2 轮（边界注入轮）"存在长时间不收敛**（2026-09-25 实测）：
  传一个"只回一个词、不要调用工具"的极小任务 ⇒ 第 1 轮 settled、边界注入、第 2 轮 `accepted=true` 之后
  **再无输出**；**等了 17 分钟中止**（其默认预算 **40 分钟**）。
  ⇒ **§一 那条负向判据（`--expect` 永不存在 ⇒ 非 0 + "未产出"）未通过；`round.mjs` 目前只在正向可用。**
  · 规避：`--budget-ms` 调小；或先只用它跑正向轮。
  · 待查方向：第 2 轮的 `baseSeq` 是**发指令之后**才读的 ⇒ 若会话在"发指令"与"读 baseSeq"之间就 settle 了，
    `asOfSeq` 恒等于 `baseSeq` ⇒ **完成判据永不成立**（`dsh-delegate.mjs` 同结构，但它每轮都会前进所以没暴露）。

