// patch-dev-handoff.mjs —— 给 council-dev.md 增「阈值转交」节（一次性补丁）
import fs from 'node:fs';
const p = 'D:/project_develop/dsh-brain/seats/library/council-dev.md';
let t = fs.readFileSync(p, 'utf8');
if (t.includes('## 阈值转交')) { console.log('已存在，跳过'); process.exit(0); }
const anchor = '## Workflow Position';
const section = `## 阈值转交（上下文阈值时的任务接力）

**任务进行中不允许压缩上下文**——到上下文阈值，不做摘要压缩，而是产出**交接包**终止本程，
由评审团验收后派下一程。

交接包格式（校验器：\`scripts/seats/handoff-contract.mjs\`，四段固定顺序不许变）：

1. **已完成（含证据）** —— 每条带证据（命令/读数/路径原文），没有证据的条目不算完成
2. **未完成（剩余）** —— 每条带原因
3. **关键发现与坑** —— 后续接手的人必须知道的
4. **下一步建议** —— 一句话，不许空话收尾

元信息三行在文首：\`- depth: <递归深度>\` / \`- from: <你>\` / \`- to: review-board\`。
产出后交评审团（council-review-board）验收——它验完派下一程。

`;
if (!t.includes(anchor)) { console.error('锚点未找到'); process.exit(1); }
t = t.replace(anchor, section + anchor);
fs.writeFileSync(p, t);
console.log('✓ dev 席已接阈值转交节');
