// M5-2 网页 e2e：拍快照 → 改文件 → 书签「对比」打开右栏时光机 → 看文件列表、展开 diff、会话轮数 → 从时光机「回到这里」恢复 → 自动刷新后时间线出现恢复记录。
import { chromium } from 'playwright'
import fs from 'node:fs'
const E = '/workspace/work/ns-web', WS = `${E}/ws`
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } })
const errors = []
p.on('console', (m) => { if (m.type() === 'error' || /newsnap/.test(m.text())) errors.push(m.text().slice(0, 300)) })
p.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 300)))
let loads = 0
p.on('load', () => { loads++ })
const shot = (n) => p.screenshot({ path: `${E}/m52-${n}.png` })
const box = () => p.locator('textarea, [contenteditable="true"]').first()
async function openSession() {
  await p.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
  await p.getByText('mock reply #2').first().click({ timeout: 30000 }); await p.waitForTimeout(4000)
}
await p.goto(process.argv[2]); await p.waitForTimeout(8000)
await openSession()
fs.writeFileSync(`${WS}/tm.txt`, 'line 1\nline 2\nline 3\n')
fs.rmSync(`${WS}/tm-new.ts`, { force: true })
await box().click({ timeout: 30000 }); await box().fill('/newsnap snap 时光机测试'); await p.keyboard.press('Enter'); await p.waitForTimeout(800); await p.keyboard.press('Enter')
await p.waitForTimeout(6000)
fs.writeFileSync(`${WS}/tm.txt`, 'line 1\nline two\nline 3\nline 4\n')
fs.writeFileSync(`${WS}/tm-new.ts`, 'export const x = 1\n')
const card = p.locator('[data-newsnap="bookmark"]').last()
log('bookmark:', (await card.innerText().catch(() => '(none)')).replace(/\n+/g, ' '))
await card.hover(); await p.waitForTimeout(400); await shot('1-bookmark')
await card.locator('[data-newsnap="compare"]').click(); await p.waitForTimeout(4000)
const tl = p.locator('[data-newsnap="timeline"]')
log('timeline:', await tl.count(), (await tl.innerText().catch(() => '(none)')).replace(/\n+/g, ' | ').slice(0, 600))
await shot('2-timeline')
const row = tl.locator('[data-newsnap="file"][data-path="tm.txt"] button')
await row.click(); await p.waitForTimeout(2500)
log('diff:', (await tl.locator('[data-newsnap="file"][data-path="tm.txt"]').innerText().catch(() => '(none)')).replace(/\n+/g, ' | ').slice(0, 300))
await shot('3-diff')
await tl.locator('[data-newsnap="tm-restore"]').click(); await p.waitForTimeout(2500)
log('dialog:', (await p.locator('[data-newsnap="dialog"]').innerText().catch(() => '(none)')).replace(/\n+/g, ' '))
const before = loads
await p.locator('[data-newsnap="confirm"]').click()
const t0 = Date.now()
while (loads === before && Date.now() - t0 < 120000) await p.waitForTimeout(1000)
log('auto reload:', loads > before, Math.round((Date.now() - t0) / 1000), 's; tm.txt =', JSON.stringify(fs.readFileSync(`${WS}/tm.txt`, 'utf8')), 'tm-new exists:', fs.existsSync(`${WS}/tm-new.ts`))
await p.waitForTimeout(6000); await openSession()
if (await tl.count() === 0) {
  await p.locator('[data-newsnap="bookmark"]').last().hover(); await p.locator('[data-newsnap="bookmark"]').last().locator('[data-newsnap="compare"]').click().catch(() => {}); await p.waitForTimeout(3000)
}
log('timeline after:', (await tl.innerText().catch(() => '(none)')).replace(/\n+/g, ' | ').slice(0, 600))
await shot('4-after')
log('errors:', errors.slice(0, 10).join(' || ') || '(none)')
await b.close()
