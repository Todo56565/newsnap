import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runApply, initialSteps, ApplyRefused, projcacheFiles } from '../../src/core/apply.ts'
import { captureSnapshot } from '../../src/core/capture.ts'
import { readPending, writePending, readManifest, layout } from '../../src/core/manifest.ts'
import { newsnapRoot, sessionDir, sessionsRoot } from '../../src/core/paths.ts'
import { SessionBusy, assumeStoppedGuard, type SessionGuard } from '../../src/core/session-guard.ts'
import { scanTree } from '../../src/core/tree.ts'
import { world, writeSession } from '../helpers/world.ts'

const guard = assumeStoppedGuard('test')

/** 回溯单元的指纹：会话目录全部文件、.agent-teams 全部文件、工作区文件（不含 .git）。 */
async function fingerprint(home: string, cwd: string) {
  const sessions = (await scanTree(sessionsRoot(home))).filter((e) => !e.path.endsWith('session.lock') && e.type !== 'dir')
  const teams = (await scanTree(join(cwd, '.agent-teams'))).filter((e) => e.type !== 'dir')
  const ws = (await scanTree(cwd, { exclude: (p) => p === '.git' || p === '.agent-teams' })).filter((e) => e.type !== 'dir')
  const strip = (es: Awaited<ReturnType<typeof scanTree>>) => es.map((e) => (e.type === 'file' ? `${e.path}:${e.sha256}` : `${e.path}:${e.type}`))
  return { sessions: strip(sessions), teams: strip(teams), ws: strip(ws) }
}

async function register(home: string, cwd: string, kind: 'snapshot' | 'rescue', id: string) {
  await writePending(newsnapRoot(home, cwd), {
    schema: 1, target: { kind, id }, status: 'registered', steps: initialSteps(), relaunch: null, createdAt: 1,
  })
}

/** 快照之后团队继续干活：会话追加与换代、新成员、notes、工作区、退役名单。 */
async function mutate(home: string, cwd: string) {
  await appendFile(join(sessionDir(home, cwd, 'm1'), 'session.v4.jsonl'), '{"type":"event","seq":2}\n')
  await writeFile(join(sessionDir(home, cwd, 'cap'), 'session.v5.jsonl'), 'compacted generation')
  await writeSession(home, cwd, 'm2')
  await writeSession(home, cwd, 'sub3', 'm2')
  await writeFile(join(cwd, '.agent-teams/alpha/team.json'), JSON.stringify({
    name: 'Alpha', id: 'alpha', captainSessionId: 'cap', createdAt: 7,
    members: [{ id: 'm2', name: 'b' }], tasks: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'completed' }],
  }))
  await writeFile(join(cwd, '.agent-teams/retired-members.json'), JSON.stringify(['m0', 'm1'], null, 2) + '\n')
  await writeFile(join(cwd, '.agent-teams/alpha/notes/b.md'), 'new note')
  await rm(join(cwd, '.agent-teams/archive/alpha'), { recursive: true })
  await writeFile(join(cwd, '.agent-teams/beta/team.json'), '{"other":"team changed"}') // 别的团队：不回退
  await writeFile(join(cwd, 'main.ts'), 'changed code')
  await writeFile(join(cwd, 'added.ts'), 'new file')
  await mkdir(join(home, 'storages/session_projcache/sessions'), { recursive: true })
  await writeFile(projcacheFiles(home, 'cap')[0]!, '{}')
}

