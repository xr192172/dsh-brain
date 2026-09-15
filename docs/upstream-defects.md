# 上游（DSH / Cordis）缺陷清单 —— 我们改过的东西逐项归类

> 目的：把「我们修的东西」按**归属**拆开，避免把自家问题当上游 bug 报出去（噪音），
> 也避免把真上游 bug 烂在本地。
>
> 建立于 2026-09-15。上游核验基线：`deepseek-ai/deepseek-harness` master
> ref `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。

---

## 0. ★ 先回答「能不能提 PR」—— 不能

`CONTRIBUTING.md` 原文（2026-09-15 读）：

> DeepSeek Harness is still at an early stage and under active development.
> **We are sorry that we cannot accept external pull requests at the moment.**
> However, contributing code to this repository is far from the only way to help …
> - Identify and report issues or bugs in **GitHub Discussions**
>   - Upvote discussions that you would like to bring to the team's attention.

**⇒ PR 通道关闭；唯一官方通道是 GitHub Discussions 提 bug/issue。**
仓库地址：<https://github.com/deepseek-ai/deepseek-harness>（MIT）。

另注：上游内部有 `.agents/notes/archived/bug-fix/YYYY-MM-DD-<slug>.md` 的缺陷记录约定
（每篇配 `.zh.md` + `.i18n.yaml`）。**上报时按这个形状写（标题=症状简写、正文=复现+根因+修法），
对方读起来最省力** —— 见 §3。

---

## 1. 归类总表

| # | 事项 | 归属 | 上游核验 | 可否上报 |
|---|---|---|---|---|
| U1 | `goal-round-driver`：`event.data.reason.kind` 缺可选链 | **上游 bug** | ✅ **确认仍在 master** | ✅ 可报（首选） |
| U2 | `app-boot`：裸 `JSON.parse(readFileSync(...))` 无 BOM 防护 | **上游 bug？** | ⚠️ **待复核**（见 §2.2） | ⏸ 复核后再定 |
| D1 | `web-app`：`localWebUrl` 把**实例端口**写进 system prompt → 换代必 cache miss | 上游**设计缺口** | ✅ 代码仍在（设计讨论） | ◯ 可作 feature request |
| D2 | `--dump-config` 不校验插件 config（假绿） | 上游 **UX 缺口** | ✅ 行为已本地实测 | ◯ 可作 feature request |
| O1 | switchboard 启动健康漏判（保险失效） | **我们自己的** | — | ✗ 不可报 |
| O2 | 6 个插件 `Config = z.object` 不容忍缺 config | **我们自己的**（根因在 cordis 设计，见 §4） | — | ✗ 不可报（设计讨论另说） |
| O3 | `dsh-compaction-basic` 500 行补丁 | **我们自己的特性**（兜底后端） | — | ✗ 不可报 |
| O4 | `patch-profile-deps` / 移除桌宠 | **我们的配置选择** | — | ✗ 不可报 |

**结论：真正「干净、可报、且确认上游仍存在」的只有 1 项（U1）。**
其余或需复核、或是设计讨论、或是我们自己的。

---

## 2. 逐项证据

### 2.1 ✅ U1 `goal-round-driver` 缺可选链（确认仍在 master）

**症状**（我方实测）：交接/中断边界态下 `turn/end` 的 `data.reason` 缺失时，
`event.data.reason.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，
被 web 前端包装成「本轮运行失败」。

**上游核验**（code search，master ref `0d1f5000`）——`packages/goal/goal-round-driver/src/index.ts`：

```ts
case 'turn/end':
  if (event.data.reason.kind === 'max-tokens') {   // ← 无 ?.
    disarm(state)
...
  if (event.data.reason.kind !== 'aborted') return  // ← 无 ?.
```

**两处，且外层没有 try/catch** ⇒ 类型上 `reason` 若可缺失，这就是真崩溃点。

**我们本地的修法**（`scripts/patch-goal-round-driver.mjs`，幂等）：
`event.data.reason.kind` → `event.data.reason?.kind`。

