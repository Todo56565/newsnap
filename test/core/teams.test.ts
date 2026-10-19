import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  busyTasks, findTeamOfSession, listTeamIds, readRetiredMemberIds, readTeam, summarizeTeam, teamSessionIds, UnsupportedTeamState,
} from '../../src/core/teams.ts'

const team = {
  name: 'Alpha', id: 'alpha', captainSessionId: 'cap', createdAt: 1700000000000, taskSeq: 2,
  members: [{ id: 'm1', name: 'a' }, { id: '', name: 'not-spawned' }],
  tasks: [{ id: 't1', status: 'completed', dependencies: [] }, { id: 't2', status: 'in_progress', dependencies: [] }],
  extra: 'ignored',
}

async function ws(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ns-teams-'))
  await mkdir(join(cwd, '.agent-teams/alpha'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/archive/old'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/.context'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/no-team-file'), { recursive: true })
  await writeFile(join(cwd, '.agent-teams/alpha/team.json'), '\ufeff' + JSON.stringify(team))
  await writeFile(join(cwd, '.agent-teams/archive/old/team.json'), JSON.stringify({ ...team, id: 'old' }))
  return cwd
}

test('summarizeTeam 取少数字段，忽略其他', () => {
  const s = summarizeTeam(team, 'alpha')
  assert.deepEqual(s.memberSessionIds, ['m1'])
  assert.deepEqual(busyTasks(s), ['t2'])
  assert.deepEqual(teamSessionIds(s), ['cap', 'm1'])
})

test('summarizeTeam 字段对不上就拒绝', () => {
  assert.throws(() => summarizeTeam({ ...team, id: 'beta' }, 'alpha'), UnsupportedTeamState)
  assert.throws(() => summarizeTeam({ ...team, captainSessionId: '' }, 'alpha'), UnsupportedTeamState)
  assert.throws(() => summarizeTeam({ ...team, tasks: [{ id: 't', status: 'paused' }] }, 'alpha'), UnsupportedTeamState)
  assert.throws(() => summarizeTeam([], 'alpha'), UnsupportedTeamState)
})

test('listTeamIds 只列活动团队；readTeam 去 BOM；findTeamOfSession', async () => {
  const cwd = await ws()
  assert.deepEqual(await listTeamIds(cwd), ['alpha'])
  assert.equal((await readTeam(cwd, 'alpha'))?.name, 'Alpha')
  assert.equal(await readTeam(cwd, 'nope'), undefined)
  assert.equal((await findTeamOfSession(cwd, 'm1'))?.id, 'alpha')
  assert.equal((await findTeamOfSession(cwd, 'cap'))?.id, 'alpha')
  assert.equal(await findTeamOfSession(cwd, 'stranger'), undefined)
  assert.deepEqual(await listTeamIds(join(cwd, 'none')), [])
})

test('readRetiredMemberIds', async () => {
  const cwd = await ws()
  assert.equal((await readRetiredMemberIds(cwd)).size, 0)
  await writeFile(join(cwd, '.agent-teams/retired-members.json'), '["m9"]\n')
  assert.deepEqual([...(await readRetiredMemberIds(cwd))], ['m9'])
  await writeFile(join(cwd, '.agent-teams/retired-members.json'), '[1]')
  await assert.rejects(readRetiredMemberIds(cwd), UnsupportedTeamState)
})
