/**
 * 网页界面的数据接口：经 DSH Typert Gateway 的 SRC 回退暴露 Remote 方法 `newsnap/<method>`（M5，PoC 见 m5-web-ui.md §3a）。
 *
 * - 不用装饰器语法（项目是 strip-types），也不在运行时 import typert-protocol：
 *   直接按协议的稳定格式写原型上的方法描述符（`@deepseek-ai/dsh-typert-protocol/remote-methods`，version 1），
 *   再挂可见的 `typertRemote` 绑定 `{ service, serviceKey, namespace }`，用 `ctx.provide` 注册成服务。
 * - SRC 回退从函数源码读参数名：第一个参数必须叫 `session`（按 lookup 解析成 Session，wire 字段 sessionId），
 *   其余参数是普通 JSON，只做无循环检查，所以这里自己校验。
 * - 方法从不抛错给网关：失败统一返回 `{ ok: false, message }`，消息和斜杠命令一致。
 * - 客户端 `ctx.remote` 不挂 SRC 描述符，客户端直接用 `connection.rpc.call('/api', 'newsnap/<method>', { args })`。
 * @module newsnap/host/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { lastApplied } from '../core/apply.ts'
import { hasRescue, listSnapshots } from '../core/store.ts'
import { findTeamOfSession } from '../core/teams.ts'
import { takeSnapshot, type HostRuntime } from './capture.ts'
import { errorText } from './errors.ts'
import { previewRestore, relaunchesItself, startRestore, type RestoreContext } from './restore.ts'

export const REMOTE_SERVICE_KEY = 'newsnapRemote'
export const REMOTE_NAMESPACE = 'newsnap'
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const METHODS = ['list', 'snap', 'preview', 'restore', 'undo'] as const
/** Remote 回应要先发回网页，再让宿主退出。 */
const EXIT_AFTER_REPLY_MS = 400

/** Remote 收到的 Session（lookup 解析出的对象），只用到 id 和 header。 */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

export interface SnapshotRow {
  readonly id: string
  readonly createdAt: number
  readonly note?: string
  readonly sessions: number
  /** 拍照所在的 `/newsnap snap` 命令 id：对话里的书签卡按它认领自己的快照。 */
  readonly commandId?: string
}

export interface SnapshotsView {
  readonly team: { readonly id: string; readonly name: string } | null
  readonly snapshots: SnapshotRow[]
  readonly lastApplied: {
    readonly kind: 'snapshot' | 'rescue'
    readonly target: string
    readonly note?: string
    readonly targetAt?: number
    readonly at: number
    readonly canUndo: boolean
  } | null
}

export interface PreviewView {
  readonly id: string
  readonly createdAt: number
  readonly note?: string
  readonly team: string
  /** 快照之后新开、会被移进救援点的本队会话数。 */
  readonly removedSessions: number
  readonly otherTeams: string[]
  /** 恢复后宿主是否自己重启（网页、headless 是；桌面端靠 Electron 对话框）。 */
  readonly relaunches: boolean
}

export interface RemoteDeps {
  readonly home: string
  readonly host: HostRuntime
  readonly version: string
  restoreContext(cwd: string, sessionId: string): RestoreContext
}

/** 输入或前置条件不对：直接把消息给用户。 */
class RemoteInputError extends Error {}

function snapId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.startsWith('.')) throw new RemoteInputError('快照 id 不合法')
  return value
}

export class NewsnapRemote {
  readonly typertRemote: { readonly service: object; readonly serviceKey: string; readonly namespace: string }
  /** 不用 #私有字段：Gateway 经 cordis 代理调用方法，this 可能是代理。 */
  readonly deps: RemoteDeps

  constructor(deps: RemoteDeps) {
    this.deps = deps
    this.typertRemote = Object.freeze({ service: this, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE })
  }

