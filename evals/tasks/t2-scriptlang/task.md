# 任务 T2：让"技能脚本能不能在本机跑"变成**如实标注**（缺口②）

## 背景（端到端演练的实测发现）
演练里发现：**skill 的 `Script` 是 bash 脚本，在 worker 里跑不动**。
子 agent 自评的原文是：*"bash脚本因**沙箱 E_ACCESSDENIED**无法执行，调用 shell 时**标准输出编码受限**"*，
于是它"改用了 **Node.js 等价实现**"。

★ 另外，`C:\Users\Admin\.dsh\.agent-presets\g0\agent.cordis.yml` 的注释里写着**同一条教训**：
> *"本 preset 早期版本只有一行 `tool-bash`……后果：本机（win32）工具面里是 `bash`、**没有 `pwsh`** ——
>  **壳子名字对了、但跑不动**。"* ⇒ 正解是**按平台 gate 二选一**。

## 要做什么（**只做"检测 + 如实标注"，不要自作主张改写脚本**）
1. 读 `scripts/skill-factory.mjs` 与 `scripts/skill-to-preset.mjs`。
2. 在**工厂**产出的规格里，对 skill 的脚本语言做**可跑性判定**并如实记入：
   - `ScriptLang` 缺失 ⇒ 标 `unknown`
   - `shell` / `bash` 且 `process.platform === 'win32'` ⇒ 标 **`not-runnable-here`**（附一句为什么：本机是 win32，但没有 bash）
   - ★ **判定要基于"本机到底有没有 bash"**：请**实际探测**
     （例如查 PATH 里有没有 `bash` / `sh`；**注意**：本机 Git Bash 存在但沙箱里未必可用 ⇒
      把"探测到什么"和"据此判定什么"**分开写**，别把推断当实测）
3. 在**桥**产出的 preset 里，把这条结论带进 `preset.yml` 的 `description` 与 `agent.cordis.yml` 的注释
   ⇒ **让人一眼看到"这个 skill 的脚本在本机跑不了"**，而不是等到 agent 跑挂了才知道。
4. ★ **不要**自动把 bash 脚本"翻译"成 pwsh —— 那是设计决定，留给人类。你只做**标注**。

## 可判定的验收（逐条贴真实输出）
1. `node scripts/skill-factory.mjs --selftest` ⇒ 仍 PASS（**且新增的判据要通过**）
2. `node scripts/skill-to-preset.mjs --selftest` ⇒ 仍 PASS（**且新增的判据要通过**）
3. 新增判据**必须带消融**：撤掉"平台可跑性判定"⇒ 对应判据**必须变红**（把撤前后的输出都贴出来）
4. 真跑一次端到端（贴输出）：
   `node scripts/skill-factory.mjs --in evals/fixtures/demo-skill/skill_tree.json --json`
   `node scripts/skill-to-preset.mjs --in evals/fixtures/demo-skill/skill_tree.json`
   ⇒ 两份产物里**都要能看到**可跑性标注

## 硬约束
- 只动 `scripts/skill-factory.mjs`、`scripts/skill-to-preset.mjs`（以及**若确有必要**新建的 1 个辅助脚本）。
- **不要**动 `evals/fixtures/demo-skill/` 里的样本（它是输入）。
- **不要**动 `packages/`（那是产品代码，改动要走别的门）。
- 不许 `git commit`、不许 `git push`、不许起服务、不许杀进程。

## 诚实清单（最后必须写）
- 你**实测**到的：本机 PATH 里有没有 bash/sh（逐字贴探测命令与输出）
- 你**据此判定**的：哪些 skill 脚本属于"本机跑不了"
- 哪些是**推断**、哪些**没验证**