test('apply：恢复到快照、建救援点、别的团队不动；再撤销回到改动后', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  const atSnap = await fingerprint(home, cwd)
  await mutate(home, cwd)
  const beta = await readFile(join(cwd, '.agent-teams/beta/team.json'), 'utf8')
  const mutated = await fingerprint(home, cwd)

  await register(home, cwd, 'snapshot', 's1')
  const out = await runApply({ home, cwd, guard })
  assert.equal(out.status, 'applied', out.message)
  const after = await fingerprint(home, cwd)
  assert.deepEqual(after.ws, atSnap.ws)
  assert.deepEqual(after.sessions, atSnap.sessions)
  // .agent-teams：本队回到快照；beta 保持改动后的样子
  assert.equal(await readFile(join(cwd, '.agent-teams/beta/team.json'), 'utf8'), beta)
  assert.deepEqual(after.teams.filter((p) => !p.startsWith('beta/')), atSnap.teams.filter((p) => !p.startsWith('beta/')))
  assert.deepEqual(JSON.parse(await readFile(join(cwd, '.agent-teams/retired-members.json'), 'utf8')), ['m0'])
  await assert.rejects(readFile(projcacheFiles(home, 'cap')[0]!))
  const pending = (await readPending(newsnapRoot(home, cwd)))!
  assert.equal(pending.status, 'applied')
  assert.ok(pending.steps.every((s) => s.done))
  const rescue = (await readManifest(layout(newsnapRoot(home, cwd)).rescueDir(out.rescueId)))!
  assert.equal(rescue.restoreOf, 'snapshot/s1')
  assert.deepEqual(rescue.sessions.map((s) => s.id).sort(), ['cap', 'm1', 'm2', 'sub1', 'sub2', 'sub3'])

  // 撤销 = 恢复到救援点
  await register(home, cwd, 'rescue', out.rescueId)
  const undo = await runApply({ home, cwd, guard })
  assert.equal(undo.status, 'applied', undo.message)
  const back = await fingerprint(home, cwd)
  assert.deepEqual(back.sessions, mutated.sessions)
  assert.deepEqual(back.ws, mutated.ws)
  assert.deepEqual(back.teams, mutated.teams.filter((p) => true))
  assert.deepEqual(JSON.parse(await readFile(join(cwd, '.agent-teams/retired-members.json'), 'utf8')), ['m0', 'm1'])
})

test('第 5 步失败：自动用救援点回滚，状态 failed，内容等于改动后', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  await mutate(home, cwd)
  const mutated = await fingerprint(home, cwd)
  await register(home, cwd, 'snapshot', 's1')
  const out = await runApply({
    home, cwd, guard,
    faultBefore: (step, phase) => {
      if (step === 'workspace' && phase === 'apply') throw new Error('disk full')
    },
  })
  assert.equal(out.status, 'failed')
  assert.match(out.message, /disk full/)
  const now = await fingerprint(home, cwd)
  assert.deepEqual(now.sessions, mutated.sessions)
  assert.deepEqual(now.ws, mutated.ws)
  assert.deepEqual(now.teams, mutated.teams)
  assert.equal((await readPending(newsnapRoot(home, cwd)))?.status, 'failed')
  await assert.rejects(runApply({ home, cwd, guard }), ApplyRefused) // 已 failed 的登记不能再跑
})

test('回滚也失败：状态留在 applying；再跑一次续做（复用救援点）并成功', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  const atSnap = await fingerprint(home, cwd)
  await mutate(home, cwd)
  await register(home, cwd, 'snapshot', 's1')
  await assert.rejects(runApply({
    home, cwd, guard,
    faultBefore: (step) => {
      if (step === 'teams') throw new Error('boom')
    },
  }), /rollback also failed/)
  const stuck = (await readPending(newsnapRoot(home, cwd)))!
  assert.equal(stuck.status, 'applying')
  assert.ok(stuck.rescueId)
  const rescues = await readdir(layout(newsnapRoot(home, cwd)).rescue)
  const out = await runApply({ home, cwd, guard })
  assert.equal(out.status, 'applied')
  assert.equal(out.rescueId, stuck.rescueId)
  assert.deepEqual(await readdir(layout(newsnapRoot(home, cwd)).rescue), rescues) // 没有再建救援点
  const after = await fingerprint(home, cwd)
  assert.deepEqual(after.sessions, atSnap.sessions)
  assert.deepEqual(after.ws, atSnap.ws)
})

test('会话写锁拿不到：零改动，pending 不变', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  await mutate(home, cwd)
  const mutated = await fingerprint(home, cwd)
  await register(home, cwd, 'snapshot', 's1')
  const busy: SessionGuard = {
    kind: 'busy',
    acquire: async (dir) => {
      if (dir.endsWith('m2')) throw new SessionBusy('open')
      return async () => undefined
    },
  }
  await assert.rejects(runApply({ home, cwd, guard: busy }), SessionBusy)
  assert.deepEqual(await fingerprint(home, cwd), mutated)
  assert.equal((await readPending(newsnapRoot(home, cwd)))?.status, 'registered')
  await assert.rejects(readdir(layout(newsnapRoot(home, cwd)).rescue))
  // 锁已释放：之后能正常跑
  assert.equal((await runApply({ home, cwd, guard })).status, 'applied')
})