> ★ 上报时值得附带的一个**判据问题**，比补 `?.` 更有价值：
> 若 `turn/end` 的 `reason` 在架构上**必然存在**，那这是「上游某条路径漏填 `reason`」，
> 补 `?.` 只是掩盖；若**可能缺失**，那类型签名就该是 `reason?:`。
> 上游需要回答的是「哪个前提下 reason 可以为空」—— 这是他们能真正修对的前提。
> 我们手上有触发现场（交接/中断边界），这正是他们缺的那半。

### 2.2 ⚠️ U2 `app-boot` BOM 防护 —— **待复核，暂不可报**

**我们 rc.2 时的结论**（`scripts/patch-app-boot-bom.mjs` 注释）：
上游只防护了 `readProfileManifest` 一处，另 3 处裸调 `JSON.parse`：

```
:412 healProfilesModuleFallback  appManifest
:430 healProfilesModuleFallback  依赖遍历 manifest
:551 loadProfile                 bundle 包的 package.json
```
症状：带 BOM 的 `package.json` ⇒ `SyntaxError: Unexpected token '\uFEFF'` ⇒ **整个 gen 起不来**
（实测 gen-3085 / gen-3091）。

**为什么现在不能直接报**（两条，都实测过）：

1. **上游已重构**：boot 代码在 2026-09-14 被拆成 `packages/boot/app-boot/src/profile-resolution/`
   （`service.ts` / `resolver.ts`）—— 我们 patch 的行号（`:412/:430/:551`）对应的是
   **rc.2 的编译产物 `lib/index.js`**，不是今天的源码。行号与函数名都已失效。
2. **防护代码搜不到，但症状可能已变**：在 `packages/boot` 内搜索
   `FEFF` → **0 命中**；`charCodeAt` → **0 命中**；`stripBom` → **0 命中**；`65279` → 仅文档命中。
   ⇒ 上游 boot 代码里**没有字面量级的 BOM 处理**。但 master 上多处 `JSON.parse` 已被包进
   `try { … } catch`（例：`profile.ts` 的 `readProfileManifest`）⇒
   **即使命中 BOM，症状也很可能从「崩」降级为「静默取不到 manifest」**（另一类 bug，但不同）。

**⇒ 处置**：要报，必须先 `git clone` 一份 master，实际构造带 BOM 的 profile manifest
跑一次，看今天是**崩**、**静默降级**、还是**已自愈**。**在此之前不许引用 rc.2 的症状描述** ——
拿旧版本的观测去描述新版本的代码，是我们自己定的「判据与信号不可混」的反面。

### 2.3 ◯ D1 `web-app` 把实例端口写进 system prompt（设计缺口，非 bug）

**我们的实测**：`dsh-web-app` 的 `localWebUrl(ctx)` 返回 `http://127.0.0.1:<本实例端口>`，
经 `webSurfacePrompt()` 拼进 **system prompt**。switchboard 蓝绿换代会把同一会话送到不同实例，
于是**每次迁移 system prompt 字节都变 → 整段 prompt 前缀失效 → 全量 cache miss**。

证据（session-28f50f57，19 次 request/header）：GUI 端口分布 3085/3086/3087/3088/3089/3082×10/
3083×3/3084×2 → 8 个不同实例；**端口变化 13 次，每次变化后首轮命中率均为 0.0%**，
次轮恢复到 97~99%。

**这不是「他们的 bug」**：单实例部署下 `localWebUrl` 返回实例端口完全正确。
是**我们的多实例架构暴露了他们的一个隐含假设** ——
**「把运行期可变的量写进 system prompt」本身就与 prompt 前缀缓存相冲**，
与是否多实例无关（只要端口浮动就中招）。

⇒ 适合作为 **feature request / 设计讨论**：请求支持 `DSH_PUBLIC_WEB_URL` 之类的「对外地址」
覆盖，或把这一项从 system prompt 移到运行期注入。**别当 bug 报。**

