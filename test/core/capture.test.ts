import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { agentTeamsFilter, captureSnapshot, resolveTeamSessions } from '../../src/core/capture.ts'
import { readManifest } from '../../src/core/manifest.ts'
import { newsnapRoot, sessionDir } from '../../src/core/paths.ts'
import { readHeader } from '../../src/core/sessions.ts'
import { git } from '../../src/core/shadow-git.ts'
import { readTeam } from '../../src/core/teams.ts'

function header(id: string, cwd: string, parent?: string): string {
  return JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd, ...(parent && { parentSession: parent }), isSeeded: false, delegationDepth: 0 }) + '\n'
}

async function writeSession(home: string, cwd: string, id: string, parent?: string, zstd = true): Promise<string> {
  const dir = sessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  const body = header(id, cwd, parent) + '{"type":"event","seq":1}\n'
  const file = zstd ? join(dir, 'session.v4.jsonl.zstd') : join(dir, 'session.v4.jsonl')
  await writeFile(file, zstd ? zstdCompressSync(Buffer.from(body)) : body)
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'old generation')
  await writeFile(join(dir, 'session.lock'), '')
  return file
}

async function world() {
  const base = await mkdtemp(join(tmpdir(), 'ns-cap-'))
  const home = join(base, 'home')
  const cwd = join(base, 'ws')
  await mkdir(join(cwd, '.agent-teams/alpha/notes'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/beta'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/archive/alpha'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/archive/gamma'), { recursive: true })
  await mkdir(join(cwd, '.agent-teams/.context/state'), { recursive: true })
  const team = {
    name: 'Alpha', id: 'alpha', captainSessionId: 'cap', createdAt: 7, taskSeq: 1,
    members: [{ id: 'm1', name: 'a' }], tasks: [{ id: 't1', status: 'completed', dependencies: [] }],
  }
  await writeFile(join(cwd, '.agent-teams/alpha/team.json'), JSON.stringify(team))
  await writeFile(join(cwd, '.agent-teams/alpha/notes/a.md'), 'note')
  await writeFile(join(cwd, '.agent-teams/beta/team.json'), JSON.stringify({ ...team, id: 'beta', captainSessionId: 'bcap', members: [] }))
  await writeFile(join(cwd, '.agent-teams/archive/alpha/team.json'), '{}')
  await writeFile(join(cwd, '.agent-teams/archive/gamma/team.json'), '{}')
  await writeFile(join(cwd, '.agent-teams/.context/state/x.json'), '{}')
  await writeFile(join(cwd, '.agent-teams/retired-members.json'), '["m0"]')
  await writeFile(join(cwd, 'main.ts'), 'code')
  await writeSession(home, cwd, 'cap')
  await writeSession(home, cwd, 'm1', undefined, false)
  await writeSession(home, cwd, 'sub1', 'm1')
  await writeSession(home, cwd, 'sub2', 'sub1')
  await writeSession(home, cwd, 'bcap')
  await writeSession(home, cwd, 'stranger', 'bcap')
  return { home, cwd, team: (await readTeam(cwd, 'alpha'))! }
}

test('readHeader 读压缩与明文代', async () => {
  const { home, cwd } = await world()
  assert.deepEqual(await readHeader(join(sessionDir(home, cwd, 'sub2'), 'session.v4.jsonl.zstd')), { id: 'sub2', cwd, parentSession: 'sub1' })
  assert.equal((await readHeader(join(sessionDir(home, cwd, 'm1'), 'session.v4.jsonl')))?.id, 'm1')
  assert.equal(await readHeader(join(sessionDir(home, cwd, 'm1'), 'session.v3.jsonl.zstd')), undefined)
})

test('agentTeamsFilter 只留本队、本队归档、.context', () => {
  const ex = agentTeamsFilter('alpha')
  assert.equal(ex('alpha/team.json'), false)
  assert.equal(ex('.context/state/x.json'), false)
  assert.equal(ex('archive'), false)
  assert.equal(ex('archive/alpha'), false)
  assert.equal(ex('archive/gamma'), true)
  assert.equal(ex('beta'), true)
  assert.equal(ex('retired-members.json'), true)
})

test('resolveTeamSessions：队长、成员、递归后代，不含别队', async () => {
  const { home, cwd, team } = await world()
  const got = await resolveTeamSessions(home, cwd, team)
  assert.deepEqual(got.map((s) => `${s.role}:${s.id}`), ['captain:cap', 'member:m1', 'descendant:sub1', 'descendant:sub2'])
})

test('captureSnapshot 写全、manifest 最后写、可读回', async () => {
  const { home, cwd, team } = await world()
  const m = await captureSnapshot({ home, cwd, team, note: 'before refactor', id: 'snap1', now: 100, versions: { newsnap: 'dev' } })
  const dir = join(newsnapRoot(home, cwd), 'snaps/snap1')
  assert.deepEqual(await readManifest(dir), m)
  assert.equal(m.sessions.length, 4)
  assert.equal(m.sessions[0]?.generation, 'session.v4.jsonl.zstd')
  await access(join(dir, 'sessions/m1/session.v4.jsonl'))
  assert.deepEqual(m.agentTeams.filter((e) => e.type === 'file').map((e) => e.path), [
    '.context/state/x.json', 'alpha/notes/a.md', 'alpha/team.json', 'archive/alpha/team.json',
  ])
  assert.equal(await readFile(join(dir, 'agent-teams/alpha/notes/a.md'), 'utf8'), 'note')
  assert.deepEqual(m.otherTeams, ['beta'])
  assert.deepEqual(m.retiredTeamMembers, [])
  const files = (await git(['--git-dir', join(newsnapRoot(home, cwd), 'repo.git'), 'ls-tree', '-r', '--name-only', m.workspace.commit])).trim()
  assert.equal(files, 'main.ts') // .agent-teams 不进影子仓库
  assert.equal(m.note, 'before refactor')
})

test('同 id 再拍拒绝，不动已有快照', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 'dup' })
  await assert.rejects(captureSnapshot({ home, cwd, team, id: 'dup' }), /EEXIST/)
  assert.ok(await readManifest(join(newsnapRoot(home, cwd), 'snaps/dup')))
})

test('成员会话缺失：失败并清掉残骸与 ref', async () => {
  const { home, cwd } = await world()
  await writeFile(join(cwd, '.agent-teams/alpha/team.json'), JSON.stringify({
    name: 'Alpha', id: 'alpha', captainSessionId: 'cap', createdAt: 7, members: [{ id: 'ghost', name: 'g' }], tasks: [],
  }))
  const team = (await readTeam(cwd, 'alpha'))!
  await assert.rejects(captureSnapshot({ home, cwd, team, id: 'bad' }), /SessionMissing|no log/)
  await assert.rejects(access(join(newsnapRoot(home, cwd), 'snaps/bad')))
})

test('救援点写到 rescue/ 并记 restoreOf', async () => {
  const { home, cwd, team } = await world()
  const m = await captureSnapshot({ home, cwd, team, kind: 'rescue', restoreOf: 'snap1', id: 'r1' })
  assert.equal(m.kind, 'rescue')
  assert.ok(await readManifest(join(newsnapRoot(home, cwd), 'rescue/r1')))
})
