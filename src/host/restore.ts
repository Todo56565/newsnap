/**
 * 运行中发起恢复（实现设计 §4.1–4.2）：前置检查 → 展示影响面 → 登记 → 拉起辅助进程 → 回应后退出 DSH。
 * 退出与拉起由调用方注入（appExit、spawn），便于单测。
 * @module newsnap/host/restore
 */

import { readdir } from 'node:fs/promises'
import { ACTIVE_STATUSES, registerRestore } from '../core/apply.ts'
import { resolveTeamSessions } from '../core/capture.ts'
import { acquireLock } from '../core/lock.ts'
import { layout, readManifest, readPending, writePending, type PendingRestore, type RelaunchSpec, type SnapManifest } from '../core/manifest.ts'
import { newsnapRoot } from '../core/paths.ts'
import { SUPPORTED_RELAUNCH_PROFILES } from '../core/relaunch.ts'
import { listTeamIds } from '../core/teams.ts'
import { blockers, SnapshotBlocked, teamFor, type HostRuntime } from './capture.ts'

export class RestoreUnsupported extends Error {
  override name = 'RestoreUnsupported'
}

export class RestoreNotFound extends Error {
  override name = 'RestoreNotFound'
}

export interface RestoreContext {
  readonly home: string
  readonly cwd: string
  readonly sessionId: string
  readonly profile: string
  /** 宿主的 appExit；没有就不能自动重启。 */
  readonly appExit: ((code: number) => unknown) | undefined
  readonly relaunch: Omit<RelaunchSpec, 'profile' | 'sessionId'>
  /** 拉起辅助进程，返回其 pid。 */
  readonly spawnHelper: (mode: 'apply' | 'rollback') => number | undefined
  /** 在回应发出之后调用（index.ts 用 setImmediate）。 */
  readonly schedule: (fn: () => void) => void
}

export interface Impact {
  readonly target: SnapManifest
  /** 快照之后新增、恢复时会被移进救援点的本队会话。 */
  readonly removedSessions: string[]
  /** 现在同一工作区里的其他活动团队：工作区整体回退会影响它们。 */
  readonly otherTeams: string[]
}

/** 桌面端：宿主退出后 Electron 弹「启动失败」对话框，由用户点「重启」（不自动重拉，实现设计 §4.6、§4.9）。 */
export const APPLY_ONLY_PROFILES = ['desktop'] as const

export function relaunchesItself(profile: string): boolean {
  return (SUPPORTED_RELAUNCH_PROFILES as readonly string[]).includes(profile)
}

function relaunchFor(ctx: RestoreContext): RelaunchSpec | null {
  if (!relaunchesItself(ctx.profile)) return null
  return { ...ctx.relaunch, profile: ctx.profile, ...(ctx.profile === 'headless' && { sessionId: ctx.sessionId }) }
}

function checkProfile(ctx: RestoreContext): void {
  if (!relaunchesItself(ctx.profile) && !(APPLY_ONLY_PROFILES as readonly string[]).includes(ctx.profile)) {
    throw new RestoreUnsupported(`profile "${ctx.profile}" cannot restart itself; quit DSH and run \`newsnap apply\` from a terminal`)
  }
  if (typeof ctx.appExit !== 'function') throw new RestoreUnsupported('this host does not expose appExit; quit DSH and run `newsnap apply` from a terminal')
}

async function targetManifest(ctx: RestoreContext, target: PendingRestore['target']): Promise<SnapManifest> {
  const L = layout(newsnapRoot(ctx.home, ctx.cwd))
  const dir = target.kind === 'snapshot' ? L.snapDir(target.id) : L.rescueDir(target.id)
  const m = await readManifest(dir).catch(() => undefined)
  if (m === undefined) throw new RestoreNotFound(`${target.kind} ${target.id} not found`)
  return m
}

/** 前置检查 + 影响面。不改任何东西。 */
export async function previewRestore(host: HostRuntime, ctx: RestoreContext, target: PendingRestore['target']): Promise<Impact> {
  checkProfile(ctx)
  const m = await targetManifest(ctx, target)
  const team = await teamFor(ctx.cwd, ctx.sessionId)
  if (m.team.id !== team.id) throw new RestoreNotFound(`${target.kind} ${target.id} belongs to team ${m.team.id}, not ${team.id}`)
  const ids = (await resolveTeamSessions(ctx.home, ctx.cwd, team)).map((s) => s.id)
  const found = await blockers(host, ctx, team, ids.filter((id) => id !== ctx.sessionId))
  if (found.length > 0) throw new SnapshotBlocked(found)
  const inTarget = new Set(m.sessions.map((s) => s.id))
  const otherTeams = (await listTeamIds(ctx.cwd)).filter((id) => id !== team.id)
  return { target: m, removedSessions: ids.filter((id) => !inTarget.has(id)), otherTeams }
}

/**
 * 登记并启动恢复：写 pending（status exiting）→ 拉起辅助进程 → 安排 appExit(0)。
 * 返回后调用方立即把回应发出去；退出在 schedule 里发生。
 */
export async function startRestore(host: HostRuntime, ctx: RestoreContext, target: PendingRestore['target']): Promise<Impact> {
  const impact = await previewRestore(host, ctx, target)
  const root = newsnapRoot(ctx.home, ctx.cwd)
  const release = await acquireLock(layout(root).lock, 'register')
  try {
    const pending = await registerRestore({ home: ctx.home, cwd: ctx.cwd, target, relaunch: relaunchFor(ctx) })
    await writePending(root, { ...pending, status: 'exiting' })
  } finally {
    await release()
  }
  launch(ctx, 'apply')
  return impact
}

/** 续做或回滚一次卡在 applying 的恢复（同样要退出 DSH 交给辅助进程）。 */
export async function continueRestore(ctx: RestoreContext, mode: 'apply' | 'rollback'): Promise<PendingRestore> {
  checkProfile(ctx)
  const root = newsnapRoot(ctx.home, ctx.cwd)
  const pending = await readPending(root)
  if (pending === undefined || !ACTIVE_STATUSES.includes(pending.status)) throw new RestoreNotFound('no unfinished restore here')
  await writePending(root, { ...pending, relaunch: relaunchFor(ctx) })
  launch(ctx, mode)
  return pending
}

function launch(ctx: RestoreContext, mode: 'apply' | 'rollback'): void {
  ctx.spawnHelper(mode)
  const exit = ctx.appExit as (code: number) => unknown
  ctx.schedule(() => {
    void exit(0)
  })
}

/** 列出 newsnap 下所有工作区根（启动对账、残骸清理用：不只看进程 cwd）。 */
export async function allRoots(home: string): Promise<string[]> {
  const base = `${home}/newsnap`
  try {
    return (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => `${base}/${d.name}`)
  } catch {
    return []
  }
}
