/**
 * 还原引擎（实现设计 §3）：把一个回溯单元（会话 + `.agent-teams` 相关部分 + 工作区）恢复到快照或救援点。
 * DSH 必须已退出（第 1 步用会话写锁确认）。步骤固定、每步幂等，进度写进 pending-restore.json：
 *
 *   1 lock       newsnap 锁 + 逐个会话写锁，拿不到就中止、零改动
 *   2 rescue     当前状态做成救援点（已做过就跳过：续做时复用）
 *   3 sessions   换回目标里的代文件、删掉更高的代；目标里没有的本队会话删掉（救援点里有全量副本）
 *   4 teams      同步 `.agent-teams` 相关部分；调整 retired-members.json 里本队成员
 *   5 workspace  在会话 cwd 下按影子提交 exact 还原 + mtime
 *   6 projcache  删掉这些会话的投影缓存（派生数据，宿主冷读时重建）
 *   7 verify     会话 sha256、目录树清单、工作区树 hash 逐一比对
 *   8 release    释放锁，status = applied
 *
 * 3–7 任一失败：用救援点按同样的 3–7 回滚，status = failed；回滚也失败则 status 留在 applying，交给 doctor。
 * 续做（status 已是 applying）：跳过已完成的救援点，3–7 整体重跑（幂等）。
 * @module newsnap/core/apply
 */

import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { agentTeamsFilter, captureSnapshot } from './capture.ts'
import { readJson, sha256File, writeJsonAtomic } from './fsutil.ts'
import { acquireLock } from './lock.ts'
import { layout, readManifest, readPending, writePending, type PendingRestore, type RestoreStep, type SnapManifest } from './manifest.ts'
import { agentTeamsRoot, encodeSegment, listGenerations, newsnapRoot, parseGeneration, sessionDir } from './paths.ts'
import { restoreWorkspace, workspaceMatches, DEFAULT_MAX_FILE_BYTES } from './shadow-git.ts'
import type { SessionGuard } from './session-guard.ts'
import { AGENT_TEAMS_LAYOUT, readTeam, summarizeTeam, type TeamSummary } from './teams.ts'
import { isClean, scanTree, syncTree, verifyTree } from './tree.ts'

export const STEP_NAMES = ['lock', 'rescue', 'sessions', 'teams', 'workspace', 'projcache', 'verify', 'release'] as const
export type StepName = (typeof STEP_NAMES)[number]

export class ApplyRefused extends Error {
  override name = 'ApplyRefused'
}

export class VerifyFailed extends Error {
  override name = 'VerifyFailed'
}

export function initialSteps(): RestoreStep[] {
  return STEP_NAMES.map((name) => ({ name, done: false }))
}

export interface ApplyParams {
  readonly home: string
  /** 回溯单元的工作区（manifest.cwd）；用来定位 newsnap 目录。 */
  readonly cwd: string
  readonly guard: SessionGuard
  readonly maxFileBytes?: number
  readonly now?: () => number
  /** 测试用：在某一步开始前抛错，模拟中断或失败。 */
  readonly faultBefore?: (step: StepName, phase: 'apply' | 'rollback') => void
}

export interface ApplyOutcome {
  readonly status: 'applied' | 'failed'
  readonly rescueId: string
  readonly message: string
  readonly warnings: string[]
}

function targetDir(root: string, target: PendingRestore['target']): string {
  const L = layout(root)
  return target.kind === 'snapshot' ? L.snapDir(target.id) : L.rescueDir(target.id)
}

async function mustManifest(dir: string): Promise<SnapManifest> {
  const m = await readManifest(dir)
  if (m === undefined) throw new ApplyRefused(`no manifest in ${dir}`)
  return m
}

/** 救援点要覆盖的团队：当前 team.json（同代）为主，并补上目标里有、现在没有的会话。 */
async function rescueTeam(target: SnapManifest): Promise<{ team: TeamSummary; extra: string[] }> {
  const current = await readTeam(target.cwd, target.team.id).catch(() => undefined)
  const extra = target.sessions.filter((s) => s.role !== 'descendant').map((s) => s.id)
  if (current !== undefined) return { team: current, extra }
  // 团队目录已没了（被归档或删除）：用目标里的身份兜底
  const captain = target.sessions.find((s) => s.role === 'captain')?.id ?? ''
  return {
    team: summarizeTeam({ id: target.team.id, name: target.team.name, createdAt: target.team.createdAt, captainSessionId: captain, members: [], tasks: [] }, target.team.id),
    extra,
  }
}

// ---------- 3 sessions ----------

