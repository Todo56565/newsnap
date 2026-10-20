import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureSnapshot } from '../../src/core/capture.ts'
import { registerRestore } from '../../src/core/apply.ts'
import { layout } from '../../src/core/manifest.ts'
import { newsnapRoot } from '../../src/core/paths.ts'
import { git } from '../../src/core/shadow-git.ts'
import { findSnapshot, hasRescue, listSnapshots, purgeWorkspace, RemoveRefused, removeSnapshot, SnapshotNotFound } from '../../src/core/store.ts'
import { world } from '../helpers/world.ts'

async function hasObject(repo: string, oid: string): Promise<boolean> {
  return git(['--git-dir', repo, 'cat-file', '-e', oid]).then(() => true, () => false)
}

async function blobOf(content: string, cwd: string): Promise<string> {
  const tmp = join(cwd, '..', `blob-${Math.random()}`)
  await writeFile(tmp, content)
  try {
    return (await git(['hash-object', '--no-filters', tmp])).trim()
  } finally {
    await rm(tmp, { force: true })
  }
}

test('delete：删快照后 gc，独占对象消失、共享对象和其他快照保留', async () => {
  const { home, cwd, team } = await world()
  const repo = layout(newsnapRoot(home, cwd)).repo
  await writeFile(join(cwd, 'only-a.txt'), 'exclusive to snapshot a')
  const a = await captureSnapshot({ home, cwd, team, id: 'a', now: 1 })
  await rm(join(cwd, 'only-a.txt'))
  const b = await captureSnapshot({ home, cwd, team, id: 'b', now: 2 })
  const exclusive = await blobOf('exclusive to snapshot a', cwd)
  const shared = await blobOf('code', cwd) // main.ts，两份都有
  assert.ok(await hasObject(repo, exclusive))
  assert.ok(await hasObject(repo, a.workspace.commit))

  const r = await removeSnapshot(home, cwd, 'a')
  assert.equal(r.kind, 'snapshot')
  assert.equal(r.undoLost, false)
  assert.equal(await hasObject(repo, exclusive), false)
  assert.equal(await hasObject(repo, a.workspace.commit), false)
  assert.ok(await hasObject(repo, shared))
  assert.ok(await hasObject(repo, b.workspace.commit))
  assert.deepEqual((await listSnapshots(home, cwd)).items.map((i) => i.manifest.snapId), ['b'])
  await assert.rejects(git(['--git-dir', repo, 'rev-parse', '--verify', 'refs/newsnap/snapshot/a']))
  await assert.rejects(removeSnapshot(home, cwd, 'a'), SnapshotNotFound)
  assert.equal(await findSnapshot(home, cwd, '../snaps/b'), undefined)
  assert.equal(await readFile(join(cwd, 'main.ts'), 'utf8'), 'code') // 工作区不受影响
})

test('delete：救援点可删，删的是最近一次恢复的救援点时标记 undo 失效', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 'r1', kind: 'rescue', now: 1 })
  assert.ok(await hasRescue(home, cwd, 'r1'))
  const r = await removeSnapshot(home, cwd, 'r1', 'r1')
  assert.equal(r.kind, 'rescue')
  assert.equal(r.undoLost, true)
  assert.equal(await hasRescue(home, cwd, 'r1'), false)
})

test('delete/purge：有进行中的恢复时拒绝；purge 删光数据、不碰工作区', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1', now: 1 })
  await captureSnapshot({ home, cwd, team, id: 'r1', kind: 'rescue', now: 2 })
  await registerRestore({ home, cwd, target: { kind: 'snapshot', id: 's1' }, relaunch: null, now: 5 })
  await assert.rejects(removeSnapshot(home, cwd, 's1'), RemoveRefused)
  await assert.rejects(purgeWorkspace(home, cwd), RemoveRefused)
  const root = newsnapRoot(home, cwd)
  await rm(layout(root).pending)

  const p = await purgeWorkspace(home, cwd)
  assert.deepEqual(p, { snapshots: 1, rescues: 1, empty: false })
  await assert.rejects(stat(root), { code: 'ENOENT' })
  assert.equal(await readFile(join(cwd, 'main.ts'), 'utf8'), 'code')
  assert.ok((await stat(join(cwd, '.agent-teams/alpha/team.json'))).isFile())
  assert.deepEqual(await purgeWorkspace(home, cwd), { snapshots: 0, rescues: 0, empty: true })
})
