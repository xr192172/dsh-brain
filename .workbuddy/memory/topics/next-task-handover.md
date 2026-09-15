# 接手指南：下一项 —— 修换代的写入竞态（hard-switch）

> **给新会话读的**。这是一份**自包含**的交接：读完它 + 它列出的文件，就能接着干，不必回溯前面的对话。
> 写于 2026-09-15 深夜。

---

## 0. 一句话

**下一项任务**：修 `packages/switchboard` 的换代协议里 **`hard-switch` 路径的写入竞态** ——
它会让**两代同时往同一份会话日志追加**，产生 `seq 回退/重叠` ⇒ 会话历史永久打不开。

**为什么是它**：它是今晚唯一查清、但**没修**的问题；而且**仍在发生**（不是历史遗留）。

---

## 1. 先看结论速览：今晚做过什么（避免重复劳动）

| # | 事项 | 状态 |
|---|---|---|
| 1 | **长期 flake「交接后 `Cannot read properties of undefined (reading 'kind')`」** | ✅ **已破案并已修**（见 §2）。**不要再查它。** |
| 2 | preset 默认从 Code Mode 换回 Native（`council`） | ✅ 已生效（用户实测 100 个工具） |
| 3 | 注入消息缺 `id`/`source` ⇒ 会话永久读不出来 | ✅ 已修（源头）+ 历史消息重放也安全（上游侧加固） |
| 4 | 3 个坏会话（1 个补身份 + 2 个截断） | ✅ 已修 |
| 5 | **换代 hard-switch 写入竞态** | ❌ **未修 ← 本次任务** |
| 6 | `session-3d8ea18d`（elv）seq gap | ⏸ **未修**（截断会丢 59%）。**不阻塞启动** |
| 7 | `.kind` flake 的**主动复现** | 不需要了（已从历史日志破案） |

---

## 2. 已破案的那个 flake（**别重复查**）

**根因**（`@deepseek-ai/dsh-agent-loop`）：`isOwned(message)` 直接读 `message.source.kind`；
会话里只要有一条**没有 `source` 的 user message**，`RuntimeContextProjection` 构造时就会抛
`reading 'kind'`。而**没有 `source` 的那种消息是我们自己注入的**（旧的 `{role,content}` 写法）。

**已修两处**：
- 源头：`packages/switchboard/src/index.ts` 的 `injectedUserMessage()` → 带 `id` + `source`
- 上游侧：`scripts/patch-agent-loop-hardening.mjs` → `isOwned` 改成 `message?.source?.kind`
  （**必要** —— 老日志里的坏消息重放仍会崩）

**证据**：12/12 会话相关（见 `docs/upstream-defects.md` §2.5 的 U3）。
**回归守卫**：`scripts/test-injected-message-shape.mjs`（已并入 `check:all`）。

---

## 3. 本次任务：hard-switch 写入竞态

### 3.1 症状（实测证据）

`session-3d8ea18d`（elv，`createdAt` 14:15:56）日志里：

```
seq=623 tool/call     tool_apply                       ← 该轮调它触发了蓝绿发布
seq=628 turn/end      reason={"kind":"interrupted"}     ← 换代打断该回合
seq=629 session/end-seed                                ← 旧代"封存结束"
seq=627 assistant/chunk    ← ★★ seq 回退：629 之后又回到 627
seq=629 assistant/chunk
seq=630 assistant/chunk …
seq=630 agent/inbox/spliced    ← ★ 又一条 630
```

⇒ 旧代「封存结束」后**又回头**写它正在流式输出的 chunk，**同时**新代把用户消息写进同一区间。

### 3.2 机制（已定位到代码）

- fencing 机制**存在且完整**：`packages/switchboard/src/handover-protocol.ts`
  的 `freezeSeq`（旧代冻结时已落盘的全局最大 seq，新代只能从 ≥freezeSeq 之后 append）
  + `writerToken`（每次授写唯一 UUID）。
- **但 `packages/switchboard/src/coordinator.ts:298-308` 有一条兜底**：
  > `freeze 活跃代无响应 → 走强切（省去静态冻结，直接 promote）`

  记录里写作 `via … (hard-switch, no-freeze)`。
- ⇒ **硬切时旧代不知道自己该停写**（主线程被占，例如正在流式输出）⇒ 继续 append；
  新代同时从 `freezeSeq` 之后写 ⇒ **两代并发追加同一文件**。

### 3.3 要读的文件（按顺序）

1. `packages/switchboard/src/coordinator.ts` —— 换代状态机；重点看 **hard-switch 分支（约 296-330 行）**
2. `packages/switchboard/src/handover-protocol.ts` —— lease / `freezeSeq` / `writerToken` 的契约
3. `packages/switchboard/src/drain.ts` —— 「收到 freeze 后武装 drainArmed」的实现，看它**到底能不能真正阻止旧代继续写**
4. `docs/handover-vs-restart.md` **§8** —— 本次问题的完整记录（症状/机制/操作纪律/候选修法）

### 3.4 候选修法（都**未实施**）

