/**
 * 会话写锁探测（实现设计 §3 第 1 步）：apply 前逐个会话试拿宿主的写锁，拿不到说明 DSH 还在写，什么都不改。
 * 宿主在 POSIX 上对 `session.lock` 做非阻塞 flock(2)（session-persistence-jsonl lease.ts），
 * 由原生模块 `@deepseek-ai/node-addon-system/flock` 提供；Windows 上宿主改用命名信号量
 * `Local\\dsh-session-lock-<sha256(resolve(lockPath).toLowerCase())>`（session-persistence-jsonl win32.ts，经 koffi 调 kernel32）。
 * newsnap 不自带原生模块：能从 DSH 的安装里加载就用，否则调用方须显式确认 DSH 已退出。
 * @module newsnap/core/session-guard
 */

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
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

/** Windows 宿主用的信号量名（与 DSH acquireLockHandleWin32 一致）。 */
export function win32LockName(lockPath: string): string {
  return `Local\\dsh-session-lock-${createHash('sha256').update(resolve(lockPath).toLowerCase()).digest('hex')}`
}

export interface Win32SemaphoreApi {
  createSemaphoreW(security: null, initial: number, maximum: number, name: string): number
  waitForSingleObject(handle: number, milliseconds: number): number
  releaseSemaphore(handle: number, count: number, previous: null): number
  closeHandle(handle: number): number
  getLastError(): number
}

const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

/** 用 Windows 命名信号量实现的守卫：不等待地试拿，WAIT_TIMEOUT 说明宿主还持有。 */
export function semaphoreGuard(api: Win32SemaphoreApi): SessionGuard {
  return {
    kind: 'win32-semaphore',
    async acquire(dir) {
      try {
        await stat(dir)
      } catch {
        return async () => undefined
      }
      const name = win32LockName(join(dir, SESSION_LOCK_FILE))
      const handle = api.createSemaphoreW(null, 1, 1, name)
      if (handle === 0) throw new Error(`CreateSemaphoreW failed (${api.getLastError()}) for ${name}`)
      const wait = api.waitForSingleObject(handle, 0)
      if (wait !== WAIT_OBJECT_0) {
        const err = api.getLastError()
        api.closeHandle(handle)
        if (wait === WAIT_TIMEOUT) throw new SessionBusy(`session at ${dir} is still open in DSH`)
        throw new Error(`WaitForSingleObject failed (${err}) for ${name}`)
      }
      return async () => {
        api.releaseSemaphore(handle, 1, null)
        api.closeHandle(handle)
      }
    },
  }
}

/** 调用方已确认 DSH 退出（例如辅助进程等到父进程消失、或用户在命令行加了确认参数）。 */
export function assumeStoppedGuard(reason: string): SessionGuard {
  return { kind: `assume-stopped(${reason})`, acquire: async () => async () => undefined }
}

/**
 * 扩展查找起点（测试报告 B3）：NEWSNAP_DSH_DIR 优先；桌面端的路径在 `app.asar` 里，而原生模块
 * （flock、koffi）在旁边的 `app.asar.unpacked`，所以每个含 `app.asar` 的起点再加一个替换后的；
 * Windows 再加桌面端默认安装位置。
 */
export function hostSearchDirs(seeds: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  const add = (d: string | undefined): void => {
    if (d !== undefined && d !== '' && !out.includes(d)) out.push(d)
  }
  add(env.NEWSNAP_DSH_DIR)
  for (const seed of seeds) {
    const unpacked = seed.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked')
    if (unpacked !== seed) add(unpacked)
    add(seed)
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    add(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh'))
  }
  return out
}

/**
 * 试着从若干位置加载宿主的 flock 原生模块。
 * searchFrom：用于 require.resolve 的起点（DSH 安装目录、process.argv[1] 等）。
 */
export async function loadFlockGuard(searchFrom: readonly string[], onMiss?: (from: string, error: unknown) => void): Promise<SessionGuard | undefined> {
  if (process.platform === 'win32') return loadSemaphoreGuard(searchFrom, onMiss)
  for (const from of searchFrom) {
    try {
      const require = createRequire(from.endsWith('/') ? from : `${from}/`)
      const resolved = require.resolve('@deepseek-ai/node-addon-system/flock')
      const mod = (await import(pathToFileURL(resolved).href)) as { tryLockExclusive?: TryLock }
      if (typeof mod.tryLockExclusive === 'function') return flockGuard(mod.tryLockExclusive)
      onMiss?.(from, new Error('module has no tryLockExclusive'))
    } catch (error) {
      onMiss?.(from, error) // 换下一个位置
    }
  }
  return undefined
}

/** Windows：从 DSH 安装里加载 koffi（宿主自己就靠它调 kernel32），绑定信号量 API。 */
async function loadSemaphoreGuard(searchFrom: readonly string[], onMiss?: (from: string, error: unknown) => void): Promise<SessionGuard | undefined> {
  for (const from of searchFrom) {
    try {
      const require = createRequire(join(from, 'x.js'))
      const resolved = require.resolve('koffi')
      const mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown }
      const koffi = (mod.default ?? mod) as { load(lib: string): { func(conv: string, name: string, ret: string, args: string[]): (...a: unknown[]) => number } }
      const k = koffi.load('kernel32.dll')
      const api: Win32SemaphoreApi = {
        createSemaphoreW: k.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']) as Win32SemaphoreApi['createSemaphoreW'],
        waitForSingleObject: k.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as Win32SemaphoreApi['waitForSingleObject'],
        releaseSemaphore: k.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']) as Win32SemaphoreApi['releaseSemaphore'],
        closeHandle: k.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as Win32SemaphoreApi['closeHandle'],
        getLastError: k.func('__stdcall', 'GetLastError', 'uint', []) as Win32SemaphoreApi['getLastError'],
      }
      return semaphoreGuard(api)
    } catch (error) {
      onMiss?.(from, error) // 换下一个位置
    }
  }
  return undefined
}
