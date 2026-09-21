# VeRO 能不能接 DSH：摸底结果（2026-09-21，**实测**）

> 触发：`docs/reuse-and-composition-plan.md` §4 步 2「离线编译一次 VeRO」。
> 本轮由**子代理执行**（`DeepSeek V4.1 Flash` 路由），**主代理逐条核验**（见文末「核验」）。
> 材料：`github.com/scaleapi/vero`（MIT，clone 到 `D:\project_develop\_research\vero`，HEAD `d140001` = 2026-09-13）。
> ⚠️ 本文所有结论都标了**验证方式**；未验证的一律进 §6。

---

## 0. 一句话

**能接，但要改造、且必须在 POSIX 上。**
`command` 后端**语言无关**（可以是本地 Node/CLI，**不用容器**）；
**但在 Windows 上它直接失败**（`LocalSandbox` 的 POSIX 假设），而**在 Windows 上真能用的 `DockerSandbox` 没被接到 CLI**。
`Harbor` 原生路线（唯一能拿到 sidecar/gateway/budget 那套隔离件的路）**要求把 target 写成 Python 包 —— 那不是适配，是重写。**

---

## 1. 两条 target 后端（**决定一切**）

| 后端 | target 形态 | 语言 | 我们能用的部分 | 出处 |
|---|---|---|---|---|
| **`command`（命令行协议）** | **一个干净的 Git 仓库**（`[target] root/ref`）+ **target 之外**的 `harness_root` | **语言无关** ⇒ **可以是本地 Node/CLI** ✅ | 完整评测回路；**不需要 Harbor/Modal/Docker** | `vero/src/vero/evaluation/backends/command.py`；`vero/examples/c-matmul/vero.toml` |
| **Harbor** | **必须是可导入的 Python 包**（`agent_import_path: …:Class` + `pyproject.toml`） | **Python 锁死** ❌ | 20/40/40 + sidecar + inference gateway + 预算账本 | `harness-opt-bench/terminal-bench/baseline/build.yaml` |

### 1.1 command 后端的协议（**已核验**）

- **传参**：**argv 数组**（不经 shell），4 个占位符：
  `{workspace}` `{harness}` `{request}` `{report}` `{artifacts}`（+ `{input:NAME}`）。
- **harness 读** `{request}`（schema 1）→ **写** `{report}`（schema 1：`status` / `metrics` / `cases` / `diagnostics` / `artifacts`）。
- **评分**：`cases[].metrics` 是**任意 `dict[str,float]`**（per-case 布尔就写 1.0/0.0）；
  report 级 `metrics` 同理；目标由 `metric` + `aggregation(report/mean/median/min/max)` + `direction` + `constraints` 组合。
  ⇒ **我们自己的 oracle（node 脚本）可以直接当 evaluator**，不必改判据写法。
- ★ **坑**：`command.py` 的 `_environment()` 把 **`PATH` 固定成 `os.defpath`** ⇒ **`node` 不在其中**。
  ⇒ Node oracle/producer **必须写绝对可执行路径**，或经 `environment`/`passthrough_environment` 注入。
- ★ **坑**：`harness_root` **必须在 target 之外**（否则直接报 `command harness must live outside the editable target`）；
  target 必须 **clean**。

### 1.2 隔离机制：**真的**，而且比我们做得好（这正是价值所在）

| 机制 | 实现 | 核验 |
|---|---|---|
| **无 bind mount 的沙箱** | `docker run` **只带** `--detach --rm --workdir`（**没有 `-v`/`--mount`**）；文件靠 `docker cp` 进出；`host_path()` 返回 `None` | ✅ **我亲自 grep 过**（`vero/src/vero/sandbox.py:478-481`） |
| **推理网关 + 预算** | `InferenceScopeConfig`：`allowed_models` / `max_requests` / `max_tokens` / `max_concurrency`；`reserve()` 扣预算；超限抛 `InferenceBudgetExceeded`；三个 scope = `producer` / `evaluation` / `finalization` | 子代理读码（`gateway/inference.py`），**我未逐行复核** |
| **降权限 + 披露闸** | `sidecar/isolation.py`（`chown` + `chmod o+x` + `run_as`）；聚合披露下限 `k≤5` | 同上 |

