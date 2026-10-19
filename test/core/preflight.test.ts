import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskBlockers, inflightMail, mergeRunning } from '../../src/core/preflight.ts'
import { summarizeTeam } from '../../src/core/teams.ts'

async function ws() {
  const cwd = await mkdtemp(join(tmpdir(), 'ns-pre-'))
  await mkdir(join(cwd, '.agent-teams/alpha/inbox'), { recursive: true })
  return cwd
}

const team = (status: string) => summarizeTeam({
  id: 'alpha', name: 'A', createdAt: 1, captainSessionId: 'c', members: [], tasks: [{ id: 't1', status }],
}, 'alpha')

test('空闲团队没有阻碍', async () => {
  const cwd = await ws()
  assert.deepEqual(await diskBlockers(cwd, team('completed')), [])
})

test('进行中任务、投递中的信、合并锁', async () => {
  const cwd = await ws()
  await writeFile(join(cwd, '.agent-teams/alpha/inbox/captain.jsonl'), [
    JSON.stringify({ id: 'a', deliveredAt: 1 }),
    JSON.stringify({ id: 'b' }), // 排队未投递：不算
    JSON.stringify({ id: 'c', deliveryClaimedAt: 5 }), // 投递中
    'not json',
    '',
  ].join('\n'))
  assert.deepEqual(await inflightMail(cwd, 'alpha'), ['captain.jsonl:c'])
  const lock = join(cwd, '.agent-teams/.context/shared/locks/merge.lock')
  await mkdir(join(lock, '..'), { recursive: true })
  await writeFile(lock, '{}')
  assert.equal(await mergeRunning(cwd), true)
  const kinds = (await diskBlockers(cwd, team('in_progress'))).map((b) => b.kind)
  assert.deepEqual(kinds, ['task-in-progress', 'mail-in-flight', 'merge-running'])
  await utimes(lock, 1000, 1000) // 过期锁不算
  assert.equal(await mergeRunning(cwd), false)
  assert.equal(await mergeRunning(join(cwd, 'none')), false)
})
