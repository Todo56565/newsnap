/**
 * 快照与「现在」的对比（M5-2 右侧栏时光机，m5-web-ui.md §6）。全部只读：不改工作区、不挂 ref。
 *
 * - 文件：按拍照同样的收录规则给当前工作区建树，与快照提交的树做 `git diff-tree`（不识别改名，改名显示为一删一增）。
 *   方向是「快照 → 现在」：added = 快照之后新出现的文件，回到快照时会被删掉。
 * - 单文件 diff：旧内容取快照提交里的 blob，新内容读工作区文件；二进制或过大只给提示。
 * - 会话：数会话日志里的 `turn/start` 事件得到轮数，比较快照里那份和现在这份。
 * @module newsnap/core/compare
 */

import { readFile, lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SnapManifest } from './manifest.ts'
import { currentGeneration, encodeSegment, sessionDir } from './paths.ts'
import { currentTree, DEFAULT_MAX_FILE_BYTES, git } from './shadow-git.ts'

export type FileStatus = 'added' | 'modified' | 'deleted'

export interface FileChange {
  readonly path: string
  readonly status: FileStatus
  /** 增删行数；二进制文件为 null。 */
  readonly added: number | null
  readonly removed: number | null
}

export interface WorkspaceCompare {
  readonly files: FileChange[]
  /** 快照里因超过单文件上限而没收录的文件（回到快照时不动）。 */
  readonly skipped: readonly string[]
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s !== '')
}

const STATUS: Record<string, FileStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' }

/** 快照提交与当前工作区的文件差异，按路径排序。 */
export async function compareWorkspace(params: {
  cwd: string
  repoDir: string
  commit: string
  skipped?: readonly string[]
  maxFileBytes?: number
}): Promise<WorkspaceCompare> {
  const { cwd, repoDir, commit } = params
  const { tree } = await currentTree(cwd, repoDir, params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
  const base = (await git(['--git-dir', repoDir, 'rev-parse', `${commit}^{tree}`])).trim()
  if (base === tree) return { files: [], skipped: params.skipped ?? [] }
  const names = splitZ(await git(['--git-dir', repoDir, 'diff-tree', '-r', '--no-renames', '--name-status', '-z', base, tree]))
  const stats = splitZ(await git(['--git-dir', repoDir, 'diff-tree', '-r', '--no-renames', '--numstat', '-z', base, tree]))
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  for (const line of stats) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(line)
    if (m === null) continue
    counts.set(m[3] as string, { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) })
  }
  const files: FileChange[] = []
  for (let i = 0; i + 1 < names.length; i += 2) {
    const status = STATUS[(names[i] as string)[0] as string]
    const path = names[i + 1] as string
    if (status === undefined) continue
    files.push({ path, status, ...(counts.get(path) ?? { added: null, removed: null }) })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, skipped: params.skipped ?? [] }
}

/** 单文件 diff 文本的上限：超过就只给提示，网页不画。 */
export const MAX_DIFF_BYTES = 512 * 1024

export type FileDiff =
  | { readonly kind: 'text'; readonly path: string; readonly oldText: string | null; readonly newText: string | null }
  | { readonly kind: 'binary' | 'too-large'; readonly path: string }

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

export class UnsafePath extends Error {
  override name = 'UnsafePath'
}

/** 工作区相对路径检查：不许绝对路径、`..`、空段、反斜杠。 */
export function checkRelPath(path: string): string {
  if (path === '' || path.length > 4096 || path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new UnsafePath(`路径不合法：${path}`)
  }
  return path
}

async function readBlob(repoDir: string, commit: string, path: string): Promise<Buffer | null> {
  const ls = await git(['--git-dir', repoDir, 'ls-tree', '-z', commit, '--', path])
  const entry = splitZ(ls)[0]
  if (entry === undefined) return null
  const hash = /^\d+ blob ([0-9a-f]+)\t/.exec(entry)?.[1]
  if (hash === undefined) return null
  const size = Number((await git(['--git-dir', repoDir, 'cat-file', '-s', hash])).trim())
  if (size > MAX_DIFF_BYTES) return Buffer.alloc(MAX_DIFF_BYTES + 1)
  // git() 按 utf8 解码；这里内容只用于文本 diff，二进制靠 NUL 判断（utf8 解码保留 NUL）
  return Buffer.from(await git(['--git-dir', repoDir, 'cat-file', 'blob', hash]), 'utf8')
}

async function readCurrent(cwd: string, path: string): Promise<Buffer | null> {
  const abs = join(cwd, ...path.split('/'))
  let st
  try {
    st = await lstat(abs)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) return Buffer.from(await readlink(abs), 'utf8')
  if (!st.isFile()) return null
  if (st.size > MAX_DIFF_BYTES) return Buffer.alloc(MAX_DIFF_BYTES + 1)
  return readFile(abs)
}

