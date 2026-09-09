# dsh-brain 构造说明 — DeepSeek Harness(dsh) 上 dsh-brain 插件的构造与启动

> 本文档说明 `D:\project_develop\dsh-brain` 项目的结构、如何启动 `dsh web`、
> 如何新增/装卸插件，以及两个关键的工程注意事项（Windows junction bug、热插拔语义）。

## 1. 项目结构

```
D:\project_develop\dsh-brain\
├── .tools\node\                      # 项目内便携 Node 24.20.0（npm 11.19），dsh-brain 专用，不污染系统 Node
├── node_modules\                     # 已安装 @deepseek-ai/dsh 及整棵 DSH 依赖（454 包）
├── docs\
│   ├── ideas-spec.md                 # 5 条思路的实现无关规格（唯一解耦依据）
│   └── BUILD.md                      # 本文档
├── packages\
│   ├── conveyor-context\             # 思路 #1 传送带上下文插件（已装载）
│   └── key-pool-proxy\               # 思路 #5 多 key 轮换反代插件（已装载）
└── scripts\                          # 启动 / 修 link 用的脚本
```

## 2. 环境

- **Node**：`.tools\node\node.exe`（v24.20.0）。DSH 引擎要求 `^22.19.0 || >=24.0.0`，本工程用便携 24，与系统 Node 解耦。
- **DSH CLI**：`node_modules\@deepseek-ai\dsh\lib\bin.js`（`dsh`，版本 0.1.1-rc.2）。
- **web profile**：`C:\Users\Admin\.dsh\profiles\web\`。

## 3. 启动 dsh web

```powershell
& 'D:\project_develop\dsh-brain\scripts\start-web.ps1'
```

该脚本：从 `D:\project_develop\ai-base\agent-shell\.env` 读入 AGNES key 池（`AGENTSHELL_MAIN_LLM_API_KEYS`）与主 key（`AGENTSHELL_MAIN_LLM_API_KEY`）注入进程环境 → 用便携 Node 启动 `dsh --profile web`。

浏览器打开 **http://127.0.0.1:3080**。

插件装载日志应可见：
```
[conveyor-context] apply running; foldEveryTurns=6
[key-pool-proxy] listening 127.0.0.1:3101 -> https://apihub.agnes-ai.com (pool=3)
```

## 4. ⚠️ Windows junction bug（必读）

`dsh plugin --profile web add/install` 内部用 pnpm 建 `file:` link，在 Windows 上会把 junction 目标**拼坏**成 `profiles\web\D:\...`（把 profile 目录和绝对路径连起来），导致插件不可解析、`dsh web` 启动报 `Cannot find package '@dsh-brain/...'`。

**规避**：
- 启动前如果 junction 坏了，先跑 `scripts\fix-links.ps1` 修复；
- **启动 `dsh web` 后不要再跑 `dsh plugin ...` 命令**（它会重新弄坏 junction）；需要加/卸插件时，改完再修 link、重启 web。

修复脚本内容（把两个 `@dsh-brain/*` 指向 `dsh-brain\packages\*`）：

```powershell
# D:\project_develop\dsh-brain\scripts\fix-links.ps1
$pairs = @(
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\conveyor-context'; target='D:\project_develop\dsh-brain\packages\conveyor-context' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\key-pool-proxy';  target='D:\project_develop\dsh-brain\packages\key-pool-proxy' }
)
foreach ($p in $pairs) {
  $link=$p.link; $target=$p.target
  $ok=(Test-Path $link) -and (Test-Path (Join-Path $link 'package.json')) -and (Test-Path (Join-Path $link 'lib\index.js'))
  if(-not $ok){
    Remove-Item -LiteralPath $link -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
    if(-not (Test-Path $link)){ New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
  }
  Write-Output ((Split-Path $link -Leaf)+" lib="+(Test-Path (Join-Path $link 'lib\index.js')))
}
```

## 5. 新增一个思路插件（步骤）

以思路 #N 为例：

1. 建包：`dsh-brain\packages\<name>\`，含 `package.json`（`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）、`tsconfig.json`、`src\index.ts`（`export const name/inject/apply`）、`cordis.patch.yml`。
2. 编译：`& '<node24>\node.exe' '<dsh-brain>\node_modules\typescript\bin\tsc' -p <pkg>\tsconfig.json` → 产出 `lib\`。
3. 装载（二选一）：
   - 推荐：直接把插件行写进 **web profile 用户层** `C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml`（`insert:`），并把包 link 到 `profiles\web\node_modules\@dsh-brain\<name>`（用上面 fix-links 同款 junction 手法，**不要用 `dsh plugin`**）。
   - 或：把 `<name>` 追加进 `profiles\web\package.json` 的 `dsh.profile.bundles`（注意该文件必须 UTF-8 **无 BOM**，否则 DSH JSON 解析崩）后再修 junction。
4. `start-web.ps1` 重启 `dsh web`，日志确认 `apply` 运行。

## 6. 当前已装载插件

| 插件 | 职责 | 装载 |
|---|---|---|
| `@dsh-brain/conveyor-context` | 摘要目录 projection + `[[KEEP]]` 事实升格 + wire 视图（思路 #1） | profile bundles |
| `@dsh-brain/key-pool-proxy` | 本地反代 + 多 key 轮换（429/5xx 冷却换 key，思路 #5） | profile bundles |

## 7. 配置落点

- **AGNES provider**：`C:\Users\Admin\.dsh\settings.yaml` → `llm-pi-ai.providers.agnes`（baseURL 指向 `http://127.0.0.1:3101/v1` 代理）。
- **默认模型**：`C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml` → `agent-default-model` = `{ provider: agnes, model: agnes-2.5-flash }`。
- **key 池**：`agent-shell\.env` 的 `AGENTSHELL_MAIN_LLM_API_KEYS`（池）+ `AGENTSHELL_MAIN_LLM_API_KEY`（主），`start-web.ps1` 注入。

## 8. 热插拔语义

- 插件按 DSH 官方插件的**同款机制**装配（`name/inject/apply` + bundle + patch 行），因此是 **DSH 意义上的可插拔**：加/卸一个插件只改 profile bundles/patch 行 + junction，**无需改 DSH、无需重启编译**。
- `conveyor-context` 用 `ctx.inject(['sessionProjections'])`（effect，卸载自动注销 key）；`key-pool-proxy` 的 `apply` 返回 disposer 关服务器 → **热卸载不泄漏**。
- 未验证"在 DSH 插件清单 UI 点一下即换"的运行时热切换（那是 plugin-runner 能力）；声明式可插拔/可装卸 + disposer 干净是已保证的事实。
## 9. 脑代际蓝绿交接（Switchboard + Handover-agent）

> 目标：更新 bundle/模型不再"杀宿主进程"，而是把运行中的脑当成可替换代际，
> 走 **申请新代 → 追平 → 冻结旧 → 翻转前门 → 退役旧** 的零停机蓝绿切换。
> 宿主生命周期归控制面（switchboard）管理，agent 不再接触进程生死（防自残机制）。

### 组件
- **@dsh-brain/switchboard**（独立 Node 进程，**不进 profile**）：前门反向代理（3080，保留 Host 头，HTTP + WS 升级字节转发）+ 交接协调器 + on-disk 单一写者租约。packages\switchboard\。
- **@dsh-brain/handover-agent**（打进每个 gen 的 Cordis 插件，**进 profile bundles**）：loopback admin（health/freeze/promote/probe/retire）+ 工具子步骤静止点 freeze + 冷读暖机 caughtUpSeq + 方案③快照 seam。packages\handover-agent\。

### 启动（取代直接 dsh web）
`powershell
& 'D:\project_develop\dsh-brain\scripts\start-switchboard.ps1'
`
前门 http://127.0.0.1:3080 由 switchboard 占；每个 gen 独立端口（GEN_PORT_BASE=3081 起）；控制面 admin 在 31800。

### 交接（两次 bundle 更新无缝验证）
`ash
node scripts/e2e-handover.mjs
`
或手动：curl http://127.0.0.1:31800/?cmd=status → ?cmd=handover 触发一次蓝绿切换。
状态机：idle→spawn→ready→freeze→promote→flip→verify→retire；失败→aborted 回退保旧代。

### env 契约（start-switchboard.ps1 已设）
SWITCH_ADDR/SWITCH_PORT(3080) / SWITCH_ADMIN_PORT(31800) / GEN_PORT_BASE(3081) /
HANDOVER_ADMIN_PORT_BASE(31810) / WEB_PROFILE(web) / DSH_BIN / NODE_BIN /
GEN_ENV_EXTRA(key 池 JSON，透传各 gen) / DSH_HOME。

### 方案② 静止点（已落地）
DSH 在"模型请求前/顶级工具前/agent-pre-step"都 flush；交接切点取轮内工具子步骤之间，
已落盘子步骤由日志回放保留，只丢弃正在跑的那一个新请求。方案③（轮内任意点快照）
已留 mode/payload 槽位 + SnapshotProvider seam，未来无感升级。

## 10. 安全自进化闭环（三层护栏 + apply 动词）

> 目标：让运行中的脑能**安全地自进化**，而不是"能改但会自残"。
> 原则：**内容自由改、激活走控制面、安全层只换不就地**。

### 三层限度
| 层 | 是否允许自改 | 机制 |
|---|---|---|
| P0 内容 | ✅ 放开 | settings/模型/provider、插件数据、技能、记忆、工具行为——自由生长 |
| P1 激活 | ✅ 但走控制面 | 改完 → GET /admin :31800/?cmd=apply 蓝绿交付（spawn→追平→冻结→翻转→验证→回滚） |
| P2 安全层 | ❌ 禁就地 | switchboard 源码/协调租约/profile 注册表/杀宿主 PID/绑端口——只经整体替换进化 |

### P2 护栏（handover-agent guard.ts）
ctx.tools.guard 在工具执行前匹配参数签名，命中即拒：
	askkill / Stop-Process（自残）/ 写 packages\switchboard、.dsh\switchboard、
profiles\web\package.json|cordis.yml、harness in.js。config.guardP2 可关。

### apply 动词（switchboard main.ts）
控制面 admin ?cmd=apply 与 ?cmd=handover 同走蓝绿闭环；脑的自净化应走 apply（内容→新代→验证→回滚），而非就地换血。

### 系统提示 safety:layers（handover-agent）
注入 P0/P1/P2 边界：P0 自由；激活走 :31800/?cmd=apply；P2 只换不就地。把自净化显式绑到控制面闭环。
