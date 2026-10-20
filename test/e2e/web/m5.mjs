// M5-1 网页端 e2e：/newsnap snap → 对话里出现书签卡 → 悬停点「回到这里」→ B 确认框 → 过渡层 → 宿主重启后页面自动刷新
// → 输入框上方出现提示条 → 点「撤销」→ 确认 → 再次自动刷新 → 提示条变成「已撤销」。用法：node m5.mjs <url>
import { chromium } from 'playwright'
import fs from 'node:fs'
const E = process.env.E ?? '/workspace/work/ns-web', WS = `${E}/ws`
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
let loads = 0
p.on('load', () => { loads++ })
const shot = (n) => p.screenshot({ path: `${E}/m5-${n}.png` })
const box = () => p.locator('textarea, [contenteditable="true"]').first()
async function openSession() {
  await p.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
  await p.getByText('mock reply #2').first().click({ timeout: 30000 }); await p.waitForTimeout(4000)
}
await p.goto(process.argv[2]); await p.waitForTimeout(8000)
await openSession()
fs.writeFileSync(`${WS}/m5.txt`, 'v1\n')
await box().click({ timeout: 30000 }); await box().fill('/newsnap snap 网页测试'); await p.keyboard.press('Enter'); await p.waitForTimeout(800); await p.keyboard.press('Enter')
await p.waitForTimeout(6000)
const card = p.locator('[data-newsnap="bookmark"]').last()
log('bookmark cards:', await p.locator('[data-newsnap="bookmark"]').count(), 'text:', (await card.innerText().catch(() => '(none)')).replace(/\n+/g, ' '))
fs.writeFileSync(`${WS}/m5.txt`, 'v2\n')
await card.hover(); await p.waitForTimeout(400); await shot('1-bookmark')
await card.locator('[data-newsnap="restore"]').click(); await p.waitForTimeout(2500)
log('dialog:', (await p.locator('[data-newsnap="dialog"]').innerText()).replace(/\n+/g, ' '))
await p.getByText('查看详情').click(); await p.waitForTimeout(800); await shot('2-dialog')
log('details:', (await p.locator('[data-newsnap="dialog"]').innerText()).replace(/\n+/g, ' '))
const before = loads
await p.locator('[data-newsnap="confirm"]').click(); await p.waitForTimeout(1500)
log('transition:', await p.locator('[data-newsnap="transition"]').count()); await shot('3-transition')
const t0 = Date.now()
while (loads === before && Date.now() - t0 < 120000) await p.waitForTimeout(1000)
log('auto reload:', loads > before, 'after', Math.round((Date.now() - t0) / 1000), 's; m5.txt =', fs.readFileSync(`${WS}/m5.txt`, 'utf8').trim())
await p.waitForTimeout(6000); await openSession()
const banner = p.locator('[data-newsnap="banner"]')
log('banner:', (await banner.innerText().catch(() => '(none)')).replace(/\n+/g, ' ')); await shot('4-banner')
await banner.locator('[data-newsnap="undo"]').click(); await p.waitForTimeout(1500)
log('undo dialog:', (await p.locator('[data-newsnap="dialog"]').innerText()).replace(/\n+/g, ' '))
const before2 = loads
await p.locator('[data-newsnap="confirm"]').click()
const t1 = Date.now()
while (loads === before2 && Date.now() - t1 < 120000) await p.waitForTimeout(1000)
log('auto reload 2:', loads > before2, 'after', Math.round((Date.now() - t1) / 1000), 's; m5.txt =', fs.readFileSync(`${WS}/m5.txt`, 'utf8').trim())
await p.waitForTimeout(6000); await openSession()
log('banner 2:', (await banner.innerText().catch(() => '(none)')).replace(/\n+/g, ' ')); await shot('5-undone')
await banner.getByRole('button', { name: '关闭提示' }).click().catch(() => {}); await p.waitForTimeout(500)
log('banner after ×:', await banner.count())
log('console errors:', errors.slice(0, 8).join(' || ') || '(none)')
await b.close()
