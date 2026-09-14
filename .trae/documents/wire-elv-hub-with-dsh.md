# 用 elv/dsh-hub 壳接入 dsh 三脑：接线方案与"是否 fork 成三份"判断

> 状态：待实现。先对齐方向（尤其 fork 判断），再决定三步走的执行。
> 前置已就绪（本会话已验收）：`elv/dsh-hub` 移植的 Go Hub 翻译版能编译（tsc 0 错），其 **换代审批闭环经实测通过**（permission.request→ui 审批→精确单播回发起者，不广播）。接入基础设施就是这条 WS+审批环路。

## 1. 一图看懂关系

```
elv/dsh-hub（编排壳 / 三脑基座，端口如 15813）
  ├ /ws ：role=brain 的脑接入点（session.hello → welcome）
  ├ 寻址：ID 精确单播 / role 广播 / excludeRoles（router.ts，已修对）
  └ 审批：permission.request/response（换代审批，已实测通过）
        ↑  bridge（TS shim，复用 spike/hubconn.mjs 语义）
        ↓
dsh 实例 × N（执行者）
  ├ dsh 前门/控制面（接受 command.input → session.prompt，回 event.*）
  └ 每个实例承担一个 role：left / right / sandbox
```

**关键：bridge 是每实例一个的 WS shim**——把 elv/dsh-hub 的 `command.input` 翻译成 dsh 的 `session.prompt`，把 dsh 的 `event.*` 翻译回 elv/dsh-hub；`permission.request/response` 直接透传（已验证闭环）。

## 2. 直接回答：要不要 fork 成三份？

**要"三份"，但不要"fork 代码"——是同一份 dsh 运行时起三个实例。** 这正是老 Hub 早就定下的原则（ch17 D-110：**三脑 = 三个独立运行实例 + 配置**，非类型；一个崩不影响其他）。

- ❌ 不要：把 dsh 源码复制成三份分支（维护地狱）。
- ✅ 要：同一份 dsh 二进制/运行，三个进程实例，各配一个 role：
  | 实例 | role | 工作区/profile | 权限取向 |
  |---|---|---|---|
  | dsh-left | `left`（执行者） | 主源码工作区 | 可写开发（按 right 脑任务规格修改 sandbox） |
  | dsh-right | `right`（发现者+验证者） | 只读审查工作区 | 只读/审计，兼管换代 |
  | dsh-sandbox | `sandbox`（被测物） | 可弃实验工作区 | 允许实验、失败可弃，被动被改 |

## 3. 三脑协作模型（导师+学生比喻）

三脑不是三个平行个体，而是**一套工程循环的三个节点**：

```
    人（导师）
      │ 提需求 / 最终验收
      ▼
  right 脑  —  发现者 + 验证者
      │  自命题：工具摩擦、缺陷、未来能力情报
      │  向人问课题：主动沟通需求方向
      │  产出：任务规格（给 left 脑）
      │  验证：left 改完后测 sandbox，汇报给人
      ▼
  left 脑  —  执行者
      │  根据 right 脑的任务规格修改 sandbox
      │  被动响应，不主动决定改什么
      ▼
  sandbox 脑  —  被测物
      │  测试任务完成路径和指标
      │  自主实验、试错（但不改自己的根）
      │  不主动发任务，只被动响应
```

**核心纪律**：sandbox 是被动的——只测试、不主动修改；left 脑的修改对象永远是 sandbox，不是自己；right 脑同时握着两端（出任务 + 验结果）。

## 3A. 两种运行模式：人审 vs Auto

两套模式，同一个架构，区别只在**启动信号来自谁**：

| 维度 | 人审模式（导师发任务） | Auto 模式（学生自命题） |
|---|---|---|
| **触发方** | 人（导师）或 right 脑发现问题后手动提 | agent 自主发现任务，自动执行 |
| **任务来源** | 外部需求 / right 脑提案需人批准 | right 脑自命题（摩擦、缺陷、能力情报） |
| **执行路径** | 人批 → left 改 → sandbox 测 → 人验收 | right 脑自己走完整循环，完成后汇报给人 |
| **验收** | 人点头才过 | 完成后人验收，不通过则 right 脑重新规划 |
| **类比** | 导师布置作业，学生交卷，老师批改 | 学生自己找课题做研究，最后导师评审 |

**推荐分配**：
- **left 脑** → 人审模式（执行具体改动任务）
- **sandbox 脑** → Auto 模式（自主实验、试错）
- **right 脑** → 双模式（自命题出任务 + 验证 sandbox 结果）

## 4. 三脑承载与换代（两个待拍板取舍）

### 4.1 三脑承载：进程 vs 轻量 gen

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A：独立进程** | 三个 dsh 进程，各带一套 switchboard | 故障隔离彻底 | 资源重（三个切换机制） |
| **B：轻量 gen（推荐）** | 一个 switchboard 内起三个 gen，各归 role，共用 bridge | 共享代际基建，更轻 | 共进程崩溃风险（可接受） |