async function restoreSessions(home: string, srcDir: string, target: SnapManifest, rescue: SnapManifest): Promise<void> {
  const wanted = new Set(target.sessions.map((s) => s.id))
  for (const s of target.sessions) {
    const dir = sessionDir(home, s.cwd ?? undefined, s.id)
    const from = join(srcDir, 'sessions', encodeSegment(s.id))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(from)) {
      const tmp = join(dir, `.${name}.newsnap-tmp`)
      await copyFile(join(from, name), tmp)
      await rename(tmp, join(dir, name))
    }
    const keep = parseGeneration(s.generation)
    if (keep === undefined) throw new ApplyRefused(`bad generation file name ${s.generation}`)
    for (const g of await listGenerations(dir)) {
      if (g.version > keep.version) await rm(join(dir, g.file), { force: true })
    }
  }
  // 目标里没有的本队会话（快照之后新开的成员、子代理）：救援点里有全量副本，直接删
  for (const s of rescue.sessions) {
    if (wanted.has(s.id)) continue
    await rm(sessionDir(home, s.cwd ?? undefined, s.id), { recursive: true, force: true })
  }
}

// ---------- 4 teams ----------

async function restoreTeams(srcDir: string, target: SnapManifest): Promise<void> {
  const root = agentTeamsRoot(target.cwd)
  await syncTree(join(srcDir, 'agent-teams'), root, target.agentTeams, { exclude: agentTeamsFilter(target.team.id) })
  // retired-members.json：目标里这些会话该不该在名单上，以目标为准；名单里别的 id 不动
  const file = join(root, AGENT_TEAMS_LAYOUT.RETIRED_MEMBERS_FILE)
  let list: unknown[] = []
  try {
    const raw = await readJson(file)
    if (Array.isArray(raw)) list = raw
  } catch {
    // 不存在
  }
  const ours = new Set(target.sessions.map((s) => s.id))
  const shouldRetire = new Set(target.retiredTeamMembers)
  const next = [...list.filter((id) => typeof id !== 'string' || !ours.has(id) || shouldRetire.has(id))]
  for (const id of shouldRetire) if (!next.includes(id)) next.push(id)
  const changed = next.length !== list.length || next.some((v, i) => v !== list[i])
  // 与 agent-teams recordRetiredMemberIds 同格式：排序、两格缩进、末尾换行
  if (changed) await writeJsonAtomic(file, [...next].sort())
}

// ---------- 6 projcache ----------

export function projcacheFiles(home: string, sessionId: string): string[] {
  const base = join(home, 'storages', 'session_projcache', 'sessions')
  return [...new Set([join(base, `${encodeSegment(sessionId)}.json`), join(base, `${sessionId}.json`)])]
}

async function dropProjcache(home: string, ids: Iterable<string>): Promise<void> {
  for (const id of ids) for (const f of projcacheFiles(home, id)) await rm(f, { force: true })
}

// ---------- 7 verify ----------

async function verify(home: string, target: SnapManifest, rescue: SnapManifest, maxFileBytes: number): Promise<void> {
  const problems: string[] = []
  const wanted = new Set(target.sessions.map((s) => s.id))
  for (const s of target.sessions) {
    const dir = sessionDir(home, s.cwd ?? undefined, s.id)
    const gens = await listGenerations(dir)
    const top = gens[0]
    if (top?.file !== s.generation) problems.push(`session ${s.id}: current generation ${top?.file ?? 'none'} != ${s.generation}`)
    else if ((await sha256File(join(dir, s.generation))) !== s.sha256) problems.push(`session ${s.id}: sha256 mismatch`)
  }
  for (const s of rescue.sessions) {
    if (wanted.has(s.id)) continue
    try {
      await stat(sessionDir(home, s.cwd ?? undefined, s.id))
      problems.push(`session ${s.id}: should have been removed`)
    } catch {
      // 好
    }
  }
  const diff = await verifyTree(agentTeamsRoot(target.cwd), target.agentTeams, { exclude: agentTeamsFilter(target.team.id), checkMtime: true })
  if (!isClean(diff)) problems.push(`.agent-teams: ${JSON.stringify(diff)}`)
  const repoDir = layout(newsnapRoot(home, target.cwd)).repo
  if (!(await workspaceMatches({ cwd: target.cwd, repoDir, commit: target.workspace.commit, maxFileBytes }))) {
    problems.push('workspace does not match the snapshot commit')
  }
  if (problems.length > 0) throw new VerifyFailed(problems.join('; '))
}

// ---------- 引擎 ----------

async function restoreUnit(
  params: ApplyParams,
  srcDir: string,
  target: SnapManifest,
  other: SnapManifest,
  phase: 'apply' | 'rollback',
  mark: (step: StepName) => Promise<void>,
): Promise<void> {
  const { home } = params
  const maxFileBytes = params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const repoDir = layout(newsnapRoot(home, target.cwd)).repo
  params.faultBefore?.('sessions', phase)
  await restoreSessions(home, srcDir, target, other)
  await mark('sessions')
  params.faultBefore?.('teams', phase)
  await restoreTeams(srcDir, target)
  await mark('teams')
  params.faultBefore?.('workspace', phase)
  const mtimes = (await readJson(join(srcDir, target.workspace.mtimes))) as Parameters<typeof restoreWorkspace>[0]['mtimes']
  await restoreWorkspace({ cwd: target.cwd, repoDir, commit: target.workspace.commit, mtimes, maxFileBytes })
  await mark('workspace')
  params.faultBefore?.('projcache', phase)
  await dropProjcache(home, new Set([...target.sessions, ...other.sessions].map((s) => s.id)))
  await mark('projcache')
  params.faultBefore?.('verify', phase)
  await verify(home, target, other, maxFileBytes)
  await mark('verify')
}

