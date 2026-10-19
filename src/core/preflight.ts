/**
 * 拍照前置条件中能从磁盘判断的部分（总设计 §3 第 2 步）：
 * - 无 claimed / in_progress 任务；
 * - 无投递中的信（inbox 记录有 deliveryClaimedAt、没有 deliveredAt；agent-teams v0.1.25 state.ts claimMailboxDelivery）；
 * - dsh-token-budget 不在合并中（`.context/shared/locks/merge.lock` 存在且未过期；token-budget context/lock.ts 用 'wx' 独占创建，过期 10 分钟）。
 * 「全队会话空闲」要问宿主，在 host 层判断。
 * @module newsnap/core/preflight
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { agentTeamsRoot } from './paths.ts'
import { busyTasks, type TeamSummary } from './teams.ts'

export const MERGE_LOCK_STALE_MS = 10 * 60_000

export interface Blocker {
  readonly kind: 'task-in-progress' | 'mail-in-flight' | 'merge-running' | 'session-busy' | 'restore-pending'
  readonly detail: string
}

/** 投递中的信：返回 `<inbox 文件名>:<message id>` 列表。坏行跳过（agent-teams 自己也保留坏行）。 */
export async function inflightMail(cwd: string, teamId: string): Promise<string[]> {
  const inbox = join(agentTeamsRoot(cwd), teamId, 'inbox')
  let files: string[]
  try {
    files = await readdir(inbox)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: string[] = []
  for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
    const raw = await readFile(join(inbox, file), 'utf8')
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const m = JSON.parse(line.replace(/^\ufeff/, '')) as Record<string, unknown>
        if (m.deliveryClaimedAt !== undefined && m.deliveredAt === undefined) out.push(`${file}:${String(m.id)}`)
      } catch {
        // 坏行
      }
    }
  }
  return out
}

/** merge.lock 是否被有效持有。 */
export async function mergeRunning(cwd: string, now: number = Date.now()): Promise<boolean> {
  try {
    const st = await stat(join(agentTeamsRoot(cwd), '.context', 'shared', 'locks', 'merge.lock'))
    return now - st.mtimeMs < MERGE_LOCK_STALE_MS
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function diskBlockers(cwd: string, team: TeamSummary, now: number = Date.now()): Promise<Blocker[]> {
  const blockers: Blocker[] = []
  for (const id of busyTasks(team)) blockers.push({ kind: 'task-in-progress', detail: id })
  for (const m of await inflightMail(cwd, team.id)) blockers.push({ kind: 'mail-in-flight', detail: m })
  if (await mergeRunning(cwd, now)) blockers.push({ kind: 'merge-running', detail: 'merge.lock' })
  return blockers
}