⇒ **"isolation holds by construction" 指的是这一层**：判据与预算都在**优化器够不到**的地方。

### 1.3 ⚠️ 修正我自己的说法：**20/40/40 的"不可变"不是代码强制的**

我此前写"**20/40/40 不可变、钉在 `baseline/build.yaml`**"，**说过头了**。实测：

- `partitions/{development,validation,test}.json` = **纯 case-id 字符串数组**；
  `partitions/manifest.json` 记 `ratios` / `partition_counts` / `partition_digest` / `seed` / `stratified_by`。
- **代码层真正强制的只有一条**：**partitions 引用的 case 必须在 manifest 里**（不能偷加 case）。
- **`ratios` 与 `partition_digest` 在 `src/` 里零命中** —— 它们只出现在**生成脚本**里
  （`harness-opt-bench/scripts/partition_dataset.py`、各 benchmark 的 `scripts/partition_*.py`）
  ⇒ **不可变靠的是"由 seed 确定性重生成 + 文档流程规则"，不是运行时校验。**
  ✅ **这条否定断言我亲自 grep 复核过**（`ratios` / `partition_digest` 在 `src/` 无命中）。

⇒ **对我们的意义**：别把"它有 20/40/40"当成"它保证你不会污染测试集"。
**真正的保证在 §1.2 那套沙箱 + 网关**，而 split 的不变性是**流程纪律**（和我们的"假绿"是同一类问题的不同侧面）。

---

## 2. **实测跑通了什么**（不是"文档说能跑"）

| 动作 | 结果 | 证据 |
|---|---|---|
| `git clone --depth 1`（**系统 git**） | ✅ `d140001`，`origin/main` 存在 | 我用 `git -C D:/… log/branch -r` 复核 |
| `uv sync --all-extras` | ❌ **卡死**（19 分钟缓存零写入，手动 kill） | 根因：`dev` 组强制拉 `optimize`(litellm) 的 sdist ⇒ 需要 **Rust 工具链**（`puccinialin` 以 **≈19 KB/s** 下载，按此需数小时） |
| **`uv sync --extra harbor --no-dev`** | ✅ **秒级成功**（`scaleapi-vero==0.6.0`） | 这是绕过上面那条的**正确姿势** |
| `uv run --no-sync vero --help` | ✅ | 必须带 `--no-sync`，否则 `uv run` 会重新同步 `dev` 组再次卡死 |
| **`uv run --no-sync vero harbor build --config …/terminal-bench/baseline/build.yaml --param inner_env=modal --output …`** | ✅ **编译成功**（`Compiled Harbor task: …`） | 产物 `task.toml` / `tests/` / `environment/{Dockerfile,docker-compose.yaml,gateway,sidecar,main,overlay,agent-seed,agent-baseline}`；**我复核产物真在**；**两次编译逐字节一致** |
| `inner_env` 合法性 | 编译期**完全不校验**（`modal`/`docker`/`not_a_real_env` 都编译过）；真正支持的只有 `modal` | 子代理实测 |

---

## 3. ★★ Windows 是硬阻塞，而且**两条"借好东西"的路都指向 POSIX**

- **`command` 后端在 Windows 上直接失败**：`LocalSandbox` 用 POSIX 假设
  （`mktemp -d /tmp/…`、`realpath`）⇒ `canonicalize` 把 `/tmp/…` 解析成 **`D:\tmp\…`**（cwd 所在盘）⇒ `FileNotFoundError`。
  **node oracle 从未被调用过**（实测停在这个 `FileNotFoundError`）。
- **`DockerSandbox` 在 Windows 上实测可用**（`posix=True`、`host_paths=False`；echo/写/读/upload/ls 全通）——
  **但它没被接到任何 CLI/config/factory**：`DockerSandbox` 的引用**只在 `vero/src/vero/sandbox.py` 与它的测试里**
  （✅ 我亲自 grep 复核），`vero optimize` **也没有 `--sandbox` 选项**
  ⇒ 要用它**得自己写约 60 行 Python 启动脚本**，且 **target + oracle 都要能在容器里跑**（镜像里得有 node）。
