import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { captureSnapshot } from '../src/core/capture.ts'
import { world } from './helpers/world.ts'

async function run(args: string[], home: string): Promise<{ code: number; text: string }> {
  const prev = process.env.DSH_HOME
  const prevDir = process.env.NEWSNAP_DSH_DIR
  process.env.DSH_HOME = home
  process.env.NEWSNAP_DSH_DIR = '/nonexistent'
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((c: string) => (chunks.push(String(c)), true)) as typeof process.stdout.write
  try {
    return { code: await main(args), text: chunks.join('') }
  } finally {
    process.stdout.write = orig
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    if (prevDir === undefined) delete process.env.NEWSNAP_DSH_DIR
    else process.env.NEWSNAP_DSH_DIR = prevDir
  }
}

test('cli：list、apply（要求 --dsh-stopped 或 flock）、undo、doctor', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1', note: 'n1' })
  const snap = await run(['snap', '--session', 'm1', '--cwd', cwd, '--dsh-stopped', 'cli', 'note'], home)
  assert.equal(snap.code, 0, snap.text)
  assert.equal((await run(['snap', '--session', 'nobody', '--cwd', cwd, '--dsh-stopped'], home)).code, 1)
  const list = await run(['list', '--cwd', cwd], home)
  assert.match(list.text, /^s1 .*团队 Alpha\(alpha\)  4 个会话  n1/m)
  assert.match(list.text, /cli note/)
  await writeFile(join(cwd, 'main.ts'), 'changed')
  const flockAvailable = (await run(['doctor', '--cwd', cwd], home)).text.includes('会话写锁探测：可用')
  if (!flockAvailable) await assert.rejects(run(['apply', 's1', '--cwd', cwd], home), /--dsh-stopped/)
  const applied = await run(['apply', 's1', '--cwd', cwd, '--dsh-stopped'], home)
  assert.equal(applied.code, 0, applied.text)
  assert.match(applied.text, /已恢复/)
  const undone = await run(['undo', '--cwd', cwd, '--dsh-stopped'], home)
  assert.equal(undone.code, 0, undone.text)
  const doctor = await run(['doctor', '--cwd', cwd], home)
  assert.match(doctor.text, /登记的恢复：rescue .*状态 applied/)
  assert.match(doctor.text, /救援点：2 份/)
  assert.match(doctor.text, /快照：2 份/)
  assert.equal(doctor.code, 0)
  assert.equal((await run(['bogus'], home)).code, 1)
})

test('cli：delete / purge 不带 --yes 只预览，带 --yes 才删', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 'd1', now: 1 })
  await captureSnapshot({ home, cwd, team, id: 'd2', now: 2 })
  const preview = await run(['delete', 'd1', '--cwd', cwd], home)
  assert.equal(preview.code, 1)
  assert.match(preview.text, /将删除快照 d1/)
  assert.match((await run(['list', '--cwd', cwd], home)).text, /^d1 /m)
  const done = await run(['delete', 'd1', '--yes', '--cwd', cwd], home)
  assert.equal(done.code, 0, done.text)
  assert.doesNotMatch((await run(['list', '--cwd', cwd], home)).text, /^d1 /m)
  assert.equal((await run(['delete', 'nope', '--cwd', cwd], home)).code, 1)
  const pp = await run(['purge', '--cwd', cwd], home)
  assert.equal(pp.code, 1)
  assert.match(pp.text, /1 个快照、0 个救援点/)
  assert.equal((await run(['purge', '-y', '--cwd', cwd], home)).code, 0)
  assert.match((await run(['list', '--cwd', cwd], home)).text, /没有快照/)
})
