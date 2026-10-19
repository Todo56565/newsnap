/**
 * 快照 manifest 与 pending-restore 的格式、校验、读写（实现设计 §2）。
 * core 层不依赖第三方库，校验手写；读到不认识的 schema 直接拒绝。
 * @module newsnap/core/manifest
 */

import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './fsutil.ts'
import type { TreeEntry } from './tree.ts'

export const MANIFEST_SCHEMA = 1
export const PENDING_SCHEMA = 1
export const MANIFEST_FILE = 'manifest.json'
export const PENDING_FILE = 'pending-restore.json'

export class InvalidManifest extends Error {
  override name = 'InvalidManifest'
}

export interface SnapSession {
  readonly id: string
  /** 会话自己的 cwd（实现设计 §2：apply 用它，不用进程 cwd）；宿主 `_no-cwd` 时为 null。 */
  readonly cwd: string | null
  /** 拍照时选用的代文件名。 */
  readonly generation: string
  readonly size: number
  readonly sha256: string
  /** 角色：captain / member / descendant（以团队会话为祖先的子代理会话）。 */
  readonly role: 'captain' | 'member' | 'descendant'
}

export interface SnapManifest {
  readonly schema: typeof MANIFEST_SCHEMA
  readonly snapId: string
  readonly kind: 'snapshot' | 'rescue'
  /** kind = rescue 时：这是哪次恢复之前的救援点。 */
  readonly restoreOf?: string
  readonly createdAt: number
  readonly note?: string
  /** 工作区（团队所在 cwd）。 */
  readonly cwd: string
  readonly team: { readonly id: string; readonly name: string; readonly createdAt: number }
  readonly sessions: readonly SnapSession[]
  /** `.agent-teams` 相关部分的清单（相对 `<snap>/agent-teams/`）。 */
  readonly agentTeams: readonly TreeEntry[]
  /** retired-members.json 中本队成员 id 的有无（总设计 §2.1）。 */
  readonly retiredTeamMembers: readonly string[]
  readonly workspace: {
    /** 影子仓库里的提交 hash。 */
    readonly commit: string
    /** mtime 清单文件名（相对快照目录）。 */
    readonly mtimes: string
    /** 超过单文件上限而未收录的路径。 */
    readonly skipped: readonly string[]
  }
  /** 拍照时同工作区的其他活动团队 id。 */
  readonly otherTeams: readonly string[]
  readonly versions: Readonly<Record<string, string>>
}

export const RESTORE_STATUSES = ['registered', 'exiting', 'applying', 'applied', 'failed', 'rolled-back'] as const
export type RestoreStatus = (typeof RESTORE_STATUSES)[number]

export interface RestoreStep {
  readonly name: string
  readonly done: boolean
  readonly at?: number
}

export interface RelaunchSpec {
  readonly execPath: string
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
  readonly cwd: string
  readonly profile: string
  /** headless 续接用：重启时加 `--session-id`。 */
  readonly sessionId?: string
}

