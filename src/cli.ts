/**
 * newsnap 命令行（实现设计 §7 M3）：DSH 停机时的兜底与开发工具。
 *
 *   newsnap list [--rescue] [--cwd <dir>]
 *   newsnap apply <id> [--rescue] [--cwd <dir>] [--dsh-stopped]
 *   newsnap resume [--cwd <dir>] [--dsh-stopped]       续做卡住的恢复
 *   newsnap undo [--cwd <dir>] [--dsh-stopped]         恢复到上一次恢复前的救援点
 *   newsnap rollback [--cwd <dir>] [--dsh-stopped]     卡在 applying 时用救援点回滚
 *   newsnap doctor [--cwd <dir>]
 *
 * 会话写锁靠宿主的 flock 原生模块确认 DSH 已退出；找不到它时必须加 --dsh-stopped 由用户担保。
 * @module newsnap/cli
 */

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { ACTIVE_STATUSES, registerRestore, runApply, runRollback } from './core/apply.ts'
import { layout, readPending } from './core/manifest.ts'
import { pidAlive } from './core/lock.ts'
import { newsnapRoot, resolveDshHome } from './core/paths.ts'
import { assumeStoppedGuard, loadFlockGuard, type SessionGuard } from './core/session-guard.ts'
import { cleanupPartials, listSnapshots } from './core/store.ts'
import { formatTime } from './host/format.ts'

const USAGE = `用法：
  newsnap list [--rescue] [--cwd <dir>]
  newsnap apply <id> [--rescue] [--cwd <dir>] [--dsh-stopped]
  newsnap resume | undo | rollback [--cwd <dir>] [--dsh-stopped]
  newsnap doctor [--cwd <dir>]`

/** 找宿主 flock 模块的起点：NEWSNAP_DSH_DIR、PATH 上的 dsh 实际位置、当前目录。 */
function flockSearchDirs(cwd: string): string[] {
  const dirs: string[] = []
  if (process.env.NEWSNAP_DSH_DIR) dirs.push(process.env.NEWSNAP_DSH_DIR)
  try {
    const bin = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' }).split('\n')[0]?.trim()
    if (bin) {
      const real = realpathSync(bin)
      // 全局安装：<prefix>/lib/node_modules/@deepseek-ai/dsh/<bin>；从 bin 所在目录往上找
      let d = dirname(real)
      for (let i = 0; i < 4; i++) {
        dirs.push(d)
        d = dirname(d)
      }
    }
  } catch {
    // 没装 dsh 或不在 PATH
  }
  dirs.push(cwd)
  return dirs
}

async function guardFor(cwd: string, dshStopped: boolean): Promise<SessionGuard> {
  const flock = await loadFlockGuard(flockSearchDirs(cwd))
  if (flock !== undefined) return flock
  if (dshStopped) return assumeStoppedGuard('--dsh-stopped')
  throw new Error('找不到 DSH 的 flock 模块，无法确认 DSH 已退出。请先关掉 DSH，再加 --dsh-stopped 重试（或设置 NEWSNAP_DSH_DIR 指向 DSH 安装目录）。')
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      rescue: { type: 'boolean', default: false },
      'dsh-stopped': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || command === undefined) {
    out(USAGE)
    return command === undefined && !values.help ? 1 : 0
  }
  const cwd = resolve(values.cwd ?? process.cwd())
  const home = resolveDshHome()
  const root = newsnapRoot(home, cwd)
  const kind = values.rescue ? 'rescue' : 'snapshot'

  switch (command) {
    case 'list': {
      const listing = await listSnapshots(home, cwd, kind)
      if (listing.items.length === 0) out(`${cwd} 没有${kind === 'rescue' ? '救援点' : '快照'}。`)
      for (const { manifest: m } of listing.items) {
        out(`${m.snapId}  ${formatTime(m.createdAt)}  团队 ${m.team.name}(${m.team.id})  ${m.sessions.length} 个会话${m.restoreOf ? `  恢复前：${m.restoreOf}` : ''}${m.note ? `  ${m.note}` : ''}`)
      }
      for (const b of listing.broken) out(`读不出：${b}`)
      return 0
    }
    case 'apply': {
      const id = rest[0]
      if (id === undefined) {
        out(USAGE)
        return 1
      }
      const guard = await guardFor(cwd, values['dsh-stopped'])
      await registerRestore({ home, cwd, target: { kind, id }, relaunch: null })
      return report(await runApply({ home, cwd, guard }))
    }
    case 'resume': {
      const guard = await guardFor(cwd, values['dsh-stopped'])
      return report(await runApply({ home, cwd, guard }))
    }
    case 'undo': {
      const pending = await readPending(root)
      if (pending?.rescueId === undefined || pending.status !== 'applied') {
        out('没有可撤销的恢复（需要最近一次恢复已成功）。')
        return 1
      }
      const guard = await guardFor(cwd, values['dsh-stopped'])
      await registerRestore({ home, cwd, target: { kind: 'rescue', id: pending.rescueId }, relaunch: null })
      return report(await runApply({ home, cwd, guard }))
    }
    case 'rollback': {
      const guard = await guardFor(cwd, values['dsh-stopped'])
      out(await runRollback({ home, cwd, guard }))
      return 0
    }
    case 'doctor':
      return doctor(home, cwd, root)
    default:
      out(USAGE)
      return 1
  }
}

