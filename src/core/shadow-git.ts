/**
 * 影子 Git（总设计 §2.3）：用独立 bare 仓库 + 临时 index 给工作区拍照、还原，不碰用户的 `.git` 与 index。
 *
 * - 收录：已跟踪 + 未跟踪文件，遵守工作区 `.gitignore`、全局 excludesFile，另抄用户 `<cwd>/.git/info/exclude`；
 *   固定排除 `.agent-teams/`（由目录树清单单独收）。
 * - 嵌套仓库（子目录有 `.git`）：顶层 ls-files 只给出 `sub/`，改用该仓库自己的规则列文件后逐个收录，跳过其 `.git/`。
 * - 单文件超过 maxFileBytes 不收，记入 skipped；符号链接按链接本身收（mode 120000）。
 * - 内容按原始字节存（--no-filters），可执行位保留。
 * - mtime 另存清单（Git 不存 mtime）。
 * - 校验：按同样规则对当前工作区再建一次树，比较树 hash。
 * @module newsnap/core/shadow-git
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { restoreMtimes, type TreeEntry } from './tree.ts'

/** 固定排除（相对工作区根，gitignore 语法）。 */
export const FIXED_EXCLUDES = ['/.agent-teams/'] as const
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024

export class GitError extends Error {
  override name = 'GitError'
}

/** 找不到可用的 git（测试报告 B1：DSH 桌面端不自带 git）。 */
export class GitMissing extends Error {
  override name = 'GitMissing'
}

let gitBinary: Promise<string> | undefined

function probe(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { windowsHide: true, timeout: 10_000 }, (error) => resolve(error === null))
  })
}

/** git 候选：NEWSNAP_GIT、PATH 上的 git，Windows 再加 Git for Windows 的默认位置。 */
export function gitCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  if (env.NEWSNAP_GIT) out.push(env.NEWSNAP_GIT)
  out.push('git')
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
      if (base) out.push(join(base, 'Git', 'cmd', 'git.exe'))
    }
  }
  return out
}

/** 解析并缓存可用的 git；都不行抛 GitMissing（中文说明）。 */
export function resolveGit(): Promise<string> {
  gitBinary ??= (async () => {
    const tried = gitCandidates()
    for (const c of tried) if (await probe(c)) return c
    gitBinary = undefined // 用户装好 git 后下次重试
    throw new GitMissing(`未找到 git（试过：${tried.join('、')}）。newsnap 用 git 给工作区拍照，请安装 Git（Windows 可装 Git for Windows），或用环境变量 NEWSNAP_GIT 指向 git 可执行文件，然后重启 DSH。`)
  })()
  return gitBinary
}

interface RunOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly input?: string | Buffer
  readonly cwd?: string
}

/** 跑 git；清掉调用方环境里可能干扰的 GIT_* 变量，只用传入的。 */
export async function git(args: readonly string[], options: RunOptions = {}): Promise<string> {
  const file = await resolveGit()
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) base[k] = v
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        env: {
          ...base,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'newsnap', GIT_AUTHOR_EMAIL: 'newsnap@localhost',
          GIT_COMMITTER_NAME: 'newsnap', GIT_COMMITTER_EMAIL: 'newsnap@localhost',
          ...options.env,
        },
        cwd: options.cwd,
        maxBuffer: 1024 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(`git ${args.join(' ')}: ${stderr.trim() || error.message}`))
        else resolve(stdout)
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s !== '')
}

/** 建 bare 仓库（已存在则只刷新配置）。 */
export async function ensureRepo(repoDir: string): Promise<void> {
  try {
    await stat(join(repoDir, 'HEAD'))
  } catch {
    await resolveGit() // 先确认有 git，免得留下空的 repo.git
    await mkdir(repoDir, { recursive: true })
    try {
      await git(['init', '--bare', '-q', repoDir])
    } catch (error) {
      await rm(repoDir, { recursive: true, force: true })
      throw error
    }
  }
  for (const [k, v] of [['core.autocrlf', 'false'], ['gc.auto', '0'], ['core.symlinks', 'true']] as const) {
    await git(['--git-dir', repoDir, 'config', k, v])
  }
}

/** 写影子仓库的 info/exclude：固定排除 + 用户仓库 info/exclude（若有）。每次拍照前刷新。 */
async function writeExcludes(repoDir: string, cwd: string): Promise<void> {
  let user = ''
  try {
    user = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')
  } catch {
    // 没有用户仓库或没有 exclude
  }
  await mkdir(join(repoDir, 'info'), { recursive: true })
  await writeFile(join(repoDir, 'info', 'exclude'), `# newsnap fixed\n${FIXED_EXCLUDES.join('\n')}\n# from <cwd>/.git/info/exclude\n${user}\n`)
}

