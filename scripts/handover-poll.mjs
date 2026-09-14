// handover-poll.mjs — 轮询 switchboard 蓝绿换代结果。
const base = 'http://127.0.0.1:31800/'
const get = async (q) => (await fetch(base + q)).text()
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const result = await get('?cmd=result')
  const flow = JSON.parse(await get('?cmd=flow'))
  const tail = (flow.rows ?? []).slice(-3)
  console.log('t+' + (i + 1) * 5 + 's  result=' + result.slice(0, 240))
  for (const row of tail) console.log('     ' + JSON.stringify(row))
  if (!/"result":null/.test(result)) break
}
