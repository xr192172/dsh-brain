import fs from 'node:fs'
const s = fs.readFileSync('scripts/capability-gate.mjs', 'utf8')
const toLf = (x) => x.replace(/\r\n/g, '\n')
const fileNorm = toLf(s)

// Test find string for task 1
const find1 = "  { level: 'L3', name: '隐藏 holdout', enforced: true, status: 'implemented', scope: '优化器看不见的用例 + 红队对抗用例', why: '已实施：独立 holdout 任务集 + hash 防篡改 + fail-closed' },"
console.log('Task1 find exists:', fileNorm.includes(find1))
if (!fileNorm.includes(find1)) {
  const lines = fileNorm.split('\n')
  lines.forEach((l, i) => {
    if (l.includes("level: 'L3'")) {
      console.log('Actual L3 line ('+(i+1)+'):', JSON.stringify(l))
      console.log('Length:', l.length, 'Expected:', find1.length)
    }
  })
}

// Test find string for task 2
const find2 = "  const realHash = crypto.createHash('sha256').update(fs.readFileSync(tasksPath)).digest('hex')\n  const recordedHash = cap.holdoutHash"
console.log('Task2 find exists:', fileNorm.includes(find2))

// Test find string for task 3
const find3 = "    add('有独立运行结果', false, `读不到结果文件：${resultsFile}（fail-closed：没跑过 = 没证据）`)\n    return { checks, evidence: { l3Misevolution: null } }"
console.log('Task3 find exists:', fileNorm.includes(find3))
