/**
 * newsnap 服务端插件入口。
 * 0.1 / M2：斜杠命令 `/newsnap snap [备注]`、`/newsnap list`；冻结用的 pre-step 钩子；启动时清理拍照残骸。
 * inject 只列每个 profile 都有的服务（实现设计 §1，吸取 token-budget 0.5.1 F1）；commands 懒注册。
 * @module newsnap
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lastApplied } from './core/apply.ts'
import { GitMissing } from './core/shadow-git.ts'
import { newsnapRoot, resolveDshHome } from './core/paths.ts'
import { listSnapshots } from './core/store.ts'
import { UnsupportedTeamState } from './core/teams.ts'
import { LockBusy } from './core/lock.ts'
import { NotATeamSession, SnapshotBlocked, takeSnapshot, teamFor, type HostRuntime } from './host/capture.ts'
import { formatBlocked, formatList, formatSnapshot } from './host/format.ts'
import { registerDevTool } from './host/dev-tool.ts'
import { reconcile, type Notice } from './host/reconcile.ts'
import { markCommandClosed, pendingCommandFixes } from './host/open-commands.ts'
import { continueRestore, previewRestore, relaunchesItself, RestoreNotFound, RestoreUnsupported, startRestore, type Impact, type RestoreContext } from './host/restore.ts'

export const name = 'newsnap'
export const inject = ['agents', 'sessions']
export const VERSION = '0.1.0-dev'

const USAGE = '用法：/newsnap snap [备注] | list | restore <快照> [confirm] | undo [confirm] | resume | rollback | status'

const HELPER = fileURLToPath(new URL(`./helper/helper${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url))

const DESKTOP_RESTART = '桌面端会弹出「启动失败」对话框，这是 newsnap 让宿主退出造成的，点「重启」即可'

/** 恢复后宿主怎样回来：web/headless 自动重启（网页要手动刷新，旧页面的事件游标落在截断后的日志之后），桌面端靠对话框。 */
function comeBack(profile: string, done = '恢复完成后'): string {
  if (!relaunchesItself(profile)) return DESKTOP_RESTART
  return profile === 'web' ? `${done}自动重新启动；页面重新连上后请刷新一次，否则看到的仍是恢复前的对话` : `${done}自动重新启动`
}

/**
 * appExit 只是请启动器拆掉插件树、设 exitCode、等事件循环自己排空（apps/cli process-shutdown.ts）。
 * 桌面宿主和 Electron 之间的 IPC 通道会让循环永远排不空，进程不退出（测试报告 B2）。
 * 所以 appExit 之后用不挂在插件上下文上的原生定时器兜底：1 秒后断开 IPC（桌面宿主自己把断开当停机），
 * 8 秒仍未退出就直接退出。定时器 unref，不拖住本来就能正常退出的 web/headless。
 */
function armExitFallback(): void {
  setTimeout(() => {
    if (process.connected) process.disconnect()
  }, 1000).unref()
  setTimeout(() => {
    process.exit(0)
  }, 8000).unref()
}

function describeImpact(i: Impact, command: string, profile: string): string {
  const restart = `DSH 会退出，${comeBack(profile, '')}`
  const lines = [`将把团队 ${i.target.team.name} 恢复到 ${i.target.snapId}（${new Date(i.target.createdAt).toLocaleString()}）：会话、团队状态、工作区都回到那一刻，${restart}。`]
  if (i.removedSessions.length > 0) lines.push(`快照之后新开的 ${i.removedSessions.length} 个会话会移进救援点：${i.removedSessions.join('、')}。`)
  if (i.otherTeams.length > 0) lines.push(`注意：同一工作区还有团队 ${i.otherTeams.join('、')}，工作区文件整体回退也会影响它们。`)
  lines.push('恢复前的状态会存成救援点，之后可以撤销。')
  lines.push(`确认请输入：${command} confirm`)
  return lines.join('\n')
}

