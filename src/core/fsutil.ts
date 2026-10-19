/**
 * 小工具：原子写 JSON、流式 sha256、id 生成。
 * @module newsnap/core/fsutil
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 先写同目录临时文件再 rename，写一半不会留下半个文件。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** 读 JSON；文件不存在返回 undefined，其余错误照抛。 */
export async function readJson(path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(raw) as unknown
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 时间 base36 + 4 位随机（总设计 §2.2）。可排序。 */
export function newId(now: number = Date.now()): string {
  return now.toString(36).padStart(9, '0') + '-' + randomBytes(2).toString('hex')
}
