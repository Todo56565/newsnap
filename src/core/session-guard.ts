/**
 * 会话写锁探测（实现设计 §3 第 1 步）：apply 前逐个会话试拿宿主的写锁，拿不到说明 DSH 还在写，什么都不改。
 * 宿主在 POSIX 上对 `session.lock` 做非阻塞 flock(2)（session-persistence-jsonl lease.ts），
 * 由原生模块 `@deepseek-ai/node-addon-system/flock` 提供；Windows 用命名信号量，0.1 不支持。
 * newsnap 不自带原生模块：能从 DSH 的安装里加载就用，否则调用方须显式确认 DSH 已退出。
 * @module newsnap/core/session-guard
 */

import { open, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SESSION_LOCK_FILE } from './paths.ts'

export class SessionBusy extends Error {
  override name = 'SessionBusy'
}

export interface SessionGuard {
  /** 已确认这个会话目录没人写；返回释放函数。拿不到抛 SessionBusy。 */
  acquire(sessionDir: string): Promise<() => Promise<void>>
  readonly kind: string
}

type TryLock = (fd: number) => Promise<void> | void

/** 用 flock 实现的守卫。 */
export function flockGuard(tryLockExclusive: TryLock): SessionGuard {
  return {
    kind: 'flock',
    async acquire(dir) {
      const path = join(dir, SESSION_LOCK_FILE)
      try {
        await stat(dir)
      } catch {
        return async () => undefined // 会话目录不存在：没有写者
      }
      const handle = await open(path, 'a') // 不截断、不删除：宿主要求锁文件 inode 稳定
      try {
        await tryLockExclusive(handle.fd)
      } catch (error) {
        await handle.close()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') throw new SessionBusy(`session at ${dir} is still open in DSH`)
        throw error
      }
      return async () => {
        await handle.close()
      }
    },
  }
}

/** 调用方已确认 DSH 退出（例如辅助进程等到父进程消失、或用户在命令行加了确认参数）。 */
export function assumeStoppedGuard(reason: string): SessionGuard {
  return { kind: `assume-stopped(${reason})`, acquire: async () => async () => undefined }
}

/**
 * 试着从若干位置加载宿主的 flock 原生模块。
 * searchFrom：用于 require.resolve 的起点（DSH 安装目录、process.argv[1] 等）。
 */
export async function loadFlockGuard(searchFrom: readonly string[]): Promise<SessionGuard | undefined> {
  if (process.platform === 'win32') return undefined
  for (const from of searchFrom) {
    try {
      const require = createRequire(from.endsWith('/') ? from : `${from}/`)
      const resolved = require.resolve('@deepseek-ai/node-addon-system/flock')
      const mod = (await import(pathToFileURL(resolved).href)) as { tryLockExclusive?: TryLock }
      if (typeof mod.tryLockExclusive === 'function') return flockGuard(mod.tryLockExclusive)
    } catch {
      // 换下一个位置
    }
  }
  return undefined
}
