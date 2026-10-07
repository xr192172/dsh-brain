# switchboard-mcp —— 「遥控器」

把**控制面 `?cmd=` 面**包成 MCP 工具，给 agent 用。

## 为什么做这个（依据，不是拍脑袋）

`docs/launcher-function-list-2026-09-26.md` 里 **用户 2026-09-26 的原话**：

> *"我们先做一个启动器出来，就像是各种游戏一样…**做好了这个启动器之后，我们再反向把这个 API 的使用权做成工具封装好**，
> 然后你也可以用，**也可以注册到 DSH 的工具列表里面用**。"*

同一份文件的 §3 现状审计判定：**启动器缺的不是能力**（控制面 `?cmd=` 已有；桌面双击 `dsh-up.cmd` 已有；`panel` 雏形已有）——
缺的是 **G-1「管代数的门面」** 与 **G-2「面向代数的状态视图」**。
★ 而 §F0 明写「**不做 Electron，不做安装包**」⇒ 不去魔改游戏启动器 UI。

⇒ 本包就是那条"反向把 API 封装成工具"的落地。

## 它为什么**不受上游 DSH 版本影响**

| 只依赖 | 不依赖 |
|---|---|
| HTTP（控制面 `127.0.0.1:31800`）· MCP stdio 协议 | ★ **任何 `@deepseek-ai/*` 包** · 上游 `lib/index.js` · `node_modules` 的目录结构 |

★ **零依赖是故意的**：手写 stdio JSON-RPC，只用 Node 内置 `fetch` ⇒
**不依赖 `@modelcontextprotocol/sdk` 的版本与解析位置**（那正是被咬过多次的坑：pnpm 链接模式下包解析不到）。
⇒ **一个 `.mjs` 拷到哪都能跑。**

## 工具面（4 个）

| 工具 | `?cmd=` | 对应功能 |
|---|---|---|
| `switchboard_status` | `status` | **F1** 看见状态（活跃代 / 阶段 / 最近结果） |
| **`switchboard_handover`** | `handover` | **F2** 换代 —— ★ **触发后轮询到代数真的变化才返回** |
| `switchboard_flow` | `flow` | F5 留痕 / 事后复盘 |
| `switchboard_assembly` | `assembly` | "换代会换成什么" |

### ★ F2 的判据（写死在工具返回里，不留在文档里）

> **代数是「+1」还是「没动」。没动就是失败，不许报成功。**

★ 为什么必须"触发 + 轮询"：控制面的 `handover` 是**异步**的（`packages/switchboard/src/main.ts`
立即回 `started`，结果落 `handover-status.jsonl` 供轮询 —— 注释原话："阻塞会拖爆调用方"）。
⇒ **只触发的工具会永远报"成功"。**

## 装进 DSH（**已装** 2026-10-07）

写进 `$DSH_HOME/profiles/web/cordis.patch.yml`（本例即
`C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml`），**两条**：

```yaml
# ① insert：新 id（id 必须唯一 —— 重复 insert 同一个 id ⇒ duplicate loader entry id，
#    实测 2026-09-25 整树装配失败、前门 502）
- insert:
    - id: switchboard-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: stdio, serverName: switchboard, command: node, args: [<本包 server.mjs 绝对路径>] }

# ② 覆盖：补 toolCallTimeoutMs
#    ★ 因为 switchboard_handover 会轮询到 180s；沿用默认超时会在半路被掐断
#      ⇒ 那正好违反 F2 判据（会被误判成"没动 = 失败"）。
#    ★★ 覆盖必须【重述完整 config】—— patch 应用是 target[key] = value（整体替换，不是深合并）：
#       只写 toolCallTimeoutMs 会把 transport/serverName/command/args 冲成 undefined。
- id: switchboard-mcp
  config:
    transport: stdio
    serverName: switchboard
    command: node
    args: [<同上>]
    toolCallTimeoutMs: 300000
    failOnStartupError: false
```

★ **备份**：改动前已备份为 `cordis.patch.yml.bak-2026-10-07T18-12-23`（同目录）。
★ **验证方式**：`npm run check:profile`（= `node node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config`）
—— 让 DSH 自己解析，装配投影里能看到 `id: switchboard-mcp`。**这是最权威的判据**（YAML 错 / id 冲突都会在这里现形）。
★ ★ 注意该文件是 **CRLF** —— 追加时务必保持行尾一致（用 `sed 's/$/\r/'`）。

## 未做

1. ★ **控制面要先起**（`scripts/relaunch-switchboard.cmd`，走计划任务 detached ⇒ 跨工具调用存活）。
   否则 `switchboard_status` 会一直报 `fetch failed`（★ 它**如实报失败，不假装成功**）。
2. ★ **重启 DSH 才生效**（装配是启动期读的）。
3. ★ 活跃代的字段名目前用**宽松取值**（`activeGen`/`active`/`generation`/`lease.*`）——
   **待拿到真实 `?cmd=status` 响应后收紧**。
4. ★ `failOnStartupError: false` 是**保守选择**（别让"遥控器起不来"拖垮整棵树）；
   但它意味着 **server 起不来时不会红** —— 按本仓纪律这属于"静默"，后续该改成能观测的形态。
