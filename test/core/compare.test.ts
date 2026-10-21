import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { captureSnapshot, resolveTeamSessions } from '../../src/core/capture.ts'
import { checkRelPath, compareWorkspace, countTurns, fileDiff, readSessionLog, sessionImpact, zstdFrames } from '../../src/core/compare.ts'
import { layout } from '../../src/core/manifest.ts'
import { newsnapRoot, sessionDir } from '../../src/core/paths.ts'
import { header, world, writeSession } from '../helpers/world.ts'

const turn = (n: number) => `{"type":"turn/start","seq":${n},"time":1,"data":{"turn":${n}}}\n`

test('zstdFrames：多帧逐帧解压，截断的尾帧丢掉', async () => {
  const a = zstdCompressSync(Buffer.from('one\n'))
  const b = zstdCompressSync(Buffer.from('two\n'))
  const c = zstdCompressSync(Buffer.from('three\n'))
  const buf = Buffer.concat([a, b, c.subarray(0, c.length - 2)])
  assert.equal(zstdFrames(buf).length, 2)
  const { base } = await tmp()
  const f = join(base, 'x.jsonl.zstd')
  await writeFile(f, Buffer.concat([a, b, c]))
  assert.equal(await readSessionLog(f), 'one\ntwo\nthree\n')
})

async function tmp() {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  return { base: await mkdtemp(join(tmpdir(), 'ns-cmp-')) }
}

test('countTurns：只数 turn/start，zstd 多帧与明文都行，读不出为 null', async () => {
  const { base } = await tmp()
  const z = join(base, 's.jsonl.zstd')
  await writeFile(z, Buffer.concat([zstdCompressSync(Buffer.from(header('s', '/w') + turn(1))), zstdCompressSync(Buffer.from('{"type":"turn/end"}\n' + turn(2)))]))
  assert.equal(await countTurns(z), 2)
  const p = join(base, 's.jsonl')
  await writeFile(p, header('s', '/w') + turn(1) + '{"type":"user/message","text":"turn/start"}\n')
  assert.equal(await countTurns(p), 1)
  assert.equal(await countTurns(join(base, 'nope.jsonl')), null)
})

test('compareWorkspace：快照 → 现在的增删改与行数；没变化为空', async () => {
  const { home, cwd, team } = await world()
  await writeFile(join(cwd, 'keep.txt'), 'a\nb\nc\n')
  await writeFile(join(cwd, 'gone.txt'), 'bye\n')
  const m = await captureSnapshot({ home, cwd, team, id: 's1' })
  const repoDir = layout(newsnapRoot(home, cwd)).repo
  assert.deepEqual((await compareWorkspace({ cwd, repoDir, commit: m.workspace.commit })).files, [])
  await writeFile(join(cwd, 'keep.txt'), 'a\nB\nc\nd\n')
  await rm(join(cwd, 'gone.txt'))
  await mkdir(join(cwd, 'src'))
  await writeFile(join(cwd, 'src/new.ts'), 'x\n')
  await writeFile(join(cwd, 'bin.dat'), Buffer.from([0, 1, 2]))
  const got = await compareWorkspace({ cwd, repoDir, commit: m.workspace.commit })
  assert.deepEqual(got.files, [
    { path: 'bin.dat', status: 'added', added: null, removed: null },
    { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
    { path: 'keep.txt', status: 'modified', added: 2, removed: 1 },
    { path: 'src/new.ts', status: 'added', added: 1, removed: 0 },
  ])
  // 只读：没挂新 ref，工作区没动
  const d = await fileDiff({ cwd, repoDir, commit: m.workspace.commit, path: 'keep.txt' })
  assert.deepEqual(d, { kind: 'text', path: 'keep.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\nd\n' })
  assert.deepEqual(await fileDiff({ cwd, repoDir, commit: m.workspace.commit, path: 'gone.txt' }), { kind: 'text', path: 'gone.txt', oldText: 'bye\n', newText: null })
  assert.deepEqual(await fileDiff({ cwd, repoDir, commit: m.workspace.commit, path: 'src/new.ts' }), { kind: 'text', path: 'src/new.ts', oldText: null, newText: 'x\n' })
  assert.equal((await fileDiff({ cwd, repoDir, commit: m.workspace.commit, path: 'bin.dat' })).kind, 'binary')
})

test('checkRelPath：拒绝绝对路径、..、反斜杠和空段', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a\\b', 'a//b', './a']) assert.throws(() => checkRelPath(bad))
  assert.equal(checkRelPath('src/a.ts'), 'src/a.ts')
})

test('sessionImpact：保留的会话比轮数，快照后新开的标 removed，现在没有的标 restored', async () => {
  const { home, cwd, team } = await world()
  await appendFile(join(sessionDir(home, cwd, 'm1'), 'session.v4.jsonl'), turn(1))
  const m = await captureSnapshot({ home, cwd, team, id: 's1' })
  // 之后：m1 又跑两轮；sub2 消失；新开一个 m1 的子代理会话 sub3
  await appendFile(join(sessionDir(home, cwd, 'm1'), 'session.v4.jsonl'), turn(2) + turn(3))
  await rm(sessionDir(home, cwd, 'sub2'), { recursive: true })
  await writeSession(home, cwd, 'sub3', 'm1', false)
  const current = await resolveTeamSessions(home, cwd, team)
  const got = await sessionImpact({ home, snapDir: layout(newsnapRoot(home, cwd)).snapDir('s1'), manifest: m, current })
  const by = new Map(got.map((s) => [s.id, s]))
  assert.deepEqual(by.get('m1'), { id: 'm1', role: 'member', change: 'kept', snapTurns: 1, nowTurns: 3 })
  assert.equal(by.get('cap')?.change, 'kept')
  assert.equal(by.get('sub2')?.change, 'restored')
  assert.deepEqual(by.get('sub3'), { id: 'sub3', role: 'descendant', change: 'removed', snapTurns: null, nowTurns: 0 })
  assert.equal(got[0]?.role, 'captain')
})
