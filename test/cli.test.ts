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
  const list = await run(['list', '--cwd', cwd], home)
  assert.match(list.text, /^s1 .*团队 Alpha\(alpha\)  4 个会话  n1/m)
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
  assert.equal(doctor.code, 0)
  assert.equal((await run(['bogus'], home)).code, 1)
})
