/**
 * 辅助进程（实现设计 §4.3）：等 DSH 父进程退出 → 执行还原引擎（或回滚）→ 按原参数重新拉起 DSH。
 * 由插件以 `spawn(process.execPath, [helper, home, cwd, parentPid, mode], { detached })` 拉起，
 * 输出写进 `<newsnap 根>/helper.log`。
 * @module newsnap/helper
 */

import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPending, writePending } from '../core/manifest.ts'
import { newsnapRoot } from '../core/paths.ts'
import { relaunchCommand } from '../core/relaunch.ts'
import { assumeStoppedGuard, loadFlockGuard } from '../core/session-guard.ts'
import { runApply, runRollback } from '../core/apply.ts'

export const PARENT_EXIT_TIMEOUT_MS = 60_000

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function runHelper(home: string, cwd: string, parentPid: number, mode: 'apply' | 'rollback', timeoutMs = PARENT_EXIT_TIMEOUT_MS): Promise<number> {
  const root = newsnapRoot(home, cwd)
  await mkdir(root, { recursive: true })
  const logFile = join(root, 'helper.log')
  const log = (m: string) => appendFile(logFile, `${new Date().toISOString()} [helper ${process.pid}] ${m}\n`).catch(() => undefined)

  let pending = await readPending(root)
  if (pending === undefined) {
    await log('no pending restore; nothing to do')
    return 1
  }
  pending = { ...pending, helperPid: process.pid }
  await writePending(root, pending)
  await log(`waiting for DSH pid ${parentPid} (${mode} ${pending.target.kind} ${pending.target.id})`)

  const t0 = Date.now()
  while (alive(parentPid)) {
    if (Date.now() - t0 > timeoutMs) {
      await log('DSH did not exit; giving up')
      if (pending.status !== 'applying') {
        await writePending(root, { ...pending, status: 'failed', result: { ok: false, message: 'restore not performed: DSH did not exit', at: Date.now() } })
      }
      return 1
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  await log(`DSH exited after ${Date.now() - t0} ms`)

  const relaunch = pending.relaunch
  const searchFrom = relaunch?.argv[0] !== undefined ? [dirname(relaunch.argv[0]), dirname(dirname(relaunch.argv[0]))] : []
  const guard = (await loadFlockGuard(searchFrom)) ?? assumeStoppedGuard(`parent ${parentPid} exited`)
  await log(`session guard: ${guard.kind}`)

  let message: string
  let code = 0
  try {
    if (mode === 'rollback') {
      message = await runRollback({ home, cwd, guard })
    } else {
      const outcome = await runApply({ home, cwd, guard })
      message = outcome.message
      if (outcome.status !== 'applied') code = 2
    }
  } catch (error) {
    message = `restore error: ${error instanceof Error ? error.message : String(error)}`
    code = 3
    const now = await readPending(root)
    if (now !== undefined && now.status !== 'applying') {
      // 第 1 步就被拒（锁拿不到等）：现场没动
      await writePending(root, { ...now, status: 'failed', result: { ok: false, message, at: Date.now() } })
    } else if (now !== undefined) {
      await writePending(root, { ...now, result: { ok: false, message, at: Date.now() } })
    }
  }
  await log(message)

  if (relaunch !== null) {
    const cmd = relaunchCommand(relaunch, message)
    await log(`relaunch: ${cmd.file} ${JSON.stringify(cmd.args)} (cwd ${cmd.cwd})`)
    const child = spawn(cmd.file, cmd.args, { cwd: cmd.cwd, detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    await log(`relaunched pid ${child.pid}`)
  }
  return code
}

const [, , home, cwd, pid, mode] = process.argv
if (home !== undefined && cwd !== undefined && pid !== undefined && (mode === 'apply' || mode === 'rollback') && process.env.NEWSNAP_HELPER === '1') {
  runHelper(home, cwd, Number(pid), mode).then((code) => {
    process.exitCode = code
  }, async (error: unknown) => {
    process.exitCode = 1
    process.stderr.write(String(error))
  })
}
