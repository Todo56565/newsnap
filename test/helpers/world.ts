import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { sessionDir } from '../../src/core/paths.ts'
import { readTeam } from '../../src/core/teams.ts'

export function header(id: string, cwd: string, parent?: string): string {
  return JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd, ...(parent && { parentSession: parent }), isSeeded: false, delegationDepth: 0 }) + '\n'
}

export async function writeSession(home: string, cwd: string, id: string, parent?: string, zstd = true): Promise<string> {
  const dir = sessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  const body = header(id, cwd, parent) + '{"type":"event","seq":1}\n'
  const file = zstd ? join(dir, 'session.v4.jsonl.zstd') : join(dir, 'session.v4.jsonl')
  await writeFile(file, zstd ? zstdCompressSync(Buffer.from(body)) : body)
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'old generation')
  await writeFile(join(dir, 'session.lock'), '')
  return file
}

export async function world() {
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
  await writeFile(join(cwd, '.agent-teams/retired-members.json'), JSON.stringify(['m0'], null, 2) + '\n')
  await writeFile(join(cwd, 'main.ts'), 'code')
  await writeSession(home, cwd, 'cap')
  await writeSession(home, cwd, 'm1', undefined, false)
  await writeSession(home, cwd, 'sub1', 'm1')
  await writeSession(home, cwd, 'sub2', 'sub1')
  await writeSession(home, cwd, 'bcap')
  await writeSession(home, cwd, 'stranger', 'bcap')
  return { home, cwd, team: (await readTeam(cwd, 'alpha'))! }
}

