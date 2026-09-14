import { lstatSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
const root = 'D:/project_develop/dsh-brain/packages/switchboard'
const buildId = process.argv[2]
const outId = `${root}/out/${buildId}`
const lib = `${root}/lib`

const c = readFileSync(`${outId}/coordinator.js`, 'utf8')
const d = readFileSync(`${outId}/deploy.js`, 'utf8')
console.log('[coordinator] verifyOverride =', c.includes('verifyOverride'))
console.log('[deploy] args.verify =', d.includes('args.verify'))
console.log('[deploy] q.set verify =', d.includes("set('verify'"))

if (lstatSync(lib).isSymbolicLink()) rmSync(lib)
symlinkSync(outId, lib, 'junction')
console.log('lib flipped ->', outId)