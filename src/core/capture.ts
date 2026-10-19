/**
 * 拍照的磁盘部分（总设计 §3 第 4、5 步）：会话代文件、`.agent-teams` 相关部分、工作区影子提交、manifest。
 * 前置检查（全队空闲、无进行中任务、无投递中的信、不在合并中）与冻结由 host 层负责，这里不碰 DSH 运行时。
 * 同一份代码也用来建救援点（kind = rescue）。
 * @module newsnap/core/capture
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { newId, sha256File, writeJsonAtomic } from './fsutil.ts'
import { layout, writeManifest, type SnapManifest, type SnapSession } from './manifest.ts'
import { agentTeamsRoot, currentGeneration, encodeSegment, newsnapRoot, sessionDir } from './paths.ts'
import { descendantsOf, listProjectSessions } from './sessions.ts'
import { DEFAULT_MAX_FILE_BYTES, git, snapshotWorkspace } from './shadow-git.ts'
import { AGENT_TEAMS_LAYOUT, listTeamIds, readRetiredMemberIds, teamSessionIds, type TeamSummary } from './teams.ts'
import { copyTree, isClean, scanTree, verifyTree, type TreeEntry } from './tree.ts'

export class SnapshotRaced extends Error {
  override name = 'SnapshotRaced'
}

export class SessionMissing extends Error {
  override name = 'SessionMissing'
}

/** `.agent-teams` 里属于这个回溯单元的部分：`<teamId>/`、`archive/<teamId>/`、`.context/`。 */
export function agentTeamsFilter(teamId: string): (rel: string) => boolean {
  const { ARCHIVE_DIR, CONTEXT_DIR } = AGENT_TEAMS_LAYOUT
  return (rel) => {
    const [first, second] = rel.split('/')
    if (first === teamId || first === CONTEXT_DIR) return false
    if (first === ARCHIVE_DIR) return second !== undefined && second !== teamId
    return true // 其他团队、retired-members.json 等：排除
  }
}

export interface CaptureParams {
  readonly home: string
  readonly cwd: string
  readonly team: TeamSummary
  readonly kind?: 'snapshot' | 'rescue'
  readonly restoreOf?: string
  readonly note?: string
  readonly maxFileBytes?: number
  readonly versions?: Readonly<Record<string, string>>
  readonly id?: string
  readonly now?: number
  /**
   * 救援点用（DSH 已退出时）：额外收录的会话 id（快照里有、现在团队里已没有的成员），
   * 会话目录不存在就跳过而不是报错，并且复制会话目录里的全部代文件（回滚要原样恢复）。
   */
  readonly extraSessionIds?: readonly string[]
}

/** 会话目录与本次快照里各会话的角色。后代按 parentSession 递归，只看同工作区项目目录。 */
export async function resolveTeamSessions(home: string, cwd: string, team: TeamSummary, extra: readonly string[] = []) {
  const roots = [...new Set([...teamSessionIds(team), ...extra])]
  const project = await listProjectSessions(home, cwd)
  const roles = new Map<string, SnapSession['role']>()
  roles.set(team.captainSessionId, 'captain')
  for (const id of [...team.memberSessionIds, ...extra]) if (!roles.has(id)) roles.set(id, 'member')
  for (const id of descendantsOf(roots, project)) roles.set(id, 'descendant')
  const cwdOf = new Map(project.map((s) => [s.header.id, s.header.cwd ?? null]))
  return [...roles].map(([id, role]) => ({ id, role, cwd: cwdOf.get(id) ?? cwd }))
}

/** 代文件与其他会话附属文件（不含写锁）。 */
const SKIP_IN_FULL_COPY = new Set(['session.lock'])