- ★ **与另一条结论汇合**：上游 DSH `minimal`（唯一干净的工具面下界）**同样要求 POSIX**
  （笔记原文 "does not support Windows agents"，见 `docs/reuse-and-composition-plan.md` §1.1）。
  ⇒ **两件"借别人的好东西"的事，卡在同一处：我们需要一个 POSIX 底座（WSL 或 Linux 容器）。**
  这是一个**单点的基础设施决定**，不是两件事。

---

## 4. 最省的接入路径（若决定做）

**路线 A（推荐，若在 Linux 上跑）：command 后端，最少 3 个文件**
1. `vero.toml`（放在 `dsh-brain` **之外**）：`[target]` 指向一个干净的 dsh-brain 检出；`harness_root` 放 target 外；
2. `harness/` 里一个 **node oracle**（按 §1.1 的 argv + schema-1 JSON；**绝对路径调 node**）；
3. `[optimizer]`（也可 `kind="command"`，同样用 node）。
⇒ **不需要 Harbor / Modal / Docker。**

**路线 B（想要 sidecar/gateway/budget 那套隔离件）：把 DSH 重写成 Python Harbor agent 包**
（`agent_import_path` + `pyproject.toml` + `target/` + `partitions/` + `build.yaml`），要 Docker/Modal 与凭据。
⇒ **不是适配，是重写**；除非我们确实要那套隔离件，否则别走。

---

## 5. 对"我们该占的那一格"的影响

- **VeRO 已经把 L2（隔离）+ L3（循环）做完了**：无 bind-mount 沙箱、推理网关预算、producer/evaluation/finalization 三 scope、
  candidate 保留、Git 版本化 target。**这些不要再自造。**
- **它明确没有的**：**在线换血**（把选中的候选**安全地换上生产**并留证）—— 那正是我们的 switchboard
  （蓝绿 + drain + fencing + `verifyCmd` + profile 指纹记账）。
- ⇒ 组合结论不变（`docs/reuse-and-composition-plan.md` §2），而且现在**接口层面也可行了**：
  我们只需提供 **一个 node 形态的 target + oracle**，VeRO 负责选，我们负责换。

---

## 6.5 ★★★ 已在 Linux 上端到端跑通（WSL，2026-09-21 下午；我核验过产物）

**WSL 修好后**（见 `docs/wsl-recovery-2026-09-21.md`），在 `Ubuntu-24.04` 里真跑了一次完整评测：

| 结果 | 值 |
|---|---|
| 判定 | **`command` 后端在 Linux 上可用** ✅ |
| `vero evaluate` | **0.60 s** |
| `vero run`（含 1 次 produce + 2 次 evaluate） | **0.73 s**，输出 `Baseline: 00b64189…（0.0）` → `Best: 9861d58f…（1.0）` |
| 是否要凭据/网络 | **都不要**；`unshare -n`（只剩 `lo`）下 `vero evaluate` 仍成功 |
| 推荐依赖装法 | `uv sync --extra harbor --no-dev`（**别用 `--all-extras`**）+ `uv run --no-sync …` |

**最小可用配置就是一份 ~40 行的 `vero.toml`**（我读了原文）：

```toml
[target]
root = "./target"          # 一个干净的 git 仓库（≥1 commit、无未提交）
ref = "HEAD"
[backend]
id = "node-oracle"; kind = "command"; harness_root = "./harness"
command = ["/usr/bin/node", "oracle.js",
           "--workspace","{workspace}", "--request","{request}",
           "--report","{report}", "--artifacts","{artifacts}"]
[[evaluations]]            # 用例集
name = "smoke"; agent_can_evaluate = true; agent_visible = true; agent_selection = "arbitrary"; disclosure = "full"
[protocol]
selection_evaluation = "smoke"; timeout_seconds = 120; max_proposals = 1
[objective]
metric = "pass"; direction = "maximize"
[[objective.constraints]]
metric = "pass"; operator = "=="; value = 1.0
[session]
id = "…"; directory = "./.vero/baseline"
```
再加 5 行 `[optimizer] kind="command"; root="./producer"; command=["/usr/bin/node","fix.js","--workspace","{workspace}"]`
⇒ **优化器也只是一个命令**（我们自己的 Node producer 就能当）。

