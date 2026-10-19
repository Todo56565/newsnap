/**
 * 快照与救援点的列举、删除、残骸清理（总设计 §8，保留份数等清理策略后续里程碑再加）。
 * @module newsnap/core/store
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { layout, MANIFEST_FILE, readManifest, type SnapManifest } from './manifest.ts'
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
