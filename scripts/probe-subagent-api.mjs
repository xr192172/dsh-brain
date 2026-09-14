import fs from 'node:fs'
const D = 'D:/project_develop/dsh-brain/node_modules/@deepseek-ai'
const out = []
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

const svc = read(`${D}/dsh-subagent/lib/index.js`)
out.push('===== dsh-subagent 服务：出现的方法名 =====')
const METHODS = ['getProvider', 'listProviders', 'providerNames', 'startContinuable', 'registerProvider', 'removeProvider', 'providers']
out.push(METHODS.filter((m) => svc.includes(m)).join(', '))
out.push('')
out.push('--- 事件名 ---')
out.push([...new Set([...svc.matchAll(/"(subagent\/[a-zA-Z-]+)"/g)].map((m) => m[1]))].join(', '))
out.push('')
out.push('--- 含 Provider/start/list 的定义行 ---')
out.push(svc.split('\n').filter((l) => l.length < 160 && /Provider|startContinuable|listProviders/.test(l)).slice(0, 22).join('\n'))

const spawn = read(`${D}/dsh-subagent-spawn-in-process/lib/index.js`)
out.push('')
out.push('===== spawn provider 实现：成员键 =====')
const KEYS = ['name', 'capabilities', 'depthLimit', 'inheritsParentContext', 'prepareContinuable', 'providerName']
out.push(KEYS.filter((k) => new RegExp(k + '\\s*:').test(spawn)).join(', '))
const ci = spawn.indexOf('capabilities')
out.push('')
out.push('--- capabilities 附近 500 字符 ---')
out.push(ci >= 0 ? spawn.slice(Math.max(0, ci - 250), ci + 250).replace(/\s+/g, ' ') : '(not found)')

const ctrl = read(`${D}/dsh-tool-subagent-control/lib/index.js`)
out.push('')
out.push('===== tool-subagent-control =====')
out.push('长度: ' + ctrl.length)
out.push('工具名字面量: ' + [...new Set([...ctrl.matchAll(/name:\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]))].join(', '))
out.push('描述: ' + [...new Set([...ctrl.matchAll(/description:\s*"([^"]{10,200})"/g)].map((m) => m[1]))].slice(0, 5).join('\n  '))

const rep = read(`${D}/dsh-tool-subagent-report/lib/index.js`)
out.push('')
out.push('===== tool-subagent-report =====')
out.push('工具名: ' + [...new Set([...rep.matchAll(/name:\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]))].join(', '))
out.push('描述: ' + [...new Set([...rep.matchAll(/description:\s*"([^"]{10,200})"/g)].map((m) => m[1]))].slice(0, 4).join('\n  '))

fs.writeFileSync('D:/project_develop/dsh-brain/out/subagent-api.txt', out.join('\n'), 'utf8')