**产物结构（核验过真在）**：`.vero/<session>/evaluations/<eval-id>/{evaluation.json,cases/,artifacts/}`、
`.vero/<session>/candidates/{records/,repository.git/}` ⇒ **每个候选被提交进一个 git 仓库**（"版本化 artifact"属实）。
`evaluation.json` 里有 `schema_version:1`、`lifecycle:"complete"`、candidate 的 `id/version/parent_id`、
evaluation_set 的 `partition`/`selection`、以及 `limits`（`timeout_seconds`/`case_timeout_seconds`/`max_concurrency`/
`error_rate_threshold`/`retry{max_attempts, retry_on_timeout, retry_status_codes:[429,503,529]}`）。

**Node oracle 的四个限制（实测）**：① `PATH` 被钉成 `os.defpath`（oracle 实测拿到 `env_path=/bin:/usr/bin`）
⇒ **node 用绝对路径**；② 环境只注入 `PATH/LANG` + `TMPDIR/TMP/TEMP/SYSTEMROOT`，其余靠 `[backend.environment]`
/`passthrough_environment`；③ 协议是 **argv + 文件**（不是 stdin/stdout）；④ cwd = `harness_root`。
另：report 里的 artifact 路径是**相对 `{artifacts}` 目录**的（写 `"oracle.log"` 而非 `"command/oracle.log"`；`command/{stdout,stderr}.log` 是后端自己加的）。

### 对我们的结论

**L2（隔离/拆档）+ L3（version→evaluate→select）现在可以整层交给 VeRO**，我们只需提供：
**① 一个干净的 git 仓库当 target（放我们的 profile/preset 声明）+ ② 一个 Node oracle（我们的判据）+ ③ 一份 ~40 行 `vero.toml`**。
离线、亚秒级、无凭据 ⇒ 可以进 CI。

---

## 7. 未验证 / 没把握（诚实清单）

1. **`uv sync --all-extras` 未完成** ⇒ `optimize` 相关代码路径（`vero` agent / `openai-agents`）**未验证**。
2. **`harbor build` 只验证了"编译"**，**未跑 `vero harbor run`**（需 Modal 凭据；内层 harness 要 Linux + `run_as`）。
3. **Node 靶子的端到端评分没跑通**（被 `LocalSandbox` 挡在 staging 前）。
4. **`DockerSandbox` 只验证了基础能力**（create/run/读写/upload），**没验证** `create_optimization_session + DockerSandbox` 的完整回路。
5. §1.2 的**网关/降权限/披露闸**三条我只读了子代理的转述，**未逐行复核**（沙箱那条我已亲自 grep 复核）。
6. **"在 Linux 上 command 后端能否真跑通"未验证** —— 这是路线 A 的**唯一前提**，也是下一个最小动作。

---

## 附：核验记录（主代理做的，不是重跑子代理脚本）

| 子代理的断言 | 我用的独立方法 | 结果 |
|---|---|---|
| clone 成功 | `git -C D:/… log/branch -r` | ✅ `d140001` / `origin/main` |
| `harbor build` 跑通 | **看产物目录**（`task.toml`/`tests`/`environment`） | ✅ 产物真在 |
| `ratios`/`partition_digest` **无**代码强制（否定断言） | 自己 `grep` 全仓 `*.py` | ✅ 只在生成脚本里 |
| `DockerSandbox` 未被 CLI/config/factory 引用 | 自己 `grep` 全仓 | ✅ 只在 `sandbox.py` + 其测试 |
| `docker run` 无 bind mount | 自己 `grep` `sandbox.py:478-481` | ✅ 只有 `--detach --rm --workdir` |