**推荐 B**：三份 gen 共享一个 switchboard，通过 role 隔离权限。

### 4.2 审批归属：人批 vs 自动

| 方案 | 描述 |
|---|---|
| **A：hub 面板人批** | 关键换代（left→sandbox 的正式修改）需人在面板审批 |
| **B：dsh verify 自动** | 日常自愈、sandbox 实验迭代，right 脑内部 pass 即过 |
| **A+B 混合（推荐）** | 正式换代走面板人批；日常小迭代走 verify 自动；right 脑验收时报告给人 |

## 5. bridge 契约（每实例复用）

- **连接**：`ws://127.0.0.1:<hub>/ws` → `session.hello{role:'left'|'right'|'sandbox', brain_mode, project_root, model:'dsh'}` → `session.welcome(client_id)`。
- **上行（hub→脑）**：收 `command.input{text, session_id}` → 调用 `dsh 前门` 的 `session.prompt`，把 dsh 执行事件流翻译成 `event.thinking/tool_call/turn_done` 发回 hub。
- **下行（脑→hub）**：dsh 产出/状态 → `event.message/turn_done`；换代审批走 `permission.request/response`（此路已实测，直接复用）。
- 复用现成：`dsh-brain/scripts/spike/hubconn.mjs`（脑/ui WS 客户端）+ 本次验收的 elv/dsh-hub permission 闭环。
- **任务侧另走一条**：`command.input`（对话/任务）与 `gen.*`（换代）**是两条独立通道**——任务消息走既定 session.prompt 环；换代走 effect 命令环。互不串扰，换代不打断进行中的任务。

## 6. 换代状态机（右脑兼管，Hub 驱动）

right 脑负责触发和验证换代，Hub 持有状态机：

```
一脑对账表: { desiredCommit, actualCommit, runState }
runState ∈ idle | spawn | ready | catchup | freeze | verify | promote | flip | retire | rollback

标准换代循环:
  1. right脑提案 candidate=C → Hub: sandbox.desiredCommit=C → gen.request{C}
  2. dsh(sandbox): spawnAtCommit(C) → gen.ready{C,port}
  3. Hub: gen.catchup → dsh: catchup() → gen.catchup-done
  4. Hub: gen.verify{C} → dsh: runVerify(C) → gen.verify-result{C,ok,report}
  5. Hub: 面板审批(人批) 或 verify自动 → approve / skip
  6. Hub: gen.promote{C} → dsh: promote(C) → gen.flipped{C}
  7. Hub: current:=C → gen.retire{prev} → dsh: retire(prev) → gen.retired
  fallback: ok=false → gen.rollback → gen.flipped{prevCurrent}
```

**安全红线**：verify 永远留在脑内自跑；Hub 只做"何时换代 + 收结果 + 决定 promote/rollback"。

## 7. 接线路径（三步走）

1. **bridge 打通单脑**：dsh-left 接 elv/dsh-hub，跑通 `command.input → session.prompt → event.*` 环 + 换代审批闭环。最小可验证。
2. **三角色就位**：复制出 dsh-right + dsh-sandbox 两个实例 + 各自 bridge，各配工作区/权限。验证 fault-isolation（杀一个不影响其它）。
3. **三脑协作循环跑通**：right 出任务 → left 改 sandbox → sandbox 自测 → right 验结果 → 汇报给人。人审模式和 Auto 模式各验证一次。

## 8. 验收口径

- 三实例各被 hub 广播 `peer_update` 可见；`permission.response` 只回对发起者（已验）。
- 杀掉 dsh-sandbox，hub 仍能路由到 left/right；三脑独立不互相拖垮。
- 换代申请在 hub 面板出现 → 人批 → dsh flip，闭环走通。
- **身份解耦验收**：同一任务在 left/right 各跑一次，`actualCommit` 可不同且互不覆盖。
- **sandbox 被动验收**：left 修改 sandbox 后，right 脑能拉起 sandbox 并让它跑任务，验证指标达标。
- **两模式验收**：人审模式下 right 脑提案需人批；Auto 模式下 right 脑自主跑完整循环后汇报人。
- **换代不打断任务**：换代期间有进行中的 `command.input`，任务照常跑，仅换代实例在换。

## 9. 引用

- elv/dsh-hub 核心：`router.ts`（寻址）、`services/permissionService.ts`（换代审批）、`protocol.ts`（构造器）。
- 老 Hub 原则：`ai-base/agent-shell/docs/ch17-task-orchestrator.md` §1.3（三脑=实例+配置）、§5（审批分层）。
- 复用 shim：`dsh-brain/scripts/spike/hubconn.mjs`。
- 换代驱动器待实现于：elv/dsh-hub（状态机 + `gen.*` 命令 + 面板审批）；dsh 侧只注册 effect 钩子。
