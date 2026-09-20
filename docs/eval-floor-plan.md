# 公开靶场"地板"：能接什么、怎么接（2026-09-20 16:30，Docker 已就绪）

> 定位（两层用法，来自 `docs/agent-eval-arenas.md`）：**公开题集 = 地板（不许退化）**，
> **自有题集 = 判据（是否变好）**。本文只讲地板怎么接，不讲判据。
> 前提（今天已具备）：Docker 引擎 **28.0.4** 可用、`docker pull` 通（走 Windows 系统代理）、
> `hf-mirror.com` 可达（HF 数据集可拉）、`raw.githubusercontent.com` 可达（仓内题集可拉）。

## 1. 三档，按"接入成本"排序（先说结论：先接 A 档）

| 档 | 数据集 | 要不要容器 | 接入工作量 | 能不能当"地板" |
|---|---|---|---|---|
| **A** | **BFCL**（工具调用正确性，400+ 题/档，纯 JSON） | 不要 | **小**：下载 + 把合成函数注册成工具 | 可以（工具面正确性的地板） |
| **B** | **Terminal-Bench**（真实容器任务：`tasks/<名>/{task.yaml,solution.sh,tests/}`） | 要（Dockerfile 自建） | **中**：抓题 + 写薄 harness | **最好**（真任务、真判据、真容器） |
| **C** | **SWE-bench Verified/Pro**（500/731 题，per-task 镜像） | 要（GB 级镜像/题） | **大**：官方 harness + 逐题镜像 + patch 抽取 | 强，但**应单独立项** |

**为什么 A 档便宜但有坑**：BFCL 的"函数"是**合成的**（`calculate_triangle_area` 之类），
我们的 Agent 工具表里没有它 ⇒ 要么**注册这些合成函数**（一次性的注册层），
要么只把这批题**降级成"结构化输出"题**（要求它按 schema 产出调用，不看真实执行）。
⇒ A 档先做"注册层"版本，才算真地板。

## 2. B 档（Terminal-Bench）的薄 harness 设计 —— 推荐路线

**核心技巧：让容器当沙箱，让我们的 Agent 用 `docker exec` 去操作它。**
这样**不需要**改 DSH 的工具面（agent 的 `pwsh` 工具本来就能跑 `docker exec`），也不需要 Harbor/Daytona。

```
scripts/eval-floor.mjs --family terminal-bench --task <name>
  1. 抓题：raw.githubusercontent.com/laude-institute/terminal-bench/main/tasks/<name>/…
     （task.yaml / Dockerfile / tests/ / solution.sh；只抓**定义**，不抓官方 harness）
  2. 建环境：docker build -t dsh-floor/<name> tasks/<name>  → docker run -d --name dsh-floor-<name>
  3. 发题面：把 task.yaml 里的 instruction 发给一个**新建空会话**，
     并附上"你只能通过 `docker exec dsh-floor-<name> bash -lc '<cmd>'` 操作环境"的硬规则
  4. 等它停（同 eval-run 的轮询 + 预算）
  5. 判据：把该题的 tests 拷进容器跑（`docker cp` + `docker exec … sh -c '<tests>'`）⇒ 退出码
  6. 记账：复用现有 `analyzeTrajectory`（工具调用/危险动作）+ tokens/墙钟
  7. 清理：`docker rm -f dsh-floor-<name>`（**注意**：本机不许用 `Remove-Item`，但 docker rm 是另一回事，可用）
```

**风险与纪律**：
- 只在**指定的容器**里动手 ⇒ 与本机工作区**零冲突**（比现在的 seed 方式更干净，能与主实验并行！）；
- 镜像体积要控制（先挑小的题）；`docker system prune` 之类**不做**（可能删掉用户镜像）；
- 判据**必须来自题目自带的 tests**，不是我们自己写的（否则又变成自出题自判卷）。

## 3. 我的建议顺序

1. **先 C（自有难题 cli-0004）** —— 让判据有区分度是当前最缺的；
2. **再 B 档**（Terminal-Bench 薄 harness，5–10 题）—— 它同时给我们"真容器 + 真判据 + 与主实验可并行"；
3. A 档（BFCL）当"工具面正确性"的补充地板，最后做；
4. C 档（SWE-bench）**单独立项**：它需要逐题镜像与 patch 抽取，属于"一周级"的活，别混在今天的迭代里。
