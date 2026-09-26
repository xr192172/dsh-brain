// Count segments per persona and find independence references
import fs from 'node:fs';
const src = fs.readFileSync('packages/subagent-council/src/index.ts', 'utf8');
const lines = src.split('\n');

// Find independence-related lines
console.log('=== Independence references ===');
lines.forEach((l, i) => {
  if (l.includes('独立性') || l.includes('档位') || l.includes('跨模型') || l.includes('跨会话') || l.includes('同会话')) {
    console.log(`L${i+1}: ${l.trim()}`);
  }
});

// Count segments per persona
for (const name of ['ARCHITECT_PERSONA', 'DEV_PERSONA', 'REVIEW_PERSONA']) {
  const re = new RegExp(`const ${name}\\s*=\\s*\x60([\\s\\S]*?)\x60\\s*,?\\s*/\\*`);
  const m = src.match(re);
  if (!m) {
    const re2 = new RegExp(`const ${name}\\s*=\\s*\x60([\\s\\S]*?)\x60`);
    const m2 = src.match(re2);
    if (m2) {
      const body = m2[1];
      const nums = body.match(/\d+\.\s*\*\*(.+?)\*\*/g) || [];
      const decl = body.match(/必须包含这(.+?)段/);
      console.log(`\n${name}: ${nums.length} segments, declared: "${decl ? decl[1] : '?'}"`);
      nums.forEach(n => console.log('  - ' + n.replace(/\*\*/g, '')));
    }
    continue;
  }
  const body = m[1];
  const nums = body.match(/\d+\.\s*\*\*(.+?)\*\*/g) || [];
  const decl = body.match(/必须包含这(.+?)段/);
  console.log(`\n${name}: ${nums.length} segments, declared: "${decl ? decl[1] : '?'}"`);
  nums.forEach(n => console.log('  - ' + n.replace(/\*\*/g, '')));
}
