# Go→TS 翻译工具（translate_go_ts）改进意见

> 面向：design-canvas 开发窗口。来源：真实使用回执 + 对 `elv/dsh-hub`（Go Hub 整仓翻译产物）的独立验收。
> 目标：翻译不止"能编译"，更要"行为保真"。分级：`[阻断]`=不改产物不可用；`[重要]`=强收敛效；`[体验]`=打磨。

---

## 验收事实（据此提的这部分意见）
对 `elv/dsh-hub`（Go Hub → TS，74 文件/6303 行）验证发现：
- `tsc --noEmit` 通过，但依赖 **79 处 `as any`** + **37KB `globals.d.ts`** + **40 个手写 fix_*.cjs** 才压过编译。
- **核心语义丢失**：`router.ts`（原 `ResolveTargets` 寻址决策表）被翻成"同 role 全发排除自己"，`matchAddress` 写了却没被调用——单播/广播语义全丢；**换代审批的 `permission.response` 回路由（应单播回 requester）会被错误广播到整个角色**。
- **5 个核心服务被砍成空壳**（permission/group/system/memory `Categories → new Map()`），有 23 个文件残留 TODO/not implemented。
- 根因判断：**机械骨架把弱机械、强逻辑的单元直接跳过/留空，验证闸只守"能编译"不守"行为"；LLM 填孔只看单函数签名与局部条，看不到跨文件调用语义。**

---

## [阻断] A. 行为保真（这是翻译硬伤，优先级最高）

### A1. 不再"砍掉"强逻辑单元，改为"显式失败清单"
- **痛点**：router/permission 这类弱机械、强逻辑的函数，验证闸没过就被静默降级为骨架/空壳，用户根本不知道丢了什么，直到运行才发现路由不通。
- **建议**：翻译产出侧 car 一份 **`translation-report.jsonl/.md`**，逐单元记录 `id / 状态(ok|skeleton|skipped|llm_retry_fail) / 原因`。降级不是抹掉，而是变成显式清单，供人或下一轮专门处理。
- **判定**：某个强逻辑单元被降级时，报告必须能查到它，且能一键定位到 Go 源行。

### A2. LLM 填孔注入"跨文件语义上下文"
- **痛点**：`PermissionResponsePayload.Allowed`、`Address.broadcast` 这类语义，决定"该单播还是广播"，但 fill 只给了一个函数签名。LLM 只能脑补，于是把"按规则寻址"脑补成"同 role 全发"。
- **建议**：fill 单函数时，把以下显式注入 prompt，而非只给签名：
  1. 该函数**调用方**的片段与它**调用的兄弟函数**签名；
  2. 共享结构体语义注释（如 `Address.broadcast`=广播语义、`correlation_id`=路由键）；
  3. 本函数在源 Go 中的**相邻上下文**（上下各 N 行，含注释）。
- **判定**：同一函数，有无跨文件上下文，fill 结果在"是否保留 broadcast/excludeRoles 处理"上要有可测差异。

### A3. 识别"决策表/状态机"，走专门翻译模式
- **痛点**：Go 的 `switch on subtype + 分支表`（如 router 的 ResolveTargets、permission 的 request/response）最适合机械转成 TS `switch/map`，交给 LLM 反而会丢分支。
- **建议**：`go_extractor` 识别"switch/decision-table"形状 → 走**确定性翻译路径**：逐分支列出 target/分支常量，让 TS 侧产出 `switch(subtype){case 'request'...}` 与 Go **一一对应**，不依赖 LLM 归纳。LLM 只填"分支内的动作"，不填"分支本身"。
- **判定**：router 的 case 分支在 TS 中数量与 Go 相等。

### A4. fill 的验证加"结构化断言"，不止语法
- **痛点**：现在 fill 只验"能编译/不抛"，所以"语法对、语义错"（如 `route()` 广播错）能混过去。
- **建议**：fill 完后做 **AST 级断言**：被引用符号是否可用、函数是否使用了全部参数、switch 分支数/常量是否与骨架等价、是否误把"单播"写成"全发"等可判规则。
- **判定**：路由/审批类函数，断言能拦下"该回 requester 却广播全角色"这类错误。