/**
 * 执行 pending-restore.json 里登记的恢复。调用方先写好 pending（status registered / exiting / applying）。
 * 返回结果并把它写进 pending；第 1 步拿不到锁时抛 ApplyRefused 或 SessionBusy，pending 不变。
 */
export async function runApply(params: ApplyParams): Promise<ApplyOutcome> {
  const now = params.now ?? Date.now
  const root = newsnapRoot(params.home, params.cwd)
  const L = layout(root)
  let pending = await readPending(root)
  if (pending === undefined) throw new ApplyRefused('no restore is registered')
  if (!['registered', 'exiting', 'applying'].includes(pending.status)) {
    throw new ApplyRefused(`registered restore is already ${pending.status}`)
  }
  const tDir = targetDir(root, pending.target)
  const target = await mustManifest(tDir)
  if (target.cwd !== params.cwd) throw new ApplyRefused(`snapshot belongs to ${target.cwd}, not ${params.cwd}`)

  // 1 lock：先 newsnap 锁，再逐个会话写锁；任何一个拿不到就全部放掉、零改动
  params.faultBefore?.('lock', 'apply')
  const releaseLock = await acquireLock(L.lock, 'apply')
  const releases: Array<() => Promise<void>> = [releaseLock]
  const releaseAll = async () => {
    for (const r of releases.reverse()) await r().catch(() => undefined)
  }
  let rescue: SnapManifest | undefined
  try {
    const candidates = new Map<string, string | null>()
    for (const s of target.sessions) candidates.set(s.id, s.cwd)
    if (pending.rescueId !== undefined) {
      const r = await readManifest(L.rescueDir(pending.rescueId))
      for (const s of r?.sessions ?? []) candidates.set(s.id, s.cwd)
    } else {
      const team = await readTeam(target.cwd, target.team.id).catch(() => undefined)
      for (const id of team === undefined ? [] : [team.captainSessionId, ...team.memberSessionIds]) if (!candidates.has(id)) candidates.set(id, target.cwd)
    }
    for (const [id, cwd] of candidates) releases.push(await params.guard.acquire(sessionDir(params.home, cwd ?? undefined, id)))
  } catch (error) {
    await releaseAll()
    throw error
  }

  const save = async (patch: Partial<PendingRestore>) => {
    pending = { ...(pending as PendingRestore), ...patch }
    await writePending(root, pending)
  }
  const mark = async (step: StepName) => {
    const steps = (pending as PendingRestore).steps.map((s) => (s.name === step ? { ...s, done: true, at: now() } : s))
    await save({ steps })
  }
  const resetSteps = async (names: readonly StepName[]) => {
    const steps = (pending as PendingRestore).steps.map((s) => (names.includes(s.name as StepName) ? { name: s.name, done: false } : s))
    await save({ steps })
  }

  const warnings: string[] = []
  try {
    await save({ status: 'applying', steps: pending.steps.length === 0 ? initialSteps() : pending.steps })
    await mark('lock')

    // 2 rescue
    if (pending.rescueId !== undefined) {
      rescue = await mustManifest(L.rescueDir(pending.rescueId))
    } else {
      params.faultBefore?.('rescue', 'apply')
      const { team, extra } = await rescueTeam(target)
      rescue = await captureSnapshot({
        home: params.home, cwd: target.cwd, team, kind: 'rescue', restoreOf: `${pending.target.kind}/${pending.target.id}`,
        extraSessionIds: extra, ...(params.maxFileBytes !== undefined && { maxFileBytes: params.maxFileBytes }),
        versions: target.versions,
      })
      await save({ rescueId: rescue.snapId })
      await mark('rescue')
    }
    const rescueManifest = rescue

    // 3–7
    try {
      await resetSteps(['sessions', 'teams', 'workspace', 'projcache', 'verify'])
      await restoreUnit(params, tDir, target, rescueManifest, 'apply', mark)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      try {
        await restoreUnit(params, L.rescueDir(rescueManifest.snapId), rescueManifest, target, 'rollback', async () => undefined)
      } catch (rollbackError) {
        const msg = `restore failed (${reason}); rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`
        await save({ result: { ok: false, message: msg, at: now() } }) // status 留在 applying
        throw new Error(msg)
      }
      const message = `restore failed and was rolled back: ${reason}`
      await save({ status: 'failed', result: { ok: false, message, at: now() } })
      return { status: 'failed', rescueId: rescueManifest.snapId, message, warnings }
    }

    // 8 release
    const message = `restored to ${pending.target.kind} ${pending.target.id}`
    await mark('release')
    await save({ status: 'applied', result: { ok: true, message, at: now() } })
    return { status: 'applied', rescueId: rescueManifest.snapId, message, warnings }
  } finally {
    await releaseAll()
  }
}

/** 扫描 `.agent-teams` 相关部分（doctor、测试用）。 */
export function scanUnit(cwd: string, teamId: string) {
  return scanTree(agentTeamsRoot(cwd), { exclude: agentTeamsFilter(teamId) })
}