export interface WorkspaceFile {
  /** 相对工作区根，`/` 分隔。 */
  readonly path: string
  readonly mode: '100644' | '100755' | '120000'
  readonly size: number
  readonly mtimeMs: number
}

export interface Listing {
  readonly files: WorkspaceFile[]
  readonly skipped: string[]
}

function envFor(repoDir: string, cwd: string, index: string): Record<string, string> {
  return { GIT_DIR: repoDir, GIT_WORK_TREE: cwd, GIT_INDEX_FILE: index }
}

function tmpIndex(): string {
  return join(tmpdir(), `newsnap-index-${process.pid}-${randomBytes(6).toString('hex')}`)
}

/** 按收录规则列出工作区文件（不读内容）。 */
export async function listWorkspace(cwd: string, repoDir: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES): Promise<Listing> {
  await ensureRepo(repoDir)
  await writeExcludes(repoDir, cwd)
  const index = tmpIndex()
  const candidates: string[] = []
  try {
    const top = splitZ(await git(['ls-files', '-o', '--exclude-standard', '-z'], { env: envFor(repoDir, cwd, index), cwd }))
    for (const rel of top) {
      if (rel.endsWith('/')) await listNested(cwd, rel.slice(0, -1), candidates)
      else candidates.push(rel)
    }
  } finally {
    await rm(index, { force: true })
  }
  const files: WorkspaceFile[] = []
  const skipped: string[] = []
  for (const rel of [...new Set(candidates)].sort()) {
    let st
    try {
      st = await lstat(join(cwd, ...rel.split('/')))
    } catch {
      continue // 列出后被删、或嵌套仓库里已删除的已跟踪文件
    }
    if (st.isSymbolicLink()) {
      files.push({ path: rel, mode: '120000', size: st.size, mtimeMs: st.mtimeMs })
    } else if (st.isFile()) {
      if (st.size > maxFileBytes) skipped.push(rel)
      else files.push({ path: rel, mode: (st.mode & 0o111) !== 0 ? '100755' : '100644', size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return { files, skipped }
}

/** 嵌套仓库：用它自己的 git 与忽略规则列文件，递归处理更深的嵌套。 */
async function listNested(cwd: string, relDir: string, out: string[]): Promise<void> {
  const absDir = join(cwd, ...relDir.split('/'))
  let entries: string[]
  try {
    entries = splitZ(await git(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: absDir }))
  } catch {
    return // 坏掉的嵌套仓库：不收，交给 skipped 之外的已知局限
  }
  for (const rel of entries) {
    const full = `${relDir}/${rel}`
    if (rel.endsWith('/')) await listNested(cwd, full.slice(0, -1), out)
    else out.push(full)
  }
}

/** 把一份列表写进临时 index 并 write-tree，返回树 hash。 */
async function buildTree(cwd: string, repoDir: string, files: readonly WorkspaceFile[], index: string): Promise<string> {
  const env = envFor(repoDir, cwd, index)
  const regular = files.filter((f) => f.mode !== '120000')
  const hashes = new Map<string, string>()
  if (regular.length > 0) {
    const out = await git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      env, cwd, input: regular.map((f) => join(cwd, ...f.path.split('/'))).join('\n') + '\n',
    })
    const lines = out.split('\n').filter((l) => l !== '')
    if (lines.length !== regular.length) throw new GitError('hash-object returned a different number of hashes')
    regular.forEach((f, i) => hashes.set(f.path, lines[i] as string))
  }
  for (const f of files) {
    if (f.mode !== '120000') continue
    const target = await readlink(join(cwd, ...f.path.split('/')))
    hashes.set(f.path, (await git(['hash-object', '-w', '--stdin'], { env, cwd, input: target })).trim())
  }
  const info = files.map((f) => `${f.mode} ${hashes.get(f.path)}\t${f.path}\0`).join('')
  await rm(index, { force: true })
  if (info !== '') await git(['update-index', '-z', '--add', '--index-info'], { env, cwd, input: info })
  return (await git(['write-tree'], { env, cwd })).trim()
}

export interface WorkspaceSnapshot {
  readonly commit: string
  /** 只含文件条目，sha256 为空（内容由 Git 管）。 */
  readonly mtimes: TreeEntry[]
  readonly skipped: string[]
}

/** 给工作区拍照：提交挂在 `refs/newsnap/<ref>`，防止 gc 清掉。 */
export async function snapshotWorkspace(params: {
  cwd: string
  repoDir: string
  ref: string
  message?: string
  maxFileBytes?: number
}): Promise<WorkspaceSnapshot> {
  const { cwd, repoDir, ref } = params
  await ensureRepo(repoDir)
  const listing = await listWorkspace(cwd, repoDir, params.maxFileBytes)
  const index = tmpIndex()
  try {
    const tree = await buildTree(cwd, repoDir, listing.files, index)
    const commit = (await git(['commit-tree', tree, '-m', params.message ?? `newsnap ${ref}`], {
      env: envFor(repoDir, cwd, index), cwd,
    })).trim()
    await git(['--git-dir', repoDir, 'update-ref', `refs/newsnap/${ref}`, commit])
    const mtimes: TreeEntry[] = listing.files
      .filter((f) => f.mode !== '120000')
      .map((f) => ({ path: f.path, type: 'file' as const, size: f.size, sha256: '', mtimeMs: f.mtimeMs }))
    return { commit, mtimes, skipped: listing.skipped }
  } finally {
    await rm(index, { force: true })
  }
}

/** 当前工作区按收录规则建出的树 hash 是否等于提交的树（校验用）。 */
export async function workspaceMatches(params: {
  cwd: string
  repoDir: string
  commit: string
  maxFileBytes?: number
}): Promise<boolean> {
  const { cwd, repoDir, commit } = params
  const listing = await listWorkspace(cwd, repoDir, params.maxFileBytes)
  const index = tmpIndex()
  try {
    const tree = await buildTree(cwd, repoDir, listing.files, index)
    const want = (await git(['--git-dir', repoDir, 'rev-parse', `${commit}^{tree}`])).trim()
    return tree === want
  } finally {
    await rm(index, { force: true })
  }
}

/** 按收录规则给当前工作区建树（对象写进影子仓库，不挂 ref），返回树 hash。只读工作区。 */
export async function currentTree(cwd: string, repoDir: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES): Promise<{ tree: string; listing: Listing }> {
  const listing = await listWorkspace(cwd, repoDir, maxFileBytes)
  const index = tmpIndex()
  try {
    return { tree: await buildTree(cwd, repoDir, listing.files, index), listing }
  } finally {
    await rm(index, { force: true })
  }
}

/** 提交里的文件路径。 */
export async function commitFiles(repoDir: string, commit: string): Promise<string[]> {
  return splitZ(await git(['--git-dir', repoDir, 'ls-tree', '-r', '--name-only', '-z', commit]))
}

export interface RestoreResult {
  readonly deleted: string[]
  readonly written: number
}

/**
 * 把工作区还原成提交的样子（exact 语义，总设计 §2.3）：
 * 删除当前收录范围内、提交里没有的文件（被忽略的、超限的不动），再按提交写出全部文件，最后还原 mtime。
 * 调用方负责事先建救援点。
 */
export async function restoreWorkspace(params: {
  cwd: string
  repoDir: string
  commit: string
  mtimes: readonly TreeEntry[]
  maxFileBytes?: number
}): Promise<RestoreResult> {
  const { cwd, repoDir, commit } = params
  await ensureRepo(repoDir)
  const want = new Set(await commitFiles(repoDir, commit))
  const current = await listWorkspace(cwd, repoDir, params.maxFileBytes)
  const deleted: string[] = []
  for (const f of current.files) {
    if (want.has(f.path)) continue
    const abs = join(cwd, ...f.path.split('/'))
    await rm(abs, { force: true })
    deleted.push(f.path)
    await pruneEmptyDirs(cwd, dirname(abs))
  }
  // 提交里是文件、现在却是目录（或反过来）的路径：先清掉挡路的条目
  for (const rel of want) await clearBlockers(cwd, rel)
  const index = tmpIndex()
  try {
    const env = envFor(repoDir, cwd, index)
    await git(['read-tree', commit], { env, cwd })
    await git(['checkout-index', '-a', '-f'], { env, cwd })
  } finally {
    await rm(index, { force: true })
  }
  await restoreMtimes(cwd, params.mtimes)
  return { deleted, written: want.size }
}

async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  let current = dir
  while (current.length > root.length && current.startsWith(root)) {
    try {
      await rmdir(current)
    } catch {
      return // 非空或不存在
    }
    current = dirname(current)
  }
}

/** 目标路径的某个父级现在是文件，或目标本身现在是目录：删掉（它们不在提交里，已在救援点）。 */
async function clearBlockers(cwd: string, rel: string): Promise<void> {
  const parts = rel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const abs = join(cwd, ...parts.slice(0, i))
    let st
    try {
      st = await lstat(abs)
    } catch {
      return
    }
    const isLast = i === parts.length
    if (!isLast && !st.isDirectory()) {
      await rm(abs, { force: true })
      return
    }
    if (isLast && st.isDirectory()) {
      // 只删空目录：里面若还有被忽略的文件（不在救援点里），宁可失败交给回滚，也不静默删掉
      try {
        await rmdir(abs)
      } catch {
        throw new GitError(`path conflict: ${rel} is a non-empty directory in the workspace`)
      }
    }
  }
}
