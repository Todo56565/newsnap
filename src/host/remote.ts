/**
 * M5-0 PoC：经 DSH Typert Gateway 的 SRC 回退暴露 Remote 方法 `newsnap/<method>`，给网页客户端模块读。
 *
 * - 不用装饰器语法（项目是 strip-types，不支持），也不在运行时 import typert-protocol：
 *   直接按协议的稳定格式写原型上的方法描述符（`@deepseek-ai/dsh-typert-protocol/remote-methods`，version 1），
 *   再挂可见的 `typertRemote` 绑定 `{ service, serviceKey, namespace }`，用 `ctx.provide` 注册成服务。
 * - Gateway 没有严格描述符时按 SRC 回退：从函数源码读参数名，名为 `session` 的参数按 lookup 解析成 Session。
 * - 客户端 `ctx.remote` 不挂 SRC 描述符，所以客户端直接用 `connection.rpc.call('/api', 'newsnap/list', { args })`。
 * @module newsnap/host/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { lastApplied } from '../core/apply.ts'
import { hasRescue, listSnapshots } from '../core/store.ts'
import { findTeamOfSession } from '../core/teams.ts'

export const REMOTE_SERVICE_KEY = 'newsnapRemote'
export const REMOTE_NAMESPACE = 'newsnap'
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Remote 收到的 Session（lookup 解析出的对象），只用到 header。 */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

export interface SnapshotRow {
  readonly id: string
  readonly createdAt: number
  readonly note?: string
  readonly sessions: number
  readonly kind: 'snapshot' | 'rescue'
}

export interface SnapshotsView {
  readonly cwd: string | null
  readonly team: { readonly id: string; readonly name: string } | null
  readonly snapshots: SnapshotRow[]
  readonly lastApplied: { readonly target: string; readonly at: number; readonly canUndo: boolean } | null
}

export class NewsnapRemote {
  readonly typertRemote: { readonly service: object; readonly serviceKey: string; readonly namespace: string }
  /** 不用 #私有字段：Gateway 经 cordis 代理调用方法，this 可能是代理。 */
  readonly home: string

  constructor(home: string) {
    this.home = home
    this.typertRemote = Object.freeze({ service: this, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE })
  }

  /** 当前会话所在团队的快照（新的在前）与最近一次恢复。参数名必须叫 session（SRC lookup 按名字匹配）。 */
  async list(session: SessionLike): Promise<SnapshotsView> {
    const cwd = session.header.cwd
    if (cwd === undefined) return { cwd: null, team: null, snapshots: [], lastApplied: null }
    const home = this.home
    const team = await findTeamOfSession(cwd, session.id)
    const listing = team === undefined ? { items: [] } : await listSnapshots(home, cwd, 'snapshot', team)
    const last = await lastApplied(home, cwd)
    return {
      cwd,
      team: team === undefined ? null : { id: team.id, name: team.name },
      snapshots: listing.items.map(({ manifest: m }) => ({
        id: m.snapId, createdAt: m.createdAt, sessions: m.sessions.length, kind: m.kind,
        ...(m.note !== undefined && { note: m.note }),
      })),
      lastApplied: last === undefined ? null : {
        target: last.target.id,
        at: last.result?.at ?? last.createdAt,
        canUndo: last.rescueId !== undefined && await hasRescue(home, cwd, last.rescueId),
      },
    }
  }
}

Object.defineProperty(NewsnapRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([Object.freeze({ method: 'list', invocation: Object.freeze({ kind: 'direct' }) })]),
  }),
})

/** 注册 Remote 服务。只有带 Typert Gateway 的 profile（web、桌面）会用到；headless 下无害。 */
export function registerRemote(ctx: Context, home: string): void {
  const provide = (ctx as unknown as { provide?: (name: string, value: unknown) => unknown }).provide
  if (typeof provide !== 'function') return
  provide.call(ctx, REMOTE_SERVICE_KEY, new NewsnapRemote(home))
}