export function apply(ctx: Context): void {
  const profile = ctx.get('profileContext') as { name?: string; home?: string } | undefined
  const home = profile?.home ?? resolveDshHome()
  const frozen = new Set<string>()
  let notices: Notice[] = []

  // 冻结：拍照期间本队会话不进入新步骤（agent-teams 也用这个钩子做准入）
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (frozen.has(agent.session.id)) return { kind: 'reject' }
    return next()
  })

  const host: HostRuntime = {
    agentStatus: (id) => ctx.agents.get(id as SessionId)?.status,
    async flush(id) {
      const session = ctx.sessions.get(id as SessionId)
      if (session !== undefined) await ctx.sessions.flush(session)
    },
    freeze(ids) {
      const added = ids.filter((id) => !frozen.has(id))
      for (const id of added) frozen.add(id)
      return () => {
        for (const id of added) frozen.delete(id)
      }
    },
  }

  function restoreContext(cwd: string, sessionId: string): RestoreContext {
    return {
      home, cwd, sessionId,
      profile: profile?.name ?? 'unknown',
      appExit: ctx.get('appExit') as ((code: number) => unknown) | undefined,
      relaunch: { execPath: process.execPath, execArgv: [...process.execArgv], argv: process.argv.slice(1), cwd: process.cwd() },
      spawnHelper(mode) {
        const root = newsnapRoot(home, cwd)
        mkdirSync(root, { recursive: true })
        const child = spawn(process.execPath, [...(HELPER.endsWith('.ts') ? ['--experimental-strip-types'] : []), HELPER, home, cwd, String(process.pid), mode], {
          detached: true, windowsHide: true, stdio: 'ignore', cwd: root, env: { ...process.env, NEWSNAP_HELPER: '1' },
        })
        child.unref()
        return child.pid
      },
      schedule: (fn) => setImmediate(() => {
        fn()
        armExitFallback()
      }),
    }
  }

  function noticeText(cwd: string): string {
    const mine = notices.filter((n) => n.cwd === cwd)
    notices = notices.filter((n) => n.cwd !== cwd)
    return mine.map((n) => `${n.level === 'warn' ? '⚠ ' : ''}${n.text}`).join('\n')
  }

  async function run(invocation: CommandInvocation): Promise<CommandResult> {
    const session = invocation.agent.session
    const cwd = session.header.cwd
    if (cwd === undefined) return { kind: 'error', text: 'newsnap：这个会话没有工作区目录。' }
    const args = invocation.rawInput.trim().split(/\s+/).filter((a) => a !== '')
    const [sub = '', ...rest] = args
    const confirm = rest.at(-1) === 'confirm'
    try {
      switch (sub) {
        case 'snap': {
          const note = invocation.rawInput.trim().slice(sub.length).trim()
          const manifest = await takeSnapshot(host, {
            home, cwd, sessionId: session.id,
            ...(note !== '' && { note }),
            ...(typeof invocation.commandId === 'string' && { commandId: invocation.commandId }),
            versions: { newsnap: VERSION, node: process.version },
          })
          return { kind: 'success', text: formatSnapshot(manifest) }
        }
        case 'list': {
          const team = await teamFor(cwd, session.id)
          const listing = await listSnapshots(home, cwd, 'snapshot', team)
          return { kind: 'success', text: formatList(team, listing) }
        }
        case 'restore':
        case 'undo': {
          let target: { kind: 'snapshot' | 'rescue'; id: string }
          if (sub === 'restore') {
            const id = rest[0]
            if (id === undefined || id === 'confirm') return { kind: 'error', text: USAGE }
            target = { kind: 'snapshot', id }
          } else {
            const last = await lastApplied(home, cwd)
            if (last?.rescueId === undefined) return { kind: 'error', text: 'newsnap：没有可撤销的恢复。' }
            target = { kind: 'rescue', id: last.rescueId }
          }
          const rctx = restoreContext(cwd, session.id)
          if (!confirm) {
            return { kind: 'success', text: describeImpact(await previewRestore(host, rctx, target), sub === 'restore' ? `/newsnap restore ${target.id}` : '/newsnap undo', rctx.profile) }
          }
          await startRestore(host, rctx, target)
          return { kind: 'success', text: `正在恢复到 ${target.id}：DSH 马上退出，${comeBack(rctx.profile)}。` }
        }
        case 'resume':
        case 'rollback': {
          const pending = await continueRestore(restoreContext(cwd, session.id), sub === 'resume' ? 'apply' : 'rollback')
          const after = comeBack(profile?.name ?? '', '完成后')
          return { kind: 'success', text: `${sub === 'resume' ? '继续恢复' : '回滚'} ${pending.target.id}：DSH 马上退出，${after}。` }
        }
        case 'status': {
          const text = noticeText(cwd)
          if (text !== '') return { kind: 'success', text }
          const last = await lastApplied(home, cwd)
          if (last === undefined) return { kind: 'success', text: 'newsnap：没有待处理的恢复。' }
          const when = new Date(last.result?.at ?? last.createdAt).toLocaleString()
          const what = last.target.kind === 'snapshot' ? `恢复到快照 ${last.target.id}` : `撤销（回到救援点 ${last.target.id}）`
          return { kind: 'success', text: `newsnap：没有待处理的恢复。最近一次操作是 ${when} 的${what}，/newsnap undo 可撤销。` }
        }
        default:
          return { kind: 'error', text: USAGE }
      }
    } catch (error) {
      if (error instanceof GitMissing) return { kind: 'error', text: `newsnap：${error.message}` }
      if (error instanceof SnapshotBlocked) return { kind: 'error', text: formatBlocked(error.blockers, sub === 'snap' ? '拍快照' : '恢复') }
      if (error instanceof NotATeamSession) return { kind: 'error', text: 'newsnap：当前会话不属于任何活动团队。' }
      if (error instanceof UnsupportedTeamState) return { kind: 'error', text: `newsnap：团队状态格式不认识，拒绝操作（${error.message}）。` }
      if (error instanceof LockBusy) return { kind: 'error', text: `newsnap：另一项操作正在进行（${error.holder.purpose}）。` }
      if (error instanceof RestoreUnsupported || error instanceof RestoreNotFound) return { kind: 'error', text: `newsnap：${error.message}` }
      return { kind: 'error', text: `newsnap 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'newsnap',
      description: '团队快照：snap 拍照、list 列出、restore 恢复、undo 撤销',
      input: { hint: 'snap [备注] | list | restore <快照> | undo | status' },
      handler: run,
    }), 'newsnap: slash command')
  })

  registerDevTool(ctx, run)

  // 恢复后补记快照里悬空的 /newsnap snap 命令（测试报告 B4）
  void pendingCommandFixes(home).then((fixes) => {
    if (fixes.length === 0) return
    const started = new Set<string>()
    const close = (session: { id: string; append: unknown }): void => {
      const fix = fixes.find((f) => f.sessionId === session.id && !started.has(f.key))
      if (fix === undefined) return
      started.add(fix.key)
      setImmediate(() => {
        try {
          const append = (session.append as (type: string, data: object) => unknown).bind(session)
          append('command/done', { commandId: fix.commandId, kind: 'success', text: fix.text })
          void markCommandClosed(fix.root, fix.key)
        } catch (error) {
          started.delete(fix.key)
          ctx.logger?.warn?.(`newsnap: closing restored command ${fix.commandId} failed: ${String(error)}`)
        }
      })
    }
    ctx.on('session/created', (session) => close(session as unknown as { id: string; append: unknown }))
    for (const f of fixes) {
      const live = ctx.sessions.get(f.sessionId as SessionId)
      if (live !== undefined) close(live as unknown as { id: string; append: unknown })
    }
  }, (error: unknown) => {
    ctx.logger?.warn?.(`newsnap: scanning restored commands failed: ${String(error)}`)
  })

  // 启动对账 + 清理所有工作区根下的拍照残骸
  void reconcile(home).then((found) => {
    notices = found
    for (const n of found) ctx.logger?.[n.level === 'warn' ? 'warn' : 'info']?.(`newsnap [${n.cwd}] ${n.text}`)
  }, (error: unknown) => {
    ctx.logger?.warn?.(`newsnap: startup reconcile failed: ${String(error)}`)
  })
}
