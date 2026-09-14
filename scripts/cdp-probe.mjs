// CDP: read DSH_HOME + the resolved profile manifest that the gen actually boots.
import http from 'node:http'
const targetPort = process.argv[2] || '32818'
function getTargets(port) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}/json`, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}
async function main() {
  const targets = await getTargets(targetPort)
  const t = targets[0]
  const { default: WebSocket } = await import('ws')
  const s = new WebSocket(t.webSocketDebuggerUrl)
  let id = 0; const pend = {}
  const call = (m, p) => new Promise((res) => { const i = ++id; pend[i] = res; s.send(JSON.stringify({ id: i, method: m, params: p })) })
  s.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id] } })
  await new Promise((r) => s.on('open', r))
  const expr = `(() => {
    const fs = process.getBuiltinModule ? process.getBuiltinModule('fs') : null
    const home = process.env.DSH_HOME
    const p = home + '/profiles/web/package.json'
    let bundles = []
    try { if (fs) { const j = JSON.parse(fs.readFileSync(p,'utf8')); bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [] } } catch(e) { bundles = ['ERR:'+e.message] }
    return { DSH_HOME: home, profilePath: p, bundles, hasCatpet: bundles.includes('catpet-desktop-pet'), hasBridge: bundles.includes('@dsh-brain/design-canvas-bridge') }
  })()`
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log('MANIFEST:', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? {}, null, 2))
  s.close(); process.exit(0)
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })