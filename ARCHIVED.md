# ⚠️ 已存档（2026-10-25，寄风裁定：组织重构）

本仓为三脑 Agent 时代的开发仓。**活资产已迁出**至新管理根 `D:gentio\dev\`：

| 资产 | 新家 |
|---|---|
| 席位定义（九席） | `agentio/dev/seats/` |
| provider 注册（subagent-council） | `agentio/dev/subagent-council/` |
| 席位工具链（gen-roster/seat-contract/handoff-contract） | `agentio/dev/seats-tools/scripts-seats/` |
| WS 桥（bridge） | `agentio/dev/bridge/` |
| 评审团编排基座（council-hub→review-hub） | `agentio/dev/review-hub/` |

**仍在本仓的**：packages/switchboard 等（老 DSH 运行时，不继承——新体系从头写）；evals/arms（三脑时代实验）。

**后续开发**：DSH 桌面端（`agentio/dev/dsh/`）+ agent-io（`agentio/dev/agent-io/`）——见 `agentio/dev/agentio-plugin/`（版本 B）与 `agentio-core/`（版本 A）。