export interface PendingRestore {
  readonly schema: typeof PENDING_SCHEMA
  /** 目标：快照或救援点（撤销 = 恢复到救援点，实现设计 §4.7）。 */
  readonly target: { readonly kind: 'snapshot' | 'rescue'; readonly id: string }
  readonly rescueId?: string
  readonly status: RestoreStatus
  readonly steps: readonly RestoreStep[]
  /** 不自动重启（桌面端等）时为 null。 */
  readonly relaunch: RelaunchSpec | null
  readonly createdAt: number
  /** 正在执行这次恢复的辅助进程（启动对账判断它是否还活着）。 */
  readonly helperPid?: number
  readonly result?: { readonly ok: boolean; readonly message: string; readonly at: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function need(ok: boolean, what: string): asserts ok {
  if (!ok) throw new InvalidManifest(what)
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

function checkTreeEntry(value: unknown, where: string): void {
  need(isRecord(value) && isStr(value.path) && value.path !== '', `${where}: entry without path`)
  need(!value.path.split('/').some((seg) => seg === '..' || seg === ''), `${where}: unsafe path ${value.path}`)
  if (value.type === 'file') {
    need(isNum(value.size) && isStr(value.sha256) && isNum(value.mtimeMs), `${where}: bad file entry ${value.path}`)
  } else if (value.type === 'dir') {
    need(isNum(value.mtimeMs), `${where}: bad dir entry ${value.path}`)
  } else {
    need(value.type === 'symlink' && isStr(value.target), `${where}: bad entry ${value.path}`)
  }
}

export function validateManifest(value: unknown): SnapManifest {
  need(isRecord(value), 'manifest is not an object')
  need(value.schema === MANIFEST_SCHEMA, `unsupported manifest schema ${JSON.stringify(value.schema)}`)
  need(isStr(value.snapId) && value.snapId !== '', 'snapId missing')
  need(value.kind === 'snapshot' || value.kind === 'rescue', 'kind invalid')
  need(value.restoreOf === undefined || isStr(value.restoreOf), 'restoreOf invalid')
  need(isNum(value.createdAt), 'createdAt missing')
  need(value.helperPid === undefined || isNum(value.helperPid), 'helperPid invalid')
  need(value.note === undefined || isStr(value.note), 'note invalid')
  need(isStr(value.cwd) && value.cwd !== '', 'cwd missing')
  const team = value.team
  need(isRecord(team) && isStr(team.id) && isStr(team.name) && isNum(team.createdAt), 'team invalid')
  need(Array.isArray(value.sessions) && value.sessions.length > 0, 'sessions missing')
  const ids = new Set<string>()
  for (const s of value.sessions) {
    need(
      isRecord(s) && isStr(s.id) && s.id !== '' && (s.cwd === null || isStr(s.cwd)) && isStr(s.generation)
        && isNum(s.size) && isStr(s.sha256)
        && (s.role === 'captain' || s.role === 'member' || s.role === 'descendant'),
      'session entry invalid',
    )
    need(!ids.has(s.id), `duplicate session ${s.id}`)
    ids.add(s.id)
  }
  need(Array.isArray(value.agentTeams), 'agentTeams missing')
  value.agentTeams.forEach((e) => checkTreeEntry(e, 'agentTeams'))
  need(isStrArray(value.retiredTeamMembers), 'retiredTeamMembers invalid')
  const ws = value.workspace
  need(isRecord(ws) && isStr(ws.commit) && isStr(ws.mtimes) && isStrArray(ws.skipped), 'workspace invalid')
  need(isStrArray(value.otherTeams), 'otherTeams invalid')
  need(isRecord(value.versions) && Object.values(value.versions).every(isStr), 'versions invalid')
  return value as unknown as SnapManifest
}

export function validatePending(value: unknown): PendingRestore {
  need(isRecord(value), 'pending is not an object')
  need(value.schema === PENDING_SCHEMA, `unsupported pending schema ${JSON.stringify(value.schema)}`)
  const target = value.target
  need(isRecord(target) && (target.kind === 'snapshot' || target.kind === 'rescue') && isStr(target.id), 'target invalid')
  need(value.rescueId === undefined || isStr(value.rescueId), 'rescueId invalid')
  need(isStr(value.status) && (RESTORE_STATUSES as readonly string[]).includes(value.status), 'status invalid')
  need(Array.isArray(value.steps), 'steps missing')
  for (const step of value.steps) {
    need(isRecord(step) && isStr(step.name) && typeof step.done === 'boolean' && (step.at === undefined || isNum(step.at)), 'step invalid')
  }
  const r = value.relaunch
  need(
    r === null || (isRecord(r) && isStr(r.execPath) && isStrArray(r.execArgv) && isStrArray(r.argv) && isStr(r.cwd) && isStr(r.profile) && (r.sessionId === undefined || isStr(r.sessionId))),
    'relaunch invalid',
  )
  need(isNum(value.createdAt), 'createdAt missing')
  need(value.helperPid === undefined || isNum(value.helperPid), 'helperPid invalid')
  const res = value.result
  need(res === undefined || (isRecord(res) && typeof res.ok === 'boolean' && isStr(res.message) && isNum(res.at)), 'result invalid')
  return value as unknown as PendingRestore
}

/** newsnap 根目录下的固定布局（实现设计 §2）。 */
export function layout(root: string) {
  return {
    root,
    repo: join(root, 'repo.git'),
    snaps: join(root, 'snaps'),
    rescue: join(root, 'rescue'),
    pending: join(root, PENDING_FILE),
    lock: join(root, 'lock'),
    history: join(root, 'history'),
    snapDir: (id: string) => join(root, 'snaps', id),
    rescueDir: (id: string) => join(root, 'rescue', id),
  }
}

export async function readManifest(dir: string): Promise<SnapManifest | undefined> {
  const raw = await readJson(join(dir, MANIFEST_FILE))
  return raw === undefined ? undefined : validateManifest(raw)
}

/** 写 manifest 是快照成立的最后一步（总设计 §3.4）。写前先校验，避免写出读不回的文件。 */
export async function writeManifest(dir: string, manifest: SnapManifest): Promise<void> {
  validateManifest(manifest)
  await writeJsonAtomic(join(dir, MANIFEST_FILE), manifest)
}

export async function readPending(root: string): Promise<PendingRestore | undefined> {
  const raw = await readJson(layout(root).pending)
  return raw === undefined ? undefined : validatePending(raw)
}

export async function writePending(root: string, pending: PendingRestore): Promise<void> {
  validatePending(pending)
  await writeJsonAtomic(layout(root).pending, pending)
}
