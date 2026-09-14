// 追加 tool_apply 进化脑管控 milestone 到 project_memory.md
import fs from 'node:fs'
const f = 'C:/Users/Admin/.trae-cn/memory/projects/-d-project-develop-dsh-brain--p2-809ce7b40f55c9d32a39/project_memory.md'
const add = `
- **tool_apply 升级为"进化脑管控切换"（2026-09-11 实现+验证）**：把 tool_apply 从"裸 apply 扳机"升级为带验证闸的智能通道，落实三脑分工(生产脑提改动/进化脑验证判定/实验脑隔离被测)——生产脑改完 P0 内容调 tool_apply，可选 verify=<验证命令>，控制面先跑该闸，通过(输出 JSON {ok:true})才 flip、拒绝/失败回滚。改动：coordinator.handover 加第4参 verifyOverride(验证闸块优先用它)；main.ts apply 端点透传 &verify=；deploy.ts tool_apply 加 verify 参数并透传；start-switchboard.ps1 设 VERIFY_ALLOW=C:\\Users\\Admin\\AppData\\Local\\Temp\\verifyout。验证跑通：通过路径 state.jsonl "verify-gate ok - 本次 apply 指定"→flip；拒绝路径 "verify-gate 失败...不在白名单→安全拒绝并回滚"。verify 命令须无引号空格(node <abs>)，脚本须落 VERIFY_ALLOW 白名单目录，输出一行 {ok:true}。与 self_evolve 分工：self_evolve 管 design-canvas 内核源码实验(独立实验内核产物+verify闸)；tool_apply(verify) 管业务改动上线决策，复用同一控制面 verify-gate。文档更新在 docs/three-brain-evolution.md §5/§7。
`
fs.appendFileSync(f, add, 'utf8')
console.log('appended ok')