### 2.4 ◯ D2 `--dump-config` 不校验插件 config（UX 缺口）

**本地实测（2026-09-15）**：把 `capability-bridge/cordis.patch.yml` 的 `config:` 整块删掉
（即 gen-3083 事故形态），`node …/dsh/lib/bin.js web --dump-config` 仍 **EXIT=0 / 579 行**。
原因：它只**组装并打印**配置文本，**不实例化插件、不调 `resolveConfig`**。

**危害**：`--dump-config` 是很自然的「改配置后的预检」命令，用它当门禁会**假绿**
（我们自己也踩过：曾据它得出「配置没问题」的错误推论）。

⇒ 适合作为 feature request：提供一个会**真正实例化插件树**的预检模式
（或让 `--dump-config` 附带 config 校验结果）。**不是 bug** —— "dump" 字面上没承诺校验。

---

## 3. 如果决定上报：建议的报告形状

按上游 `.agents/notes/bug-fix/` 的既有约定写（他们自己就是这么记缺陷的）：

```markdown
# <症状简写，kebab-case>           例：turn-end-missing-reason-crash

## 症状             一句话 + 用户可见表现
## 复现             最小步骤 / 环境（版本、平台）
## 证据             原始报错栈 + 触发前提
## 根因             定位到文件:行 + 为什么
## 建议修法         代码片段（可选）
## 我们为什么能遇到  ← 我们的独有价值
```

**最后一行是我们的护城河**：上游是「小团队」且自陈「may not be able to reply to every post」，
但**我们有真实运行日志与复现现场** —— 这恰好是他们做不到的那部分。
（例：U1 我们能给出「交接/中断边界」这个触发前提；U2 我们能给出带 BOM 的真实 gen 日志。）

**排序建议**：只报 U1（确认、干净、有现场）。U2 复核后再定。
D1/D2 用讨论帖而非 bug 帖 —— 混在一起会稀释信号。

---

## 4. 一条不该报、但值得记的设计观察（cordis × zod）

`@deepseek-ai/cordis` 的 `resolveConfig(runtime, config)`（`lib/index.js:955`）：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new ValidationError(result.issues)   // ← undefined 走这里
  else return result.value
}
```

**现象**：插件写 `export const Config = z.object({...})` 时，patch 里漏写 `config:` ⇒
loader 传 `undefined` ⇒ 抛 `ValidationError` ⇒ **整棵插件树装配失败**。

**但不该报为 bug**，理由：cordis 自带的 `@deepseek-ai/schemastery` **原生容忍**
`undefined`/`null`（本地实测：`subagent-council` 用 schemastery，喂 undefined/null 全通过）。
⇒ cordis 的设计基石是 schemastery 的宽容，**换用 zod 会静默失去这层宽容** ——
这是「插件作者选型时的隐藏契约」，属于**设计文档缺口**，不是代码缺陷。
我们的处置（`tolerantConfig` 包一层 `z.preprocess`）是**使用者侧的正确解法**。

> 若要提，只值得作为**文档建议**：「cordis 的 `Config` 校验约定：schemastery 宽容 undefined，
> zod 不宽容」写进插件作者指南，能省掉每个 zod 作者的一次踩坑。

---

## 5. 本地对应资产索引

| 资产 | 对应项 |
|---|---|
| `scripts/patch-goal-round-driver.mjs` | U1 |
| `scripts/patch-app-boot-bom.mjs` | U2（待复核） |
| `scripts/patch-web-app-public-url.mjs` | D1 |
| `scripts/check-config-tolerance.mjs` / `probe-config-resolveconfig.mjs` | O2 |
| `patches/@deepseek-ai+dsh-compaction-basic+0.1.1-rc.2.patch` | O3 |
| `packages/switchboard/src/boot-health.ts` | O1 |

> ⚠️ 本地包版本 `0.1.1-rc.2`，上游 master 活跃（本清单建立当日仍有提交）
> ⇒ **任何上报动作前都要先确认当前上游版本与 master 是否仍匹配**，否则会报已修/已重构的东西。