async function copySession(
  home: string,
  snapDir: string,
  s: { id: string; role: SnapSession['role']; cwd: string | null },
  full: boolean,
): Promise<SnapSession | undefined> {
  const dir = sessionDir(home, s.cwd ?? undefined, s.id)
  const gen = await currentGeneration(dir).catch(() => undefined)
  if (gen === undefined) {
    if (full) return undefined
    throw new SessionMissing(`session ${s.id} has no log under ${dir}`)
  }
  if (full) {
    const dstDir = join(snapDir, 'sessions', encodeSegment(s.id))
    await mkdir(dstDir, { recursive: true })
    for (const name of await readdir(dir)) {
      if (SKIP_IN_FULL_COPY.has(name)) continue
      const st = await stat(join(dir, name))
      if (st.isFile()) await copyFile(join(dir, name), join(dstDir, name))
    }
    const dst = join(dstDir, gen.file)
    const copied = await stat(dst)
    return { id: s.id, cwd: s.cwd, generation: gen.file, size: copied.size, sha256: await sha256File(dst), role: s.role }
  }
  const src = join(dir, gen.file)
  const before = await stat(src)
  const dstDir = join(snapDir, 'sessions', encodeSegment(s.id))
  await mkdir(dstDir, { recursive: true })
  const dst = join(dstDir, gen.file)
  await copyFile(src, dst)
  const after = await stat(src)
  const latest = await currentGeneration(dir)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || latest?.file !== gen.file) {
    throw new SnapshotRaced(`session ${s.id} changed while copying`)
  }
  const copied = await stat(dst)
  if (copied.size !== before.size) throw new SnapshotRaced(`session ${s.id} copy is incomplete`)
  return { id: s.id, cwd: s.cwd, generation: gen.file, size: copied.size, sha256: await sha256File(dst), role: s.role }
}

/**
 * 拍一份快照（或救援点）。成功返回 manifest；失败删掉目录与影子 ref，原样抛错。
 * manifest 最后写，写完才算成立；没有 manifest 的目录视为残骸。
 */
export async function captureSnapshot(params: CaptureParams): Promise<SnapManifest> {
  const { home, cwd, team } = params
  const kind = params.kind ?? 'snapshot'
  const now = params.now ?? Date.now()
  const id = params.id ?? newId(now)
  const L = layout(newsnapRoot(home, cwd))
  const dir = kind === 'snapshot' ? L.snapDir(id) : L.rescueDir(id)
  const ref = `${kind}/${id}`
  await mkdir(kind === 'snapshot' ? L.snaps : L.rescue, { recursive: true })
  await mkdir(dir) // 已存在就抛错，不覆盖别人的目录
  try {
    // 1. 会话
    const full = kind === 'rescue'
    const targets = await resolveTeamSessions(home, cwd, team, params.extraSessionIds ?? [])
    const sessions: SnapSession[] = []
    for (const t of targets) {
      const copied = await copySession(home, dir, t, full)
      if (copied !== undefined) sessions.push(copied)
    }

    // 2. .agent-teams 相关部分
    const filter = agentTeamsFilter(team.id)
    const atRoot = agentTeamsRoot(cwd)
    const agentTeams: TreeEntry[] = await scanTree(atRoot, { exclude: filter })
    const atDst = join(dir, 'agent-teams')
    await copyTree(atRoot, atDst, agentTeams)
    const diff = await verifyTree(atDst, agentTeams, { checkMtime: true })
    if (!isClean(diff)) throw new SnapshotRaced(`.agent-teams changed while copying: ${JSON.stringify(diff)}`)

    const retired = await readRetiredMemberIds(cwd)
    const retiredTeamMembers = sessions.map((x) => x.id).filter((sid) => retired.has(sid))

    // 3. 工作区
    const ws = await snapshotWorkspace({
      cwd, repoDir: L.repo, ref, message: `newsnap ${kind} ${id} team ${team.id}`,
      maxFileBytes: params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    })
    await writeJsonAtomic(join(dir, 'mtimes.json'), ws.mtimes)

    // 4. 复核：会话在整个过程中没再变（总设计 §3.5）
    for (const s of sessions) {
      const gen = await currentGeneration(sessionDir(home, s.cwd ?? undefined, s.id))
      const st = gen === undefined ? undefined : await stat(join(sessionDir(home, s.cwd ?? undefined, s.id), gen.file))
      if (gen?.file !== s.generation || st?.size !== s.size) throw new SnapshotRaced(`session ${s.id} changed during snapshot`)
    }

    const manifest: SnapManifest = {
      schema: 1, snapId: id, kind,
      ...(params.restoreOf !== undefined && { restoreOf: params.restoreOf }),
      createdAt: now,
      ...(params.note !== undefined && params.note !== '' && { note: params.note }),
      cwd,
      team: { id: team.id, name: team.name, createdAt: team.createdAt },
      sessions,
      agentTeams,
      retiredTeamMembers,
      workspace: { commit: ws.commit, mtimes: 'mtimes.json', skipped: ws.skipped },
      otherTeams: (await listTeamIds(cwd)).filter((t) => t !== team.id),
      versions: params.versions ?? {},
    }
    await writeManifest(dir, manifest)
    return manifest
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    await git(['--git-dir', L.repo, 'update-ref', '-d', `refs/newsnap/${ref}`]).catch(() => undefined)
    throw error
  }
}
