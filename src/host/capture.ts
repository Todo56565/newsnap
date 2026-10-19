/**
 * 拍照的宿主侧流程（总设计 §3）：找团队 → 前置检查 → 冻结 → 落盘 → 复查 → 拍照 → 解冻。
 * 通过 HostRuntime 接口访问 DSH，便于单测；index.ts 把 cordis Context 适配成它。
 * @module newsnap/host/capture
 */

import { captureSnapshot, resolveTeamSessions } from '../core/capture.ts'
import { acquireLock } from '../core/lock.ts'
import { layout, readPending, type SnapManifest } from '../core/manifest.ts'
import { newsnapRoot } from '../core/paths.ts'
import { diskBlockers, type Blocker } from '../core/preflight.ts'
import { findTeamOfSession, type TeamSummary } from '../core/teams.ts'

export interface HostRuntime {
  /** 会话已加载时返回其状态；未加载视为空闲（返回 undefined）。 */
  agentStatus(sessionId: string): 'idle' | 'running' | undefined
  /** 把已加载会话缓冲中的事件刷到磁盘；未加载的会话什么也不做。 */
  flush(sessionId: string): Promise<void>
  /** 冻结这些会话（pre-step 一律 reject），返回解冻函数。 */
  freeze(sessionIds: readonly string[]): () => void
}

export class NotATeamSession extends Error {
  override name = 'NotATeamSession'
}

export class SnapshotBlocked extends Error {
  override name = 'SnapshotBlocked'
  readonly blockers: readonly Blocker[]
  constructor(blockers: readonly Blocker[]) {
    super(`cannot snapshot now: ${blockers.map((b) => `${b.kind}(${b.detail})`).join(', ')}`)
    this.blockers = blockers
  }
}

export interface TakeSnapshotParams {
  readonly home: string
  readonly cwd: string
  readonly sessionId: string
  readonly note?: string
  readonly versions?: Readonly<Record<string, string>>
  readonly maxFileBytes?: number
}

export async function teamFor(cwd: string, sessionId: string): Promise<TeamSummary> {
  const team = await findTeamOfSession(cwd, sessionId)
  if (team === undefined) throw new NotATeamSession('this session does not belong to an active agent-teams team')
  return team
}

async function blockers(host: HostRuntime, params: TakeSnapshotParams, team: TeamSummary, ids: readonly string[]): Promise<Blocker[]> {
  const out = await diskBlockers(params.cwd, team)
  for (const id of ids) if (host.agentStatus(id) === 'running') out.push({ kind: 'session-busy', detail: id })
  if ((await readPending(newsnapRoot(params.home, params.cwd))) !== undefined) {
    out.push({ kind: 'restore-pending', detail: 'a restore is registered' })
  }
  return out
}

/**
 * 拍一份快照。不满足前置条件时抛 SnapshotBlocked（拒绝而不是等待，总设计 §3）。
 * 冻结后再查一次，堵住「检查通过到冻结生效之间有人开工」的窗口。
 */
export async function takeSnapshot(host: HostRuntime, params: TakeSnapshotParams): Promise<SnapManifest> {
  const team = await teamFor(params.cwd, params.sessionId)
  const ids = (await resolveTeamSessions(params.home, params.cwd, team)).map((s) => s.id)
  const first = await blockers(host, params, team, ids)
  if (first.length > 0) throw new SnapshotBlocked(first)

  const release = await acquireLock(layout(newsnapRoot(params.home, params.cwd)).lock, 'snapshot')
  const unfreeze = host.freeze(ids)
  try {
    // 冻结后重读团队：检查到冻结之间 team.json 可能变了
    const frozenTeam = await teamFor(params.cwd, params.sessionId)
    const again = await blockers(host, params, frozenTeam, ids)
    if (again.length > 0) throw new SnapshotBlocked(again)
    for (const id of ids) await host.flush(id)
    return await captureSnapshot({
      home: params.home,
      cwd: params.cwd,
      team: frozenTeam,
      ...(params.note !== undefined && { note: params.note }),
      ...(params.versions !== undefined && { versions: params.versions }),
      ...(params.maxFileBytes !== undefined && { maxFileBytes: params.maxFileBytes }),
    })
  } finally {
    unfreeze()
    await release()
  }
}
