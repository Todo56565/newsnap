/**
 * 快照与救援点的列举、删除、残骸清理（总设计 §8，保留份数等清理策略后续里程碑再加）。
 * 用户可见的删除：removeSnapshot（删一份并 gc 影子仓库，不留独占对象）、purgeWorkspace（删整个工作区的 newsnap 数据）。
 * @module newsnap/core/store
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireLock } from './lock.ts'
import { layout, MANIFEST_FILE, readManifest, readPending, type PendingRestore, type SnapManifest } from './manifest.ts'
import { newsnapRoot } from './paths.ts'
import { git } from './shadow-git.ts'

export interface ListedSnapshot {
  readonly manifest: SnapManifest
  readonly dir: string
  /** 会话日志字节数之和（工作区在影子仓库里共享对象，不计）。 */
  readonly sessionBytes: number
}

export interface Listing {
  readonly items: ListedSnapshot[]
  /** manifest 读不出（损坏、schema 不认识）的目录名。 */
  readonly broken: string[]
}

/** 列出 snaps/ 或 rescue/，新的在前；可按团队过滤（同 id 不同代视为不同团队）。 */
export async function listSnapshots(
  home: string,
  cwd: string,
  kind: 'snapshot' | 'rescue' = 'snapshot',
  team?: { id: string; createdAt: number },
): Promise<Listing> {
  const L = layout(newsnapRoot(home, cwd))
  const base = kind === 'snapshot' ? L.snaps : L.rescue
  let names: string[]
  try {
    names = await readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], broken: [] }
    throw error
  }
  const items: ListedSnapshot[] = []
  const broken: string[] = []
  for (const name of names) {
    const dir = join(base, name)
    let manifest: SnapManifest | undefined
    try {
      manifest = await readManifest(dir)
    } catch {
      broken.push(name)
      continue
    }
    if (manifest === undefined) continue // 残骸，交给 cleanupPartials
    if (team !== undefined && (manifest.team.id !== team.id || manifest.team.createdAt !== team.createdAt)) continue
    items.push({ manifest, dir, sessionBytes: manifest.sessions.reduce((n, s) => n + s.size, 0) })
  }
  items.sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)
  return { items, broken: broken.sort() }
}

/** 删除一份快照或救援点，并删掉它的影子 ref（对象留给以后的 gc）。 */
export async function deleteSnapshot(home: string, cwd: string, kind: 'snapshot' | 'rescue', id: string): Promise<void> {
  const L = layout(newsnapRoot(home, cwd))
  await rm(kind === 'snapshot' ? L.snapDir(id) : L.rescueDir(id), { recursive: true, force: true })
  await git(['--git-dir', L.repo, 'update-ref', '-d', `refs/newsnap/${kind}/${id}`]).catch(() => undefined)
}

/**
 * 清理没有 manifest 的目录（拍照中途失败或进程退出的残骸，总设计 §7）。
 * 只清超过 minAgeMs 的，避免误删正在写的目录。返回清掉的目录名。
 */
export async function cleanupPartials(home: string, cwd: string, minAgeMs = 10 * 60_000, now = Date.now()): Promise<string[]> {
  const L = layout(newsnapRoot(home, cwd))
  const removed: string[] = []
  for (const [kind, base] of [['snapshot', L.snaps], ['rescue', L.rescue]] as const) {
    let names: string[]
    try {
      names = await readdir(base)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(base, name)
      try {
        await stat(join(dir, MANIFEST_FILE))
        continue
      } catch {
        // 没有 manifest
      }
      const st = await stat(dir)
      if (now - st.mtimeMs < minAgeMs) continue
      await deleteSnapshot(home, cwd, kind, name)
      removed.push(`${kind}/${name}`)
    }
  }
  return removed
}

/** 删除被拒（有进行中的恢复）。 */
export class RemoveRefused extends Error {
  override name = 'RemoveRefused'
}

export class SnapshotNotFound extends Error {
  override name = 'SnapshotNotFound'
}

