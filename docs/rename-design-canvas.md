# design-canvas 改名：候选名与迁移方案

> 状态：**待用户拍板** ｜ 2026-09-14 ｜ 触发：`ast-io-entry.md` 把它的身份从「可视化协议层」
> 推向「agent 的读写编辑统一入口（AST 内核）」—— 现名只覆盖了旧身份的一小半。

---

## 1. 命名要表达的（来自新身份）

| 要表达 | 为什么 |
|---|---|
| **AST / 树** | 用户原话：「最重要的是一个 AST 解析……生成一棵 AST 树」 |
| **静默生长 / 零前置** | 「遇到某个项目就默认静默去解析」 |
| **精确读写（手与眼）** | 「精确编辑、精准解析、精确筛选」 |
| **底座性** | 「未来我们的 agent 基本上也会接入这一套基础底座」 |

**不**要再表达的：`canvas`（可视化只是它的一条能力线，不再是身份）。

---

## 2. 候选与证据（npm 占用实测，2026-09-14）

> 结论先行：**好看的单字在 npm 上已被占满**，且近两年被 AI 项目大量抢注 ⇒
> **品牌名 ≠ 包名**：品牌可以选一个好词，发包用 scope（`@scope/<name>`）或变体（`silvajs`）。

| 候选 | 语义 | npm | 备注 |
|---|---|---|---|
| **`silva`（主推·中文「林」）** | 拉丁语「林」；*silva rerum* = 素材集 | 占（2017 死包，恰是"通用树结构"库） | 一个项目 = 一片林；静默解析 = 让它长出来；与既有词汇族（**积木 brick** / 画布 / 织 weavepet）自洽；中文交流可用「林」 |
| `graft`（备选） | 嫁接 | 占（2014 死包） | 动作向：跨仓杂交 / 跨语言翻译 / 符号搬迁**都是嫁接**；动词化自然 |
| `arbor`（备选） | 树 / 棚架 | 占（2019 死包）+ Arbor Networks | 最直白的"树"，工程味足；品牌碰撞稍重 |
| `silvax` / `astweave` / `astkit` / `arbore` / `codefold` / `weftkit` / `silvajs` | 变体 | **FREE** | 若一定要发 npm 包，从这些里挑 |

**否决**：`trellis`、`keel`、`quarry`、`sapwood`（均被 **2026 年**新发的 AI 项目占用，活性碰撞）；
`astral`（2013 起就是 "AST tooling framework"，主题撞车）；`lattice`/`loom`/`chisel`/`forge` 等（大厂产品撞车）。

**中文侧可用**：`silva` → 「**林**」（"让林先把这片代码建起来"），代号/文档/口头都顺。

---

## 3. 迁移影响面（实测）

| 面 | 量级 | 位置 |
|---|---|---|
| design-canvas 仓内引用 | **179 个文件** | `package.json`、README×2、AGENTS.md（**由 `scripts/gen_agents.mjs` 生成，要改源头**）、`.trae/skills/design-canvas-{mind,router}`、`.trae/mcp.json`、`docs/`、`schema/*.json`、`scripts/*`、`tests/*`、`go-observe/*`（Go module 路径）、src 内字符串 |
| **机器契约** | 少量但致命 | ① MCP `serverName` → 工具前缀 `mcp__<name>__*`（改 = 所有 agent 的工具名变化 + prompt 前缀变化）② 环境变量 `DESIGN_CANVAS_HOME` ③ 项目数据根 **`.design-canvas/`**（里面已有真实 feature/基线数据）④ 项目级配置 **`.design-canvas.json`** ⑤ npm 包名 / CLI bin |
| DSH 侧 | 3 处 | `~/.dsh/profiles/web/cordis.patch.yml`（`serverName` + `DESIGN_CANVAS_HOME` + `cwd`）、`packages/design-canvas-bridge/`（包名/插件 id/`kernelDir`）、`~/.dsh/capabilities/registry.json` 的能力条 id |
| 记忆/文档 | 多处 | `dsh-brain/.workbuddy/memory/*`、`docs/*`、skill 文本、persona 里提到的工具名 |

> 参考教训：本仓 `docs/tool-convergence.md` §5.7 记录过一次**单个工具**改名就波及 37 个文件，
> 且 `rename_*` 工具**认不出**注册名字面量与 user-facing 字符串 ⇒ 必须走 `report_literals` +
> 分 kind 决策（contract / history / docs / generated）。

---

## 4. 建议的两段式迁移（不要滴灌）

**A 段 · 品牌层（低风险，可先做）**
仓库名 / README 标题 / 文档 / 显示名 / skill 名 / 能力库 label / 中文代号。
不动任何机器契约 ⇒ 现有 agent、缓存、数据全不受影响。

**B 段 · 机器契约层（一次原子，单独提交 + 可回滚）**
1. `package.json` name/bin + `src/server.ts` 的 MCP server name
2. `~/.dsh/profiles/web/cordis.patch.yml`（`serverName`/env/cwd）+ bridge 包 + 能力库登记
3. **数据与配置兼容**：`.design-canvas/` 与 `.design-canvas.json` **建议保留旧名读取**（新名优先、旧名回退），
   否则 dsh-brain 里已有的 4 个 feature（DSL/基线/drift 台账）需要迁移
4. 跑 `npm run check:profile` + `check:bom` + 全量回归 + **一次换代**验收（工具前缀变了 ⇒ 首轮命中率必然 0%，属预期）
5. 用自家工具做 dogfood：`rename_symbols report_literals=true` 先出清单，按 kind 决策再 `apply_literals`

**验收判据**：① `mcp__<新名>__capability_map` 能调通 ② 旧数据/旧 config 仍可读 ③ 装配基线行数不变 ④ 换代后工具数不变（60）

---

## 5. 待用户确认

1. **定名**：`silva`（林）/ `graft` / `arbor` / 其他？
2. **是否要发 npm 包**：要 → 从 FREE 变体里选包名；不要 → 品牌名随便挑（只需唯一性）
3. **`.design-canvas/` 数据根与 `.design-canvas.json` 是否一起改**（建议：改新名 + 读旧名兼容）
4. **A 段先做还是等 B 段一起做**
