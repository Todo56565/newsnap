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
import { resolveDshHome } from './core/paths.ts'
import { cleanupPartials, listSnapshots } from './core/store.ts'
import { UnsupportedTeamState } from './core/teams.ts'
import { LockBusy } from './core/lock.ts'
import { NotATeamSession, SnapshotBlocked, takeSnapshot, teamFor, type HostRuntime } from './host/capture.ts'
import { formatBlocked, formatList, formatSnapshot } from './host/format.ts'

export const name = 'newsnap'
export const inject = ['agents', 'sessions']
export const VERSION = '0.1.0-dev'

export function apply(ctx: Context): void {
  const home = resolveDshHome()
  const frozen = new Set<string>()

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

  async function run(invocation: CommandInvocation): Promise<CommandResult> {
    const session = invocation.agent.session
    const cwd = session.header.cwd
    if (cwd === undefined) return { kind: 'error', text: 'newsnap：这个会话没有工作区目录，无法拍照。' }
    const [sub = '', ...rest] = invocation.rawInput.trim().split(/\s+/)
    try {
      if (sub === 'snap') {
        const note = invocation.rawInput.trim().slice(sub.length).trim()
        const manifest = await takeSnapshot(host, {
          home, cwd, sessionId: session.id,
          ...(note !== '' && { note }),
          versions: { newsnap: VERSION, node: process.version },
        })
        return { kind: 'success', text: formatSnapshot(manifest) }
      }
      if (sub === 'list' && rest.length === 0) {
        const team = await teamFor(cwd, session.id)
        const listing = await listSnapshots(home, cwd, 'snapshot', team)
        return { kind: 'success', text: formatList(team, listing) }
      }
      return { kind: 'error', text: '用法：/newsnap snap [备注] | /newsnap list' }
    } catch (error) {
      if (error instanceof SnapshotBlocked) return { kind: 'error', text: formatBlocked(error.blockers) }
      if (error instanceof NotATeamSession) return { kind: 'error', text: 'newsnap：当前会话不属于任何活动团队。' }
      if (error instanceof UnsupportedTeamState) return { kind: 'error', text: `newsnap：团队状态格式不认识，拒绝操作（${error.message}）。` }
      if (error instanceof LockBusy) return { kind: 'error', text: `newsnap：另一项操作正在进行（${error.holder.purpose}）。` }
      return { kind: 'error', text: `newsnap 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'newsnap',
      description: '团队快照：snap [备注] 拍照，list 列出',
      input: { hint: 'snap [备注] | list' },
      handler: run,
    }), 'newsnap: slash command')
  })

  // 启动时清理当前进程工作区的拍照残骸（没有 manifest 且超过 10 分钟的目录）
  void cleanupPartials(home, process.cwd()).catch(() => undefined)
}