/** 进行中的恢复状态（与 apply.ts ACTIVE_STATUSES 一致；这里不引 apply.ts，避免循环依赖）。 */
const ACTIVE: readonly PendingRestore['status'][] = ['registered', 'exiting', 'applying']

async function refuseIfRestoring(root: string): Promise<void> {
  const pending = await readPending(root).catch(() => undefined)
  if (pending !== undefined && ACTIVE.includes(pending.status)) {
    throw new RemoveRefused(`有一次恢复处于 ${pending.status} 状态，先用 resume 或 rollback 处理完再删除。`)
  }
}

/** 按 id 找快照，找不到再找救援点。 */
export async function findSnapshot(home: string, cwd: string, id: string): Promise<{ kind: 'snapshot' | 'rescue'; manifest: SnapManifest } | undefined> {
  if (id === '' || id.includes('/') || id.includes('\\') || id === '.' || id === '..') return undefined
  const L = layout(newsnapRoot(home, cwd))
  for (const [kind, dir] of [['snapshot', L.snapDir(id)], ['rescue', L.rescueDir(id)]] as const) {
    const manifest = await readManifest(dir).catch(() => undefined)
    if (manifest !== undefined) return { kind, manifest }
  }
  return undefined
}

/** 救援点是否还在（被删后 undo 不可用）。 */
export async function hasRescue(home: string, cwd: string, id: string): Promise<boolean> {
  return (await readManifest(layout(newsnapRoot(home, cwd)).rescueDir(id)).catch(() => undefined)) !== undefined
}

/** 立即清掉影子仓库里不再被任何 ref 引用的对象（bare 仓库默认没有 reflog，这里仍显式过期以防用户开了）。 */
export async function pruneShadowRepo(repo: string): Promise<void> {
  try {
    await stat(repo)
  } catch {
    return
  }
  await git(['--git-dir', repo, 'reflog', 'expire', '--expire=now', '--all'])
  await git(['--git-dir', repo, 'gc', '--prune=now', '--quiet'])
}

export interface RemoveResult {
  readonly kind: 'snapshot' | 'rescue'
  readonly manifest: SnapManifest
  /** 删的是最近一次恢复的救援点：之后 undo 不可用。 */
  readonly undoLost: boolean
}

/**
 * 删除一份快照或救援点，并立即 gc 影子仓库：只被它引用的对象一起消失，和其他快照共用的保留。
 * 拿 newsnap 锁；有进行中的恢复时拒绝。`lastRescueId` 是最近一次成功恢复的救援点（判断 undo 是否失效）。
 */
export async function removeSnapshot(home: string, cwd: string, id: string, lastRescueId?: string): Promise<RemoveResult> {
  const root = newsnapRoot(home, cwd)
  const L = layout(root)
  const release = await acquireLock(L.lock, 'delete')
  try {
    await refuseIfRestoring(root)
    const found = await findSnapshot(home, cwd, id)
    if (found === undefined) throw new SnapshotNotFound(`找不到快照或救援点 ${id}。`)
    await deleteSnapshot(home, cwd, found.kind, id)
    await pruneShadowRepo(L.repo)
    return { ...found, undoLost: found.kind === 'rescue' && lastRescueId === id }
  } finally {
    await release()
  }
}

export interface PurgeResult {
  readonly snapshots: number
  readonly rescues: number
  /** 之前根本没有数据。 */
  readonly empty: boolean
}

/** 删除当前工作区的全部 newsnap 数据（快照、救援点、影子仓库、恢复记录）。不碰工作区本身和用户的 .git。 */
export async function purgeWorkspace(home: string, cwd: string): Promise<PurgeResult> {
  const root = newsnapRoot(home, cwd)
  try {
    await stat(root)
  } catch {
    return { snapshots: 0, rescues: 0, empty: true }
  }
  const release = await acquireLock(layout(root).lock, 'purge')
  try {
    await refuseIfRestoring(root)
    const snapshots = (await listSnapshots(home, cwd, 'snapshot')).items.length
    const rescues = (await listSnapshots(home, cwd, 'rescue')).items.length
    await rm(root, { recursive: true, force: true })
    return { snapshots, rescues, empty: false }
  } finally {
    await release()
  }
}
