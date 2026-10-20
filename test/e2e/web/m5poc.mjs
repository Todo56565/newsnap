// M5-0 PoC：会话头部的 newsnap 时光机按钮能挂上、能经 /api/newsnap/list 读到快照；顺带验证 delete / purge 斜杠命令。
import { chromium } from 'playwright'
const url = process.argv[2]
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
const logs = []
p.on('console', (m) => { if (m.type() === 'error' || m.text().includes('newsnap')) logs.push(`[${m.type()}] ${m.text()}`) })
p.on('response', async (r) => { if (r.url().includes('newsnap')) logs.push(`[net] ${r.status()} ${r.url()}`) })
await p.goto(url); await p.waitForTimeout(8000)
await p.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
await p.getByText('mock reply #2').first().click(); await p.waitForTimeout(5000)
const tm = p.locator('[data-newsnap="time-machine"]')
console.log('time-machine mounted:', await tm.count())
if (await tm.count()) {
  console.log('count badge:', await p.locator('[data-newsnap="count"]').innerText())
  await tm.locator('button').click(); await p.waitForTimeout(2500)
  console.log('popover:', (await p.locator('[data-newsnap="popover"]').innerText()).replace(/\n+/g, ' | '))
  await p.screenshot({ path: 'm5-poc-1.png' })
  await tm.locator('button').click()
}
const box = () => p.locator('textarea, [contenteditable="true"]').first()
async function slash(cmd) {
  await box().click({ timeout: 30000 }); await box().fill(cmd); await p.keyboard.press('Enter'); await p.waitForTimeout(800); await p.keyboard.press('Enter')
  await p.waitForTimeout(5000)
  const t = await p.locator('body').innerText()
  const hits = t.match(/(newsnap[：:][^\n]*|将删除[^\n]*)/g) || ['(none)']
  console.log(`${cmd} =>`, hits.slice(-1)[0])
}
const rescue = process.argv[3]
if (rescue) {
  await slash(`/newsnap delete ${rescue}`)
  await slash(`/newsnap delete ${rescue} confirm`)
  await slash('/newsnap status')
}
await slash('/newsnap purge')
await slash('/newsnap purge confirm')
if (await tm.count()) {
  await tm.locator('button').click(); await p.waitForTimeout(2500)
  console.log('popover after purge:', (await p.locator('[data-newsnap="popover"]').innerText()).replace(/\n+/g, ' | '))
  await p.screenshot({ path: 'm5-poc-2.png' })
}
console.log(logs.slice(0, 30).join('\n'))
await b.close()
