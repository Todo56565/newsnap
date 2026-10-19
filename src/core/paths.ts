/**
 * DSH 磁盘布局（只读复刻，不 import DSH）。
 * 依据 dsh-v0.2.1-rc.2：
 * - `util/home-paths` resolveDshHome：$DSH_HOME（非空）优先，否则 ~/.dsh；支持 ~ 展开。
 * - `session-persistence-jsonl/format.ts` encodeSegment / projectKey / sessionDir。
 * - `session-format/filename.ts` 代文件名：session.jsonl（v0）、session.v<N>.jsonl，压缩时加 .zstd。
 * 改这里时对照上述源码；常量与转义规则必须逐字一致，否则找不到会话目录。
 * @module newsnap/core/paths
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 解析 DSH_HOME，与宿主 resolveDshHome 同规则。 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(expandHome(selected))
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function escapeUnit(code: number): string {
  return '~' + code.toString(16).toUpperCase().padStart(4, '0')
}

const SAFE = /^[A-Za-z0-9._-]$/

/** 会话 id 等单个路径段的转义（宿主 encodeSegment）。 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && SAFE.test(ch) ? ch : escapeUnit(code)
  }
  return out
}

/** 工作区目录名（宿主 projectKey）。 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else {
      readable += ch !== '~' && SAFE.test(ch) ? ch : escapeUnit(code)
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 会话根目录（bundle/base cordis.patch.yml：dshHomePath('sessions')）。 */
export function sessionsRoot(home: string): string {
  return join(home, 'sessions')
}

/** 某会话的目录；cwd 为 undefined 时宿主用 `_no-cwd`。 */
export function sessionDir(home: string, cwd: string | undefined, sessionId: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return join(sessionsRoot(home), project, encodeSegment(sessionId))
}

/** 写锁文件（session-persistence-jsonl/lease.ts）。 */
export const SESSION_LOCK_FILE = 'session.lock'

export interface Generation {
  readonly file: string
  readonly version: number
  readonly compression: 'zstd' | 'none'
}

const GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u

/** 解析代文件名；非规范名（临时文件、大写、前导零、.v0）返回 undefined。 */
export function parseGeneration(file: string): Generation | undefined {
  const match = GENERATION.exec(file)
  if (match === null) return undefined
  const version = match[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(version)) return undefined
  return { file, version, compression: match[2] === undefined ? 'none' : 'zstd' }
}

/** 列出会话目录里的全部规范代文件，按版本从高到低；目录不存在返回空。 */
export async function listGenerations(dir: string): Promise<Generation[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: Generation[] = []
  for (const name of names) {
    const parsed = parseGeneration(name)
    if (parsed !== undefined) out.push(parsed)
  }
  return out.sort((a, b) => b.version - a.version)
}

/** 宿主选用的那一代：编号最高者。 */
export async function currentGeneration(dir: string): Promise<Generation | undefined> {
  return (await listGenerations(dir))[0]
}

/** newsnap 在 DSH_HOME 下的工作区根。 */
export function newsnapRoot(home: string, cwd: string): string {
  return join(home, 'newsnap', projectKey(cwd))
}

/** agent-teams 状态根（`<cwd>/.agent-teams`）。 */
export function agentTeamsRoot(cwd: string): string {
  return join(cwd, '.agent-teams')
}
