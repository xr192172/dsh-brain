# Design Canvas —— 单一管理面（取代 `design-canvas-two-things.md`）

> 生成：2026-09-27 23:4x（本文件所有结论均**实测于本机**，命令与读数随文附上）
> 用途：把"本体 / 接入层 / 副本 / 配置 / 分支"五件事收敛到一处管。**取代** `design-canvas-two-things.md`（该文有 4 处与实测不符，见 §6）。

---

## 一、只有两个东西是活的（其余都是旧快照）

| # | 身份 | 路径 | 判据（为什么它是活的） |
|---|---|---|---|
| **①** | **能力本体**（MCP server，302 文件 / ~10.9 万行 TS） | `D:\project_develop\design-canvas` | 唯一被两处活配置指向：profile patch 的 `args/cwd` + 桥接包 patch 的 `kernelDir` |
| **②** | **DSH 接入层**（桥接插件，单文件 `src/index.ts` 69KB） | `D:\project_develop\dsh-brain\packages\design-canvas-bridge` | web profile 的 `dsh.profile.bundles` 里 |

**① 与 ② 的连接有两条通道，不止一条**（这是清单漏掉的一半）：

```
① D:\project_develop\design-canvas
   ├── (a) stdio 子进程：node dist/src/server.js   ← 由 @deepseek-ai/dsh-mcp-client 拉起
   │        配置在 ~/.dsh/profiles/web/cordis.patch.yml 的 mcp-client insert
   │        产出 mcp__design-canvas__* 全部工具（**实测 67 个**，权威读数＝本体 `scripts/readme_tools_gate.mjs`：
   │        `README=67 → 真实=67 ✓`；桥接源码注释原写"55 个"＝**过时数字，已修正为 67**）
   └── (b) 进程内深度 import 内核 dist（kernelDir）
            ← 由 ② 直接 import，不走 stdio，用于 symbol_edit 复合工具
            配置在 packages/design-canvas-bridge/cordis.patch.yml 的 kernelDir
```

⇒ **(a) 和 (b) 都对"内核在哪"有独立意见** ⇒ 这就是"必须归纳为一处"的真实理由。

---

## 二、★ 实测修正：分支根本没有分叉（清单此条错误）

清单原文：「detached HEAD（`340e476`）且与 main **已分叉**，PR/ 就躺在里面未推送」。

实测（`git fetch origin` 之后）：

```
本地 HEAD            = 4197d0b   docs(pr): 建 PR/ 投递区 + 首份需求
远端 origin/main     = 54f2111   feat(index): S2 后台续建 + 首读时长上限
git merge-base HEAD origin/main == 54f2111 == origin/main 本身
  ⇒ origin/main 是 HEAD 的祖先        （--is-ancestor 返回 YES）
git rev-list --left-right --count HEAD...origin/main
  ⇒ 13    0
```

| 结论 | 值 |
|---|---|
| **分叉？** | **没有**。HEAD 是远端 main 的**严格后继** ⇒ 纯快进 |
| **未推送** | **13 笔**（不是 1 笔），含 `PR/` 投递区、P1-7 规则沉淀、P0-4 模糊编辑级联、索引层 S2 系列 |
| **本地 main** | `eccac42`，**是 HEAD 的祖先**（落后 2 笔）⇒ `git branch -f main HEAD` 也是纯快进 |
| **PR/ 在哪** | 已提交进 `4197d0b`（工作树干净），随这 13 笔一起未推送 |
| **要干活的正确分支** | `main`（把它快进到 `4197d0b` 然后切回去）；**以后不要再在 detached HEAD 上提交** |

> 顺带：远端还有 `feat/version-upgrade`（`cf4d1e2`），本地未取、**不在 HEAD 历史里** ⇒ 接手动它之前先确认是不是你要的东西。

---

## 三、★ 实测修正：副本是**三份**，不是两份

清单只列了 ① 和 ②，实际存在第三份（`.trae/documents/design-canvas-toolkit.md` 记的三目录同步链）：

| 路径 | 身份 | 实测状态 | 处置 |
|---|---|---|---|
| `D:\project_develop\design-canvas` | ① 现役 | 302 文件，13 笔未推送 | **活**，唯一工作区 |
| `D:\project_develop\dsh-brain\design-canvas-dev` | ② 冷副本 | 272 文件（**少 3 个**：`arg_suggest.ts` / `exec_guard.ts` / `file_snapshot.ts`）；`node_modules` **已不在**（junction 断了）；最近改动 **09-10 21:01**；被 `dsh-brain/.gitignore:35` 显式忽略 | **判死**（已无 node_modules，跑不起来） |
| `C:\Users\Admin\Downloads\Browsers\Microsoft Edge\design-canvas-main\design-canvas` | ③ 上游克隆 | 真 git clone，HEAD `1d19e23`，**是 ① 的祖先（更旧）** | **判死**（② 的 node_modules 宿主，junction 断了就没用途） |

