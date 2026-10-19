/**
 * agent-teams 状态的只读视图（总设计方向约束：只读、不打补丁、不跟版适配）。
 * 只解析 team.json 的少数字段；字段对不上就抛 UnsupportedTeamState，调用方拒绝拍照 / 恢复。
 * 依据 dsh-agent-teams v0.1.25 `src/types.ts` TeamState / TeamMember / TeamTask、`src/state.ts`。
 * @module newsnap/core/teams
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentTeamsRoot } from './paths.ts'

export class UnsupportedTeamState extends Error {
  override name = 'UnsupportedTeamState'
}

export const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 拍照前置条件里视为「进行中」的状态（总设计 §3）。 */
export const BUSY_TASK_STATUSES: readonly TaskStatus[] = ['claimed', 'in_progress']

export interface TeamSummary {
  readonly id: string
  readonly name: string
  /** 团队代：同 id 归档后重建会得到新的 createdAt。 */
  readonly createdAt: number
  readonly captainSessionId: string
  /** 成员会话 id；尚未 spawn 的成员 id 为空，已滤掉。 */
  readonly memberSessionIds: readonly string[]
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly status: TaskStatus }>
}

const RETIRED_MEMBERS_FILE = 'retired-members.json'
const ARCHIVE_DIR = 'archive'
const TEAM_FILE = 'team.json'

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(teamId: string, what: string): never {
  throw new UnsupportedTeamState(`team "${teamId}": ${what}`)
}

/** 从已解析的 team.json 取摘要；任何必需字段缺失或类型不符都抛 UnsupportedTeamState。 */
export function summarizeTeam(value: unknown, teamId: string): TeamSummary {
  if (!isRecord(value)) fail(teamId, 'team.json is not an object')
  const { id, name, createdAt, captainSessionId, members, tasks } = value
  if (typeof id !== 'string' || id !== teamId) fail(teamId, 'id mismatch')
  if (typeof name !== 'string') fail(teamId, 'name missing')
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) fail(teamId, 'createdAt missing')
  if (typeof captainSessionId !== 'string' || captainSessionId === '') fail(teamId, 'captainSessionId missing')
  if (!Array.isArray(members)) fail(teamId, 'members is not an array')
  if (!Array.isArray(tasks)) fail(teamId, 'tasks is not an array')
  const memberSessionIds: string[] = []
  for (const member of members) {
    if (!isRecord(member) || typeof member.id !== 'string') fail(teamId, 'member without id')
    if (member.id !== '') memberSessionIds.push(member.id)
  }
  const taskList: Array<{ id: string; status: TaskStatus }> = []
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== 'string') fail(teamId, 'task without id')
    const status = task.status
    if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) {
      fail(teamId, `task ${task.id} has unknown status ${JSON.stringify(status)}`)
    }
    taskList.push({ id: task.id, status: status as TaskStatus })
  }
  return { id, name, createdAt, captainSessionId, memberSessionIds, tasks: taskList }
}

/** 读一个活动团队；不存在返回 undefined。 */
export async function readTeam(cwd: string, teamId: string): Promise<TeamSummary | undefined> {
  let raw: string
  try {
    raw = await readFile(join(agentTeamsRoot(cwd), teamId, TEAM_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch {
    fail(teamId, 'team.json is not valid JSON')
  }
  return summarizeTeam(parsed, teamId)
}

/** 列出活动团队 id（`.agent-teams/<id>/team.json` 存在者；不含 archive 与以 `.` 开头的目录如 `.context`）。 */
export async function listTeamIds(cwd: string): Promise<string[]> {
  const root = agentTeamsRoot(cwd)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ARCHIVE_DIR || entry.name.startsWith('.')) continue
    try {
      await readFile(join(root, entry.name, TEAM_FILE))
      ids.push(entry.name)
    } catch {
      // 没有 team.json 的目录不是团队
    }
  }
  return ids.sort()
}

/** 某会话所属的活动团队（作为队长或成员）；找不到返回 undefined。坏的 team.json 跳过。 */
export async function findTeamOfSession(cwd: string, sessionId: string): Promise<TeamSummary | undefined> {
  for (const id of await listTeamIds(cwd)) {
    let team: TeamSummary | undefined
    try {
      team = await readTeam(cwd, id)
    } catch (error) {
      if (error instanceof UnsupportedTeamState) continue
      throw error
    }
    if (team === undefined) continue
    if (team.captainSessionId === sessionId || team.memberSessionIds.includes(sessionId)) return team
  }
  return undefined
}

export function busyTasks(team: TeamSummary): string[] {
  return team.tasks.filter((t) => BUSY_TASK_STATUSES.includes(t.status)).map((t) => t.id)
}

/** 团队全部会话 id（队长在前）。 */
export function teamSessionIds(team: TeamSummary): string[] {
  return [team.captainSessionId, ...team.memberSessionIds.filter((id) => id !== team.captainSessionId)]
}

/** 读被移除成员名单；不存在为空集；格式不符抛 UnsupportedTeamState。 */
export async function readRetiredMemberIds(cwd: string): Promise<Set<string>> {
  let raw: string
  try {
    raw = await readFile(join(agentTeamsRoot(cwd), RETIRED_MEMBERS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  const parsed: unknown = JSON.parse(stripBom(raw))
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string' || v === '')) {
    throw new UnsupportedTeamState('retired-members.json is not a string array')
  }
  return new Set(parsed as string[])
}

export const AGENT_TEAMS_LAYOUT = { RETIRED_MEMBERS_FILE, ARCHIVE_DIR, TEAM_FILE, CONTEXT_DIR: '.context' } as const
