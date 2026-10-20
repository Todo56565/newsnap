// 网页端：新打开页面后 /newsnap status 仍显示最近一次恢复（B5）
import { chromium } from 'playwright'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
await p.goto(process.argv[2]); await p.waitForTimeout(6000)
await p.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
const box = () => p.locator('textarea, [contenteditable="true"]').first()
for (const round of [1, 2]) {
  if (round === 2) { await p.reload(); await p.waitForTimeout(6000); await p.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {}) }
  await p.getByText('mock reply #2').first().click(); await p.waitForTimeout(2500)
  await box().click({ timeout: 30000 }); await box().fill('/newsnap status'); await p.keyboard.press('Enter'); await p.waitForTimeout(800); await p.keyboard.press('Enter')
  await p.waitForTimeout(6000)
  const t = await p.locator('body').innerText()
  console.log(t.replace(/\n+/g," | ").slice(-700)); console.log(`round ${round}:`, (t.match(/newsnap：[^\n]*/g) || ['(none)']).slice(-1)[0])
}
await b.close()
