import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LockBusy } from '../../src/core/lock.ts'
import { captureSnapshot } from '../../src/core/capture.ts'
import { newsnapRoot } from '../../src/core/paths.ts'
import { cleanupPartials, deleteSnapshot, listSnapshots } from '../../src/core/store.ts'
import { git } from '../../src/core/shadow-git.ts'
import { world } from '../helpers/world.ts'

test('lock：独占、释放、接管死进程的锁、拒绝活进程与同进程重入', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'ns-lock-')), 'x/lock')
  const release = await acquireLock(path, 'a')
  await assert.rejects(acquireLock(path, 'b'), LockBusy)
  await release()
  await acquireLock(path, 'c')
  await writeFile(path, JSON.stringify({ pid: 999999, time: 1, purpose: 'dead' }))
  await assert.rejects(acquireLock(path, 'd', () => true), LockBusy)
  const r = await acquireLock(path, 'e', () => false)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).purpose, 'e')
  await r()
  await writeFile(path, 'garbage')
  await (await acquireLock(path, 'f'))()
})

test('store：列举按团队代过滤、新的在前、删除连 ref、清残骸', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 'a', now: 1 })
  await captureSnapshot({ home, cwd, team, id: 'b', now: 2 })
  const all = await listSnapshots(home, cwd)
  assert.deepEqual(all.items.map((i) => i.manifest.snapId), ['b', 'a'])
  assert.ok(all.items[0]!.sessionBytes > 0)
  assert.equal((await listSnapshots(home, cwd, 'snapshot', { id: team.id, createdAt: 999 })).items.length, 0)
  const root = newsnapRoot(home, cwd)
  await mkdir(join(root, 'snaps/partial'))
  await mkdir(join(root, 'snaps/broken'))
  await writeFile(join(root, 'snaps/broken/manifest.json'), '{"schema":99}')
  assert.deepEqual((await listSnapshots(home, cwd)).broken, ['broken'])
  assert.deepEqual(await cleanupPartials(home, cwd), []) // 太新，不清
  await utimes(join(root, 'snaps/partial'), 1, 1)
  assert.deepEqual(await cleanupPartials(home, cwd), ['snapshot/partial'])
  await deleteSnapshot(home, cwd, 'snapshot', 'a')
  assert.deepEqual((await listSnapshots(home, cwd)).items.map((i) => i.manifest.snapId), ['b'])
  await assert.rejects(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', '--verify', 'refs/newsnap/snapshot/a']))
})