1. 硬切时**先 SIGKILL 旧代**再 promote（最强，但要先确认不会误杀共享进程）
2. promote 前**短暂等待 / 主动确认旧代不再 append**
3. 给新代一个 `graceSeq` 窗口：**只追加不重复区间**

> ⚠️ **这是最安全攸关的一段代码（换代本身）**。开工前先把"旧代到底有没有可能还在写"**fact-check 清楚**，
> 再定一个小而安全的修法，并**为它写自证**（见 §5 的纪律）。

### 3.5 必须先回答的问题（动手前）

- [ ] `freeze` 到底做了什么？`drainArmed` 之后旧代在**哪些边界**停止发起新动作？
- [ ] 硬切路径**是否**已经杀了旧代？（看代码，别猜）
- [ ] 旧代的**流式 chunk 写入**会不会绕过 drain？（本次证据显示「会」）
- [ ] `freezeSeq` 在新代侧是怎么用来防重复区间的？为什么没挡住？

---

## 4. ★★ 操作纪律（**违反会制造新的损坏**）

今晚的惨痛教训，务必遵守：

1. **不确定有没有回合在跑时，用 `?cmd=handover`（非 fast）**；`restart`/`fast=1` **只在确认空闲时用**。
   → 因为 fast **跳过的第一步正是 defer**「等活跃代收尾本轮」—— 那正是这个竞态的温床。
2. **`?cmd=status` 的 `stage==='idle'` 只表示换代状态机空闲，不代表会话没有回合在跑。**
3. **一份坏会话能让整代起不来**（启动时 `dsh-workspace` 会 `list()` 所有会话）
   ⇒ **换代之前先跑** `node scripts/check-session-integrity.mjs`。
   但注意：**只有帧契约坏会阻塞启动**；seq gap / 缺身份只影响那份会话的历史。
4. 改 `~/.dsh` 下的文件（**不在 git 里**）：**先备份**，且**复验要覆盖读者最先检查的那层**
   （帧契约！—— 我今晚就是用单帧压缩把整代搞挂过一次）。

---

## 5. 可用工具与验证

| 命令 | 用途 |
|---|---|
| `npm run check:all` | 全套 14 道门（约 13s）。**改动后必跑** |
| `node scripts/check-session-integrity.mjs --all` | 会话体健全量扫（约 25s；换代前跑） |
| `npm run verify:p4` | P4 能力通知的换代验收（A 段 = 新代码是否上了） |
| `node scripts/repair-session-seq-gap.mjs <目录名> [--apply]` | 截断修复 seq gap（**默认 dry-run**） |
| `node scripts/repair-session-message-id.mjs <目录名> [--apply]` | 补消息身份（**默认 dry-run**） |
| `curl "http://127.0.0.1:31800/?cmd=status\|result\|handover\|restart"` | 换代控制面（3080 是 GUI 前门，**不是**控制面） |

**写门的纪律**（今晚反复用到，已固化进 `gate-authoring` 技能）：
- 门要**两方向自证**（该红的红、该绿的不红）；
- **未实施的级不得计作通过**；假绿与**假红**同等有害；
- **复验必须覆盖读者最先检查的那层**（不是"我关心的那几项"）。

---

## 6. 今晚踩过的坑（**别再踩**）

1. **假红三次**（都是我凭印象写判据）：
   `seq 缺口`（其实是行编码）、`surface 要有 data.message`（其实 user/message 是平铺的）、
   `user/assistant/message 都要 id+source`（其实 assistant/message 用 `{turn,step,message,usage}`）。
   ⇒ **先把该类型的"正常形状"从全体样本统计出来，再找离群。判据来自数据，不来自印象。**
2. **用单帧 zstd 重写会话 ⇒ 整代起不来**（`first frame is not exactly one header line`）。
   ⇒ 读者最先查的就是物理帧契约。
3. **注释里写 `packages/*/src` ⇒ `*/` 提前闭合块注释**，报错指向**后面某一行**（真因在前面）。
4. **反模式扫描没排除 `out/`** ⇒ 一次报 72 处假红。
5. **同一文件的两个 Edit 并行发 ⇒ 后者按旧快照覆盖前者，两边都报成功。** 同文件编辑必须串行。
6. **`node -e` 带正则/反引号会被 bash 抢插值** ⇒ 写 `.mjs` 文件再跑。

---

## 7. 环境与边界（**每轮都要遵守**）

见 `MEMORY.md` 的「环境约束」与「铁律」两节（Bash PATH、`.ps1` 必须带 BOM、
`git -C` 用 `D:/…`、同文件 Edit 串行……）。

**归属边界**（2026-09-15 用户定）：**不追上游版本**；只按需合并对我们有利的改动。
**只管 `@dsh-brain/*` 与我们自己的 profile**（`~/.dsh/profiles/web/`）；
`@deepseek-ai/*` 从 `profiles/node_modules/` 那条上游共享树解析，**上游自身的问题暂不处理**
（例外：已记入 `docs/upstream-defects.md` 的 U1/U3 我们打了补丁）。

**换代由谁发**：改动 `node_modules` 或 profile 后**需要换代才生效**。
**Agent 可以发**（`curl …?cmd=handover`），但遵守 §4 的纪律。