/** 一个文件在快照里与现在的内容（不存在的一侧为 null）。 */
export async function fileDiff(params: { cwd: string; repoDir: string; commit: string; path: string }): Promise<FileDiff> {
  const path = checkRelPath(params.path)
  const [before, after] = await Promise.all([readBlob(params.repoDir, params.commit, path), readCurrent(params.cwd, path)])
  for (const b of [before, after]) {
    if (b !== null && b.length > MAX_DIFF_BYTES) return { kind: 'too-large', path }
  }
  for (const b of [before, after]) {
    if (b !== null && isBinary(b)) return { kind: 'binary', path }
  }
  return { kind: 'text', path, oldText: before?.toString('utf8') ?? null, newText: after?.toString('utf8') ?? null }
}

// ── 会话轮数 ──

const ZSTD_MAGIC = 0xfd2fb528

/** 拆开多帧 zstd（DSH 会话日志一批事件一帧；node 的一次性解压只解第一帧）。截断的尾帧丢掉。 */
export function zstdFrames(buffer: Buffer): Buffer[] {
  const out: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    const d = buffer.readUInt8(offset)
    offset += 1
    const fcs = d >>> 6
    const single = (d & 0x20) !== 0
    const checksum = (d & 0x04) !== 0
    const dict = d & 0x03
    offset += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs)
    let complete = false
    while (buffer.length - offset >= 3) {
      const bh = buffer.readUIntLE(offset, 3)
      offset += 3
      const type = (bh >>> 1) & 3
      offset += type === 1 ? 1 : bh >>> 3
      if ((bh & 1) !== 0) {
        complete = true
        break
      }
    }
    if (checksum) offset += 4
    if (!complete || offset > buffer.length) break
    out.push(buffer.subarray(start, offset))
  }
  return out
}

/** 读会话日志全文（.zstd 逐帧解压）。 */
export async function readSessionLog(file: string): Promise<string> {
  const raw = await readFile(file)
  if (!file.endsWith('.zstd')) return raw.toString('utf8')
  return zstdFrames(raw).map((f) => zstdDecompressSync(f).toString('utf8')).join('')
}

/** 会话日志里的轮数（`turn/start` 事件个数）。读不出返回 null。 */
export async function countTurns(file: string): Promise<number | null> {
  let text: string
  try {
    text = await readSessionLog(file)
  } catch {
    return null
  }
  let n = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"turn/start"')) continue
    try {
      if ((JSON.parse(line) as { type?: unknown }).type === 'turn/start') n++
    } catch {
      // 半行
    }
  }
  return n
}

export interface SessionImpact {
  readonly id: string
  readonly role: 'captain' | 'member' | 'descendant'
  /** kept：两边都有；removed：快照之后新开，回去时移进撤销点；restored：现在没有，回去时回来。 */
  readonly change: 'kept' | 'removed' | 'restored'
  readonly snapTurns: number | null
  readonly nowTurns: number | null
}

/**
 * 各会话在快照与现在的轮数。`current` 是现在属于本队的会话（resolveTeamSessions 的结果）。
 * 快照里那份读 `<snapDir>/sessions/<id>/<generation>`，现在这份读会话目录的当前代。
 */
export async function sessionImpact(params: {
  home: string
  snapDir: string
  manifest: SnapManifest
  current: ReadonlyArray<{ id: string; role: SessionImpact['role']; cwd: string | null }>
}): Promise<SessionImpact[]> {
  const { home, snapDir, manifest } = params
  const nowTurns = async (id: string, cwd: string | null): Promise<number | null> => {
    const dir = sessionDir(home, cwd ?? undefined, id)
    const gen = await currentGeneration(dir).catch(() => undefined)
    return gen === undefined ? null : countTurns(join(dir, gen.file))
  }
  const out: SessionImpact[] = []
  const currentIds = new Map(params.current.map((s) => [s.id, s]))
  for (const s of manifest.sessions) {
    const snapTurns = await countTurns(join(snapDir, 'sessions', encodeSegment(s.id), s.generation))
    const cur = currentIds.get(s.id)
    out.push({
      id: s.id, role: s.role, snapTurns,
      change: cur === undefined ? 'restored' : 'kept',
      nowTurns: cur === undefined ? null : await nowTurns(s.id, cur.cwd),
    })
  }
  const inSnap = new Set(manifest.sessions.map((s) => s.id))
  for (const s of params.current) {
    if (inSnap.has(s.id)) continue
    out.push({ id: s.id, role: s.role, change: 'removed', snapTurns: null, nowTurns: await nowTurns(s.id, s.cwd) })
  }
  const order = { captain: 0, member: 1, descendant: 2 }
  return out.sort((a, b) => order[a.role] - order[b.role])
}
