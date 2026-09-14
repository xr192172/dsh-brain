# 运行时与启动

> 上级索引：`../MEMORY.md` ｜ 相关：`generation-swap.md`、`profile-and-gen-integrity.md`

## 端口与角色（2026-09-13 核实）

| 端口 | 角色 | 启动方式 |
|---|---|---|
| 3080 | 前门（front door，指向 gen A） | switchboard |
| 3081+ | gen 实例池（实测 gen A=3082、gen D=3084） | switchboard 派生 |
| 3101 | key-pool（与 gen 同进程） | 随 gen |
| 31800 | switchboard 控制面 admin（health/freeze/promote/probe/prepareSwitch/retire） | switchboard |
| 15813 | 目前是 **Go Hub**（`agent-shell.exe --hub-server`），**不是 elv/dsh-hub** | 手工 |
| 15817 | hub mock | 手工 |

- 启动器：`C:\Users\Admin\AppData\Local\Temp\start-switchboard-ascii.ps1`（纯 ASCII；从
  `D:\project_develop\ai-base\agent-shell\.env` 读 `AGENTSHELL_MAIN_LLM_API_KEY(S)` 注入 `GEN_ENV_EXTRA`）。
  等价脚本：`scripts/relaunch-switchboard.mjs`。
  注意 `NODE_BIN`/`DSH_BIN` 默认值依赖 `process.cwd()`，务必用启动器或显式设置。
- 运行中的 switchboard 实际执行的是**打包产物** `packages/switchboard/out/b*/main.js`（不是 `src/*.ts`）——
  **改了 src 必须重新构建**（`packages/switchboard/scripts/build.mjs`），`lib` 是指向最新 build 的 junction。
- **switchboard 只能由用户终端启动**：本机工具层启动的后台进程会在调用结束时被回收（详见 `../MEMORY.md` 环境约束）。

## 会话存储格式

`~/.dsh/sessions/<cwd 转义目录>/session-<id>/session.jsonl.zstd`（多帧 zstd，用 `fzstd.decompress` 解）。

- **首行是存储头记录（无 `seq`）** —— 解析时不要当事件。
- 连续 chunk 事件被 `packChunkRuns` 打包 → **记录数 ≠ 事件数、seq 不连续**。
- 排查用脚本：`scripts/session-tail.mjs`、`scripts/compaction-probe.mjs`、`scripts/measure-context-efficiency.mjs`。

## 关键配置

- `~/.dsh/settings.yaml`：`agnes-2.5-flash` → `contextWindow: 512000`、`maxTokens: 65536`。
- 压力压缩阈值 ≈ 512000 × 0.8 ≈ 409600，计入输出预留后约 303K。
- **历史会话曾长期跑在 128000**（早期配置是那个 agent 的幻觉值）。`contextWindow` 取值链：
  `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow`（`dsh-llm-pi-ai:639`）。
  所以**跨时代的数据不能直接横向比较**（压缩阈值差 4 倍）。

## LLM 凭据注入（三通道，2026-09-13 定案）

- provider `agnes` 声明 `apiKeyEnv: AGENTSHELL_MAIN_LLM_API_KEY`，
  `baseURL: http://127.0.0.1:3101/v1`（同进程 key-pool-proxy）。
- `dsh-credentials` 解析顺序：**凭据库 → 进程环境 → `.env`**。
- **首选：写进凭据库**（与启动方式解耦，重启不丢）：
  `node scripts/session-drive.mjs credset`（值取自 `ai-base/agent-shell/.env`，不打印）
  或 web Models 页写入。落盘 `~/.dsh/.credentials.yaml`，`credentials.describe` 显示 `source=file`。
- **次选：启动器双通道注入**。启动器必须**既写 `GEN_ENV_EXTRA`（JSON 对象）又 `$env:AGENTSHELL_*` 直接导出**；
  `spawnGen` 的 env 是 `{...process.env, ...envExtra}`，所以两条路都能到 gen。
- 只读体检：`node scripts/session-drive.mjs cred` → 两个 ref 都应 `configured=true`。
- **症状对照**：`llm-pi-ai: no credential for provider route "agnes"`
  = 单数 `AGENTSHELL_MAIN_LLM_API_KEY` 未解析；**复数 `AGENTSHELL_MAIN_LLM_API_KEYS`（key-pool 池）配置正常也救不了它**。
- 历史坑：启动器原先用 `Get-Content` 读 `.env`，与 node 的换行/解码切分不一致 → 只命中复数 key、漏掉单数 key。
  已改成字节精确解析。