  /** 当前会话所在团队的快照（新的在前）与最近一次恢复。不属于团队时 team 为 null。 */
  async list(session: SessionLike): Promise<Outcome<SnapshotsView>> {
    return this.guard('读取', async () => {
      const cwd = session.header.cwd
      const team = cwd === undefined ? undefined : await findTeamOfSession(cwd, session.id)
      if (cwd === undefined || team === undefined) return { team: null, snapshots: [], lastApplied: null }
      const { home } = this.deps
      const listing = await listSnapshots(home, cwd, 'snapshot', team)
      const last = await lastApplied(home, cwd)
      const target = last === undefined ? undefined : listing.items.find((i) => i.manifest.snapId === last.target.id)?.manifest
      return {
        team: { id: team.id, name: team.name },
        snapshots: listing.items.map(({ manifest: m }) => ({
          id: m.snapId, createdAt: m.createdAt, sessions: m.sessions.length,
          ...(m.note !== undefined && { note: m.note }),
          ...(m.openCommand !== undefined && { commandId: m.openCommand.commandId }),
        })),
        lastApplied: last === undefined ? null : {
          kind: last.target.kind,
          target: last.target.id,
          ...(target?.note !== undefined && { note: target.note }),
          ...(target !== undefined && { targetAt: target.createdAt }),
          at: last.result?.at ?? last.createdAt,
          canUndo: last.rescueId !== undefined && await hasRescue(home, cwd, last.rescueId),
        },
      }
    })
  }

  /** 拍照（网页上没有斜杠命令可挂，所以 commandId 为空，书签卡不会出现在对话里）。 */
  async snap(session: SessionLike, note: unknown): Promise<Outcome<{ id: string }>> {
    return this.guard('拍快照', async () => {
      const cwd = this.cwdOf(session)
      const text = typeof note === 'string' ? note.trim().slice(0, 200) : ''
      const m = await takeSnapshot(this.deps.host, {
        home: this.deps.home, cwd, sessionId: session.id,
        ...(text !== '' && { note: text }),
        versions: { newsnap: this.deps.version, node: process.version },
      })
      return { id: m.snapId }
    })
  }

  /** B 确认框要显示的代价。 */
  async preview(session: SessionLike, id: unknown): Promise<Outcome<PreviewView>> {
    return this.guard('恢复', async () => {
      const rctx = this.deps.restoreContext(this.cwdOf(session), session.id)
      const i = await previewRestore(this.deps.host, rctx, { kind: 'snapshot', id: snapId(id) })
      return {
        id: i.target.snapId, createdAt: i.target.createdAt, team: i.target.team.name,
        ...(i.target.note !== undefined && { note: i.target.note }),
        removedSessions: i.removedSessions.length, otherTeams: i.otherTeams,
        relaunches: relaunchesItself(rctx.profile),
      }
    })
  }

  /** 开始恢复：回应发出后宿主退出，辅助进程恢复并（网页、headless）重启。 */
  async restore(session: SessionLike, id: unknown): Promise<Outcome<{ relaunches: boolean }>> {
    return this.guard('恢复', async () => this.start(session, { kind: 'snapshot', id: snapId(id) }))
  }

  /** 撤销最近一次恢复（回到它的救援点）。 */
  async undo(session: SessionLike): Promise<Outcome<{ relaunches: boolean }>> {
    return this.guard('恢复', async () => {
      const cwd = this.cwdOf(session)
      const last = await lastApplied(this.deps.home, cwd)
      if (last?.rescueId === undefined) throw new RemoteInputError('没有可撤销的恢复')
      if (!(await hasRescue(this.deps.home, cwd, last.rescueId))) throw new RemoteInputError(`最近一次恢复的救援点 ${last.rescueId} 已被删除，不能撤销`)
      return this.start(session, { kind: 'rescue', id: last.rescueId })
    })
  }

  private async start(session: SessionLike, target: { kind: 'snapshot' | 'rescue'; id: string }): Promise<{ relaunches: boolean }> {
    const base = this.deps.restoreContext(this.cwdOf(session), session.id)
    const rctx: RestoreContext = { ...base, schedule: (fn) => { setTimeout(() => base.schedule(fn), EXIT_AFTER_REPLY_MS) } }
    await startRestore(this.deps.host, rctx, target)
    return { relaunches: relaunchesItself(rctx.profile) }
  }

  private cwdOf(session: SessionLike): string {
    const cwd = session.header.cwd
    if (cwd === undefined) throw new RemoteInputError('这个会话没有工作区目录')
    return cwd
  }

  private async guard<T>(action: string, fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await fn() }
    } catch (error) {
      const message = error instanceof RemoteInputError ? `newsnap：${error.message}。` : errorText(error, action)
      return { ok: false, message }
    }
  }
}

Object.defineProperty(NewsnapRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
  }),
})

/** 注册 Remote 服务。只有带 Typert Gateway 的 profile（web、桌面）会调到；headless 下无害。 */
export function registerRemote(ctx: Context, deps: RemoteDeps): void {
  const provide = (ctx as unknown as { provide?: (name: string, value: unknown) => unknown }).provide
  if (typeof provide !== 'function') return
  provide.call(ctx, REMOTE_SERVICE_KEY, new NewsnapRemote(deps))
}
