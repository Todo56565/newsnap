// 网页端 e2e：拍照（斜杠命令）→ 改文件、再一轮 → /newsnap restore <id> confirm → 自动重启 → 页面重连 → 续一轮
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
const E = process.env.E ?? '/workspace/work/ns-web', HOME = `${E}/home`, WS = `${E}/ws`, URL0 = process.argv[2]
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
const events = []
p.on('websocket', ws => { events.push('ws open'); ws.on('close', () => events.push(new Date().toISOString().slice(11,19) + ' ws close')) })
await p.goto(URL0)
await p.waitForTimeout(6000)
await p.getByRole('button', { name: 'Continue' }).click().catch(() => {})
await p.getByRole('button', { name: 'Choose workspace' }).click(); await p.waitForTimeout(1500)
await p.getByRole('button', { name: 'Edit path' }).click(); await p.waitForTimeout(500)
await p.keyboard.press('Control+a'); await p.keyboard.type(WS); await p.keyboard.press('Enter'); await p.waitForTimeout(1500)
await p.getByRole('button', { name: 'Open' }).click().catch(e => log('open click', String(e).slice(0, 80)))
await p.waitForTimeout(2000)
await p.screenshot({ path: `${E}/w0-ws.png` })
const box = () => p.locator('textarea, [contenteditable="true"]').first()
async function send(text, wait = 8000) {
  await box().click({ timeout: 30000 }); await box().fill(text)
  await p.keyboard.press('Enter')
  log('sent', text)
  await p.waitForTimeout(wait)
}
const body = async () => (await p.locator('body').innerText())
const shot = n => p.screenshot({ path: `${E}/${n}.png` })
await send('hello one')
const sdir = fs.readdirSync(`${HOME}/sessions`, { recursive: true }).find(f => /session-[0-9a-f-]+$/.test(f))
const sid = path.basename(sdir); log('sid', sid)
fs.mkdirSync(`${WS}/.agent-teams/t1`, { recursive: true })
fs.writeFileSync(`${WS}/.agent-teams/t1/team.json`, JSON.stringify({ name: 'T1', id: 't1', captainSessionId: sid, createdAt: 1, taskSeq: 0, members: [], tasks: [] }))
await send('/newsnap snap first')
await shot('w1-snap')
const snap = fs.readdirSync(fs.readdirSync(`${HOME}/newsnap`).map(d => `${HOME}/newsnap/${d}/snaps`).find(fs.existsSync))[0]
log('snap', snap, 'page has 已拍快照:', (await body()).includes('已拍快照'))
fs.writeFileSync(`${WS}/target.txt`, 'v2\n'); fs.writeFileSync(`${WS}/added.txt`, 'x')
await send('turn two')
await send(`/newsnap restore ${snap}`, 5000)
log('preview shown:', (await body()).includes('确认请输入'))
await shot('w2-preview')
await send(`/newsnap restore ${snap} confirm`, 3000)
await shot('w3-restoring')
const t0 = Date.now()
let reconnected = false
let serverBack = false
for (let i = 0; i < 120; i++) {
  await p.waitForTimeout(3000)
  if (!serverBack) { try { await fetch('http://127.0.0.1:8791/'); serverBack = Date.now() - t0 > 5000 } catch {} ; if (serverBack) log('server back after', Math.round((Date.now() - t0) / 1000), 's') }
  if (serverBack && !/Reconnecting/i.test(await body())) { reconnected = true; break }
}
log('reconnected', reconnected, 'after', Math.round((Date.now() - t0) / 1000), 's')
await shot('w4-after')
log('target.txt', fs.readFileSync(`${WS}/target.txt`, 'utf8').trim(), 'added.txt', fs.existsSync(`${WS}/added.txt`) ? 'present' : 'gone')
await send('/newsnap status', 4000)
log('status mentions 已恢复:', (await body()).includes('已恢复到'))
await send('after restore', 10000)
await shot('w5-followup')
log('page tail:', (await body()).slice(-600).replace(/\n+/g, ' | '))
await p.reload(); await p.waitForTimeout(6000)
await p.getByRole('button', { name: 'Continue' }).click().catch(() => {})
await shot('w6-reload')
log('after reload:', (await body()).replace(/\n+/g, ' | ').slice(0, 900))
log(events.join('; '))
await b.close()
