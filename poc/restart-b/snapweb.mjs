import { chromium } from 'playwright'
const T = process.argv[2]
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
const events = []
p.on('websocket', ws => { events.push('ws open ' + ws.url().slice(0,60)); ws.on('close', () => events.push(new Date().toISOString()+' ws close')) })
p.on('console', m => { if (/error|reconnect|disconnect/i.test(m.text())) events.push('console ' + m.text().slice(0,200)) })
await p.goto('http://127.0.0.1:8790/?token='+T)
await p.waitForTimeout(4000)
await p.screenshot({ path: '/workspace/work/snapb/w0.png' })
const box = () => p.locator('textarea, [contenteditable="true"]').first()
await box().click(); await box().fill('RESTART please')
await p.getByRole('button', { name: 'Send message' }).click()
console.log('sent at', new Date().toISOString(), p.url())
for (let i = 1; i <= 12; i++) { await p.waitForTimeout(10000); await p.screenshot({ path: `/workspace/work/snapb/w${i}.png` }); console.log(i, new Date().toISOString(), p.url()) }
console.log('page text tail:', (await p.locator('body').innerText()).slice(-800))
// try a follow-up without reload
try {
  await box().click({ timeout: 5000 }); await box().fill('after restart')
  await p.getByRole('button', { name: 'Send message' }).click({ timeout: 5000 })
  await p.waitForTimeout(15000)
  console.log('followup ok; tail:', (await p.locator('body').innerText()).slice(-500))
} catch (e) { console.log('followup failed', String(e).slice(0,200)) }
await p.screenshot({ path: '/workspace/work/snapb/wfinal.png' })
console.log(events.join('\n'))
await b.close()
