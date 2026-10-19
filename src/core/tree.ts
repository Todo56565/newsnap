/**
 * 目录树清单：扫描、带 mtime 复制、还原 mtime、校验。
 * 用于 `.agent-teams` 相关部分（取代总设计 §2.2 的 tar：纯 Node、跨平台、可逐文件校验）
 * 与工作区 mtime 清单（工作区内容由影子 Git 管，这里只管 mtime）。
 * 路径一律用 `/` 分隔的相对路径，按字典序排列，便于比对。
 * @module newsnap/core/tree
 */

import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink, utimes } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { sha256File } from './fsutil.ts'

export type TreeEntry =
  | { readonly path: string; readonly type: 'file'; readonly size: number; readonly sha256: string; readonly mtimeMs: number }
  | { readonly path: string; readonly type: 'dir'; readonly mtimeMs: number }
  | { readonly path: string; readonly type: 'symlink'; readonly target: string }

export interface ScanOptions {
  /** 返回 true 的相对路径（及其子树）跳过。 */
  readonly exclude?: (relPath: string) => boolean
  /** 不算文件哈希（只要 mtime 清单时用），sha256 置空串。 */
  readonly skipHash?: boolean
}

function toPosix(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join('/')
}

/** 扫描 root 下全部条目（不含 root 本身）。root 不存在返回空。不跟随符号链接。 */
export async function scanTree(root: string, options: ScanOptions = {}): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  async function walk(absDir: string, relDir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(absDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relDir === '') return
      throw error
    }
    for (const name of names) {
      const rel = relDir === '' ? name : `${relDir}/${name}`
      if (options.exclude?.(rel) === true) continue
      const abs = join(absDir, name)
      const st = await lstat(abs)
      if (st.isSymbolicLink()) {
        out.push({ path: rel, type: 'symlink', target: await readlink(abs) })
      } else if (st.isDirectory()) {
        await walk(abs, rel)
        out.push({ path: rel, type: 'dir', mtimeMs: st.mtimeMs })
      } else if (st.isFile()) {
        const sha256 = options.skipHash === true ? '' : await sha256File(abs)
        out.push({ path: rel, type: 'file', size: st.size, sha256, mtimeMs: st.mtimeMs })
      }
      // 套接字、FIFO 等忽略
    }
  }
  await walk(root, '')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function abs(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

/**
 * 按清单把 src 复制到 dst（dst 先整体删除），并还原 mtime。
 * 清单必须来自对 src 的 scanTree；复制后不再校验，需要时调用 verifyTree。
 */
export async function copyTree(src: string, dst: string, entries: readonly TreeEntry[]): Promise<void> {
  await rm(dst, { recursive: true, force: true })
  await mkdir(dst, { recursive: true })
  for (const entry of entries) {
    const to = abs(dst, entry.path)
    if (entry.type === 'dir') {
      await mkdir(to, { recursive: true })
    } else {
      await mkdir(dirname(to), { recursive: true })
      if (entry.type === 'file') await copyFile(abs(src, entry.path), to)
      else await symlink(entry.target, to)
    }
  }
  await restoreMtimes(dst, entries)
}

/**
 * 把清单里的 mtime 写回 root 下对应文件与目录（atime 一并设成同值）。
 * 目录最后、由深到浅设置，避免设完父目录后写子项又把它改掉。不存在的条目跳过。
 */
export async function restoreMtimes(root: string, entries: readonly TreeEntry[]): Promise<void> {
  const files = entries.filter((e): e is Extract<TreeEntry, { type: 'file' }> => e.type === 'file')
  const dirs = entries.filter((e): e is Extract<TreeEntry, { type: 'dir' }> => e.type === 'dir').sort((a, b) => b.path.length - a.path.length)
  for (const entry of [...files, ...dirs]) {
    const seconds = entry.mtimeMs / 1000
    try {
      await utimes(abs(root, entry.path), seconds, seconds)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * 把 dst 中「范围内」的部分同步成清单的样子（还原 `.agent-teams` 用）：
 * 范围由 exclude 定义（与 scanTree 同义，返回 true 的路径不在范围内、不碰）；
 * 范围内清单里没有的条目删除；类型不符的先删；文件经临时文件 + rename 写入；最后还原 mtime。
 * 清单必须来自对 src 的 scanTree。
 */
export async function syncTree(
  src: string,
  dst: string,
  entries: readonly TreeEntry[],
  options: { readonly exclude?: (relPath: string) => boolean } = {},
): Promise<void> {
  await mkdir(dst, { recursive: true })
  const want = new Map(entries.map((e) => [e.path, e]))
  const current = await scanTree(dst, { ...(options.exclude !== undefined && { exclude: options.exclude }), skipHash: true })
  // 由深到浅删除：多余的条目，以及类型不符的条目
  for (const got of [...current].sort((a, b) => b.path.length - a.path.length)) {
    const w = want.get(got.path)
    if (w !== undefined && w.type === got.type && !(w.type === 'symlink' && got.type === 'symlink' && w.target !== got.target)) continue
    const target = abs(dst, got.path)
    if (got.type === 'dir') {
      try {
        await rmdir(target)
      } catch {
        // 里面还有范围外的东西（不该发生）：整个删掉
        await rm(target, { recursive: true, force: true })
      }
    } else {
      await rm(target, { force: true })
    }
  }
  for (const entry of entries) {
    const to = abs(dst, entry.path)
    if (entry.type === 'dir') {
      await mkdir(to, { recursive: true })
    } else if (entry.type === 'symlink') {
      await mkdir(dirname(to), { recursive: true })
      try {
        await symlink(entry.target, to)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } else {
      await mkdir(dirname(to), { recursive: true })
      const tmp = `${to}.newsnap-tmp`
      await copyFile(abs(src, entry.path), tmp)
      await rename(tmp, to)
    }
  }
  await restoreMtimes(dst, entries)
}

export interface TreeDiff {
  readonly missing: string[]
  readonly extra: string[]
  readonly changed: string[]
  readonly mtime: string[]
}

/** mtime 比对容差（毫秒）：utimes 经秒级浮点往返会丢亚微秒精度。 */
export const MTIME_TOLERANCE_MS = 1

/**
 * 校验 root 与清单一致。`checkMtime` 时目录 mtime 也比对。
 * 全部数组为空 = 一致。
 */
export async function verifyTree(
  root: string,
  expected: readonly TreeEntry[],
  options: ScanOptions & { readonly checkMtime?: boolean } = {},
): Promise<TreeDiff> {
  const actual = await scanTree(root, options)
  const byPath = new Map(actual.map((e) => [e.path, e]))
  const diff: TreeDiff = { missing: [], extra: [], changed: [], mtime: [] }
  const seen = new Set<string>()
  for (const want of expected) {
    seen.add(want.path)
    const got = byPath.get(want.path)
    if (got === undefined) {
      diff.missing.push(want.path)
      continue
    }
    if (got.type !== want.type) {
      diff.changed.push(want.path)
      continue
    }
    if (want.type === 'file' && got.type === 'file') {
      if (got.size !== want.size || (options.skipHash !== true && got.sha256 !== want.sha256)) diff.changed.push(want.path)
    } else if (want.type === 'symlink' && got.type === 'symlink') {
      if (got.target !== want.target) diff.changed.push(want.path)
    }
    if (options.checkMtime === true && want.type !== 'symlink' && got.type !== 'symlink') {
      if (Math.abs(got.mtimeMs - want.mtimeMs) > MTIME_TOLERANCE_MS) diff.mtime.push(want.path)
    }
  }
  for (const got of actual) if (!seen.has(got.path)) diff.extra.push(got.path)
  return diff
}

export function isClean(diff: TreeDiff): boolean {
  return diff.missing.length + diff.extra.length + diff.changed.length + diff.mtime.length === 0
}
