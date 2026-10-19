/**
 * 会话目录的只读工具：读头部、找子代理后代。
 * 头部 = 当前代文件第一行 `{"type":"session", id, cwd?, parentSession?, origin?, …}`
 * （session-persistence-jsonl/format.ts HeaderLine）；`.zstd` 代用 node:zlib 流式解压，只读到第一个换行。
 * @module newsnap/core/sessions
 */

import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import { currentGeneration, projectKey, sessionsRoot } from './paths.ts'

export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
}

const MAX_HEADER_BYTES = 1024 * 1024

/** 读代文件第一行；读不出或格式不对返回 undefined。 */
export async function readHeader(file: string): Promise<SessionHeader | undefined> {
  const source = createReadStream(file)
  const stream = file.endsWith('.zstd') ? source.pipe(createZstdDecompress()) : source
  let buf = ''
  try {
    for await (const chunk of stream) {
      buf += (chunk as Buffer).toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        buf = buf.slice(0, nl)
        break
      }
      if (buf.length > MAX_HEADER_BYTES) return undefined
    }
  } catch {
    return undefined
  } finally {
    source.destroy()
    if (stream !== source) stream.destroy()
  }
  try {
    const value = JSON.parse(buf) as Record<string, unknown>
    if (value.type !== 'session' || typeof value.id !== 'string') return undefined
    return {
      id: value.id,
      ...(typeof value.cwd === 'string' && { cwd: value.cwd }),
      ...(typeof value.parentSession === 'string' && { parentSession: value.parentSession }),
      ...(typeof value.origin === 'string' && { origin: value.origin }),
    }
  } catch {
    return undefined
  }
}

export interface ProjectSession {
  /** 会话目录名（encodeSegment 后的 id）。 */
  readonly dirName: string
  readonly dir: string
  readonly header: SessionHeader
}

/** 列出某工作区项目目录下全部会话及其头部（读不出头部的跳过）。 */
export async function listProjectSessions(home: string, cwd: string): Promise<ProjectSession[]> {
  const projectDir = join(sessionsRoot(home), projectKey(cwd))
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: ProjectSession[] = []
  for (const dirName of names.sort()) {
    const dir = join(projectDir, dirName)
    const gen = await currentGeneration(dir).catch(() => undefined)
    if (gen === undefined) continue
    const header = await readHeader(join(dir, gen.file))
    if (header !== undefined) out.push({ dirName, dir, header })
  }
  return out
}

/** 以 roots 为祖先（按 parentSession 递归）的会话 id，不含 roots 本身，按发现顺序。 */
export function descendantsOf(roots: readonly string[], sessions: readonly ProjectSession[]): string[] {
  const children = new Map<string, string[]>()
  for (const s of sessions) {
    const parent = s.header.parentSession
    if (parent === undefined) continue
    const list = children.get(parent) ?? []
    list.push(s.header.id)
    children.set(parent, list)
  }
  const seen = new Set(roots)
  const out: string[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}