function report(outcome: Awaited<ReturnType<typeof runApply>>): number {
  out(outcome.status === 'applied' ? `已恢复：${outcome.message}` : `恢复失败，已回滚：${outcome.message}`)
  out(`恢复前的状态保存在救援点 ${outcome.rescueId}（newsnap undo 可撤销）。`)
  for (const w of outcome.warnings) out(`警告：${w}`)
  return outcome.status === 'applied' ? 0 : 2
}

async function doctor(home: string, cwd: string, root: string): Promise<number> {
  const L = layout(root)
  out(`DSH_HOME：${home}`)
  out(`newsnap 目录：${root}`)
  const flock = await loadFlockGuard(flockSearchDirs(cwd))
  out(`会话写锁探测：${flock === undefined ? '不可用（apply 需要 --dsh-stopped）' : '可用'}`)
  try {
    const holder = JSON.parse(await readFile(L.lock, 'utf8')) as { pid: number; purpose: string; time: number }
    out(`newsnap 锁：${holder.purpose}，pid ${holder.pid}${pidAlive(holder.pid) ? '' : '（进程已不在，下次操作会接管）'}，${formatTime(holder.time)}`)
  } catch {
    out('newsnap 锁：空闲')
  }
  let problems = 0
  try {
    const pending = await readPending(root)
    if (pending === undefined) out('登记的恢复：无')
    else {
      out(`登记的恢复：${pending.target.kind} ${pending.target.id}，状态 ${pending.status}${pending.rescueId ? `，救援点 ${pending.rescueId}` : ''}`)
      out(`  步骤：${pending.steps.map((s) => `${s.name}${s.done ? '✓' : '·'}`).join(' ')}`)
      if (pending.result) out(`  结果：${pending.result.message}`)
      if (ACTIVE_STATUSES.includes(pending.status)) {
        problems++
        out(pending.status === 'applying'
          ? '  恢复中途停下了：关掉 DSH 后运行 newsnap resume 续做，或 newsnap rollback 回到恢复前。'
          : '  恢复已登记但没有执行：关掉 DSH 后运行 newsnap resume，或删除这次登记后重新恢复。')
      }
    }
  } catch (error) {
    problems++
    out(`登记文件读不出：${error instanceof Error ? error.message : String(error)}`)
  }
  const removed = await cleanupPartials(home, cwd)
  if (removed.length > 0) out(`已清理拍照残骸：${removed.join('、')}`)
  for (const k of ['snapshot', 'rescue'] as const) {
    const listing = await listSnapshots(home, cwd, k)
    out(`${k === 'snapshot' ? '快照' : '救援点'}：${listing.items.length} 份${listing.broken.length > 0 ? `，读不出 ${listing.broken.join('、')}` : ''}`)
    problems += listing.broken.length
  }
  return problems === 0 ? 0 : 3
}
