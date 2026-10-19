import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NotATeamSession, SnapshotBlocked, takeSnapshot, type HostRuntime } from '../../src/host/capture.ts'
import { formatBlocked } from '../../src/host/format.ts'
import { writePending } from '../../src/core/manifest.ts'
import { newsnapRoot } from '../../src/core/paths.ts'
import { world } from '../helpers/world.ts'

function fakeHost(running: string[] = []) {
  const log: string[] = []
  const frozen = new Set<string>()
  const host: HostRuntime = {
    agentStatus: (id) => (running.includes(id) ? 'running' : id === 'cap' ? 'idle' : undefined),
    async flush(id) {
      log.push(`flush:${id}:${frozen.has(id) ? 'frozen' : 'open'}`)
    },
    freeze(ids) {
      ids.forEach((id) => frozen.add(id))
      log.push(`freeze:${ids.join(',')}`)
      return () => {
        ids.forEach((id) => frozen.delete(id))
        log.push('unfreeze')
      }
    },
  }
  return { host, log, frozen }
}

test('空闲团队：冻结 → 刷盘 → 拍照 → 解冻', async () => {
  const { home, cwd } = await world()
  const { host, log, frozen } = fakeHost()
  const m = await takeSnapshot(host, { home, cwd, sessionId: 'm1', note: 'n' })
  assert.equal(m.sessions.length, 4)
  assert.deepEqual(log, [
    'freeze:cap,m1,sub1,sub2', 'flush:cap:frozen', 'flush:m1:frozen', 'flush:sub1:frozen', 'flush:sub2:frozen', 'unfreeze',
  ])
  assert.equal(frozen.size, 0)
})

test('有会话在跑、任务进行中：拒绝，不冻结', async () => {
  const { home, cwd } = await world()
  const { host, log } = fakeHost(['sub2'])
  await writeFile(join(cwd, '.agent-teams/alpha/team.json'), JSON.stringify({
    name: 'Alpha', id: 'alpha', captainSessionId: 'cap', createdAt: 7, members: [{ id: 'm1', name: 'a' }],
    tasks: [{ id: 't1', status: 'claimed' }],
  }))
  const err = await takeSnapshot(host, { home, cwd, sessionId: 'cap' }).catch((e: unknown) => e)
  assert.ok(err instanceof SnapshotBlocked)
  assert.deepEqual(err.blockers.map((b) => b.kind), ['task-in-progress', 'session-busy'])
  assert.equal(formatBlocked(err.blockers), '现在不能拍快照：有进行中的任务（t1）；有会话正在运行（sub2）。等团队空闲后再试。')
  assert.deepEqual(log, [])
})

test('有已登记的恢复：拒绝；非团队会话：NotATeamSession', async () => {
  const { home, cwd } = await world()
  await writePending(newsnapRoot(home, cwd), {
    schema: 1, target: { kind: 'snapshot', id: 'x' }, status: 'registered', steps: [], relaunch: null, createdAt: 1,
  })
  await assert.rejects(takeSnapshot(fakeHost().host, { home, cwd, sessionId: 'cap' }), SnapshotBlocked)
  await assert.rejects(takeSnapshot(fakeHost().host, { home, cwd, sessionId: 'stranger' }), NotATeamSession)
})

test('冻结后复查发现有人开工：拒绝并解冻', async () => {
  const { home, cwd } = await world()
  const running: string[] = []
  const { host, log, frozen } = fakeHost(running)
  const orig = host.freeze
  host.freeze = (ids) => {
    running.push('m1') // 检查与冻结之间 m1 开始了一步
    return orig(ids)
  }
  await assert.rejects(takeSnapshot(host, { home, cwd, sessionId: 'cap' }), SnapshotBlocked)
  assert.equal(log.at(-1), 'unfreeze')
  assert.equal(frozen.size, 0)
})