---

## [重要] B. 类型系统与声明管理（对应你的体感 1/2/4）

### B1. `globals.d.ts` 瘦身：就近声明 + 只留跨模块共享
- **痛点**：`globals.d.ts` 37KB 且随项目膨胀；`panelService class vs function` 重名这类冲突迟早复发。
- **建议**：类型按"被引用范围"分层——只被单模块用的就近声明（甚至内联），跨模块共享的才进 globals；生成时做**同名冲突预检**（class/interface/function 撞名→自动加后缀或显式报错），不在 fix 阶段才发现。

### B2. 生成"类型索引/映射表"替代 grep 定位
- **痛点**：接口/类型散落多文件，靠 grep + 经验找。
- **建议**：每翻译一个 Go package，落一份 **`types-map`**（声明名 → 文件:行 → Go 源对应），或一个统一声明索引，方便"知道名字就能定位定义"。

### B3. Go↔TS 类型差异的"内置转换约定"
- **痛点**：`interface 与 built-in type 冲突`这类要经验才能快速定位。
- **建议**：把已知机械差异内置为恒定的命名/位置约定（如 `map[string]→Map`、`nil→null|undefined`、`interface{}→unknown`、struct 方法→class method vs 独立函数二选一并全局一致），并出一份**转换约定表**，让用户不用每次靠经验猜。

---

## [重要] C. 修复循环去"脚本叠层"（对应你体感 3）

### C1. 常见机械错在"翻译时就修掉"，而非靠人攒脚本
- **痛点**：实测有 **40 个手写 `fix_*.cjs`**（fix_errors_v8/v9、fix_forof_v1~4、fix_patterns1~15 等）层层叠加，说明"改错→打补丁→再改错"失控。
- **建议**：把高频机械错（未用 import、interface vs type、可选链、Buffer→Uint8Array、`.map` 误用、`for...of` 下标）做成**翻译器内建的 deterministic fixer**，一次性修完，而不是靠人在产物上打补丁叠加。

### C2. tsc 错误按根因聚类
- **痛点**：错误数下降很快，但逐条看时重复同类多，定位慢。
- **建议**：错误按根因聚类展示（如"N 条 `as any` 前可消除归为 1 类"），显示"类数下降"而非仅"条数下降"，帮判断是否同一根因。

---

## [体验] D. 保留并强化已优处
- `tsc --noEmit` 即时反馈、错误数递减显示、`memory_recall` 恢复上下文——**体验丝滑，保留**。
- 可加：一次改完自动跑 `tsc` 并只报"新增/未消错误"，噪声更小。

---

## 优先级汇总
| 级别 | 项 | 一句话 |
|---|---|---|
| 阻断 | A1 显式失败清单 | 降级不再被静默吞掉 |
| 阻断 | A2 跨文件语义上下文 | fill 别只看单函数签名 |
| 阻断 | A3 决策表确定性翻译 | switch/路由别丢分支 |
| 阻断 | A4 fill 行为断言 | 拦"该单播却广播"类错 |
| 重要 | B1 globals 瘦身 | 防类型冲突/膨胀 |
| 重要 | B2 types-map 索引 | 替代 grep 定位 |
| 重要 | B3 转换约定表 | 少靠经验 |
| 重要 | C1 内建 fixer | 别 40 个脚本叠层 |
| 重要 | C2 错误聚类 | 看类数不看条数 |
| 体验 | D 保留即时反馈 | 已优处不动 |

**验证口径（交付给开发窗口）**：修完跑一次整仓翻译，用 `router`/`permission` 两个真实文件做行为对拍（喂代表性 Address/subtype，断言单播 vs 广播、`permission.response` 只回 requester），要求与 Go 行为一致，且 `as any` 数、手写 fix 脚本数显著下降。