**清单此条的错误**：「`design-canvas-dev` 的 `git remote` 指向 `dsh-brain.git` ⇒ 疑似误共享主仓 .git」——
实测它**没有 `.git`**；那条 `remote` 输出只是 git 向上找到了父目录 `dsh-brain` 的 `.git`，**是观察假象**。真相是：它被 `.gitignore:35 /design-canvas-dev/` 显式忽略，所以 `git ls-files` 为空、也不出现在 `git status` 里。

引用过 ② 的地方（都是**文档/临时探针**，不是活配置，删前改指向即可）：
`.trae/documents/{design-canvas-toolkit,memory_observe_loop,symbol_move}.md`、`.tmp-memobs/*.mjs`、`.workbuddy/memory/2026-09-1{4,5}.md`

---

## 四、★ 配置散落：内核路径被硬编码在 **3 类地方**，mcp-client 的 insert 重复在 **3 个 profile**

| 位置 | 写了什么 | 是否重复源 |
|---|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | `mcp-client` insert：`args` + `cwd` = 内核路径、`DESIGN_CANVAS_HOME`、LLM 池 env | **是**（见下三行） |
| `~/.dsh/profiles/exp-base/cordis.patch.yml` | **同一条 `mcp-client` insert** 逐字复写 | **是**（重复源） |
| `~/.dsh/profiles/exp-base-nodc/cordis.patch.yml` | 同上（另有注释说明） | **是**（重复源） |
| `packages/design-canvas-bridge/cordis.patch.yml` | `kernelDir` = 内核路径；并自述"单一来源" | 与上面**冲突**（注释说的是"本插件配置"，不含内核路径） |

⇒ 现状是：**"内核在哪"这一个事实，被写在 4 个文件里、3 个不同 profile 中。**

### 收敛方案（唯一推荐）

**把 `mcp-client` 的 insert 上移进 `packages/design-canvas-bridge/cordis.patch.yml`**，与 `kernelDir` 同文件 ⇒ "怎么连 + 内核在哪"变成**一处**。profile patch 里 design-canvas 相关行清零，profile 只管 `dsh.profile.bundles`。

**必须同批删掉 profile 里那条 insert** —— 否则就是 `duplicate loader entry id`（与 2026-09-25 前门 502、工具集少 25 个同族事故）。

**★ 唯一未验证点（落地前必须实测）**：桥接包的 bundle patch 能否 insert **别的包**（`@deepseek-ai/dsh-mcp-client`）。
可行性依据：web profile 的 `package.json` 已 `link:` 该包 ✓，且 insert 只写 `id/name/config`，不要求同包。
验证判据（三项全过才算成）：① `boot.log` 无 `duplicate loader entry id`；② 工具集数量与 header 形态回到基线（如 `6449|95`）；③ `mcp__design-canvas__import_project` 可调用。

---

## 五、★ 防复发：让"单一来源"变成**可验证**的，而不是注释里的口号

注释已经阻止不了漂移（现状就是明证）。建议加一个门：`dsh-brain/scripts/check-dc-single-source.mjs`

| 判据 | 动作 |
|---|---|
| `mcp-client` / `design-canvas-bridge` 的 insert 出现在 >1 个 profile patch | **block** |
| 内核路径（`D:\project_develop\design-canvas`）出现在白名单之外的文件 | **block** |
| 桥接包 patch 里 `kernelDir` 缺失或指向不存在的 `dist/src/server.js` | **block** |

白名单只应是 1 个文件：`packages/design-canvas-bridge/cordis.patch.yml`。

---

## 六、清单需修正的 4 处（逐条）

1. 「① 与 main **已分叉**」→ **错**。实测无分叉，HEAD 领先 origin/main **13 笔、落后 0**，纯快进（§2）。
2. 「`design-canvas-dev` 的 remote 指向 `dsh-brain.git`」→ **误读**。它没有 `.git`，那是父仓 `.git` 的继承；它被 `.gitignore` 忽略（§3）。
3. 「① 由 dsh-mcp-client 拉起」（单一通道）→ **不全**。还有 ② 对内核 dist 的**进程内深度 import**（`kernelDir` → symbol_edit），不走 stdio（§1）。
4. 「配置在 `~/.dsh/profiles/web/cordis.patch.yml` ← 不在项目里」→ **只对一半**。同一条 insert 在 **web / exp-base / exp-base-nodc** 三处重复；且内核路径在项目内的桥接包 patch 里也有一份（§4）。

另：`D:\project_develop\dsh-brain\project_developdsh-brain\` 是**空目录**（疑似路径写坏），可删。
另：本机 WorkBuddy 工作区 `C:\Users\Admin\WorkBuddy\design-canvas` 是**空的非 git 目录**（会话挂载点）——`dc-add-tool` 等技能指向的干活目录是 **`D:\project_develop\design-canvas`**，别在空目录里找代码。

---

## 七、待用户拍板的两件（不可逆 / 对外）

| # | 动作 | 为什么需要你说一声 |
|---|---|---|
| 1 | `git branch -f main HEAD && git checkout main && git push origin main`（推 13 笔到**公开仓库**） | 对外发布 |
| 2 | 删 ② `design-canvas-dev` + ③ Downloads 里的上游克隆（**先备份**） | 删除 |

其余（§4 的配置上移、§5 的门、分支指针本地快进）属工程判断，可直接执行。
