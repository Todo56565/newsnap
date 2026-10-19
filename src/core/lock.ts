/**
 * newsnap 自己的跨进程互斥锁（拍照、登记、apply 互斥；实现设计 §2 `lock`）。
 * `open(..., 'wx')` 独占创建，内容 `{ pid, time, purpose }`；持有者进程已不在时可接管
 * （apply 的辅助进程在 DSH 退出后运行，需要接管 DSH 进程留下的锁）。
 * Node 没有 flock，这里不用它；会话写锁的判活在 apply 里另做。
 * @module newsnap/core/lock
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export class LockBusy extends Error {
  override name = 'LockBusy'
  readonly holder: LockInfo
  constructor(holder: LockInfo) {
    super(`newsnap is busy (${holder.purpose}, pid ${holder.pid})`)
    this.holder = holder
  }
}

export interface LockInfo {
  readonly pid: number
  readonly time: number
  readonly purpose: string
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readHolder(path: string): Promise<LockInfo | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as LockInfo
    return typeof value.pid === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 拿锁，返回释放函数。被活着的进程持有时抛 LockBusy；持有者已死或锁文件损坏则接管。
 * `alive` 可注入，便于测试。
 */
export async function acquireLock(
  path: string,
  purpose: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx')
      const info: LockInfo = { pid: process.pid, time: Date.now(), purpose }
      await handle.writeFile(JSON.stringify(info))
      await handle.close()
      return async () => {
        const holder = await readHolder(path)
        if (holder?.pid === process.pid && holder.time === info.time) await rm(path, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = await readHolder(path)
      if (holder !== undefined && holder.pid !== process.pid && alive(holder.pid)) throw new LockBusy(holder)
      if (holder?.pid === process.pid) throw new LockBusy(holder) // 同进程重入也拒绝
      await rm(path, { force: true }) // 死锁或坏文件：接管
    }
  }
  throw new Error(`could not acquire ${path}`)
}

export async function withLock<T>(path: string, purpose: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(path, purpose)
  try {
    return await fn()
  } finally {
    await release()
  }
}
