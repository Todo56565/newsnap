/**
 * 斜杠命令输出的文本格式。
 * @module newsnap/host/format
 */

import type { SnapManifest } from '../core/manifest.ts'
import type { Blocker } from '../core/preflight.ts'
import type { Listing } from '../core/store.ts'
import type { TeamSummary } from '../core/teams.ts'

const REASONS: Record<Blocker['kind'], string> = {
  'task-in-progress': '有进行中的任务',
  'mail-in-flight': '有投递中的信',
  'merge-running': 'workspace 合并进行中',
  'session-busy': '有会话正在运行',
  'restore-pending': '有已登记、未完成的恢复',
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function formatSnapshot(m: SnapManifest): string {
  const lines = [
    `已拍快照 ${m.snapId}（团队 ${m.team.name}，${m.sessions.length} 个会话${m.note === undefined ? '' : `，备注：${m.note}`}）。`,
  ]
  if (m.workspace.skipped.length > 0) {
    lines.push(`以下文件超过大小上限，未收录：${m.workspace.skipped.join('、')}`)
  }
  return lines.join('\n')
}

export function formatBlocked(blockers: readonly Blocker[]): string {
  const groups = new Map<Blocker['kind'], string[]>()
  for (const b of blockers) groups.set(b.kind, [...(groups.get(b.kind) ?? []), b.detail])
  const parts = [...groups].map(([kind, details]) => `${REASONS[kind]}（${details.join('、')}）`)
  return `现在不能拍快照：${parts.join('；')}。等团队空闲后再试。`
}

export function formatList(team: TeamSummary, listing: Listing): string {
  if (listing.items.length === 0) return `团队 ${team.name} 还没有快照。`
  const lines = [`团队 ${team.name} 的快照（新的在前）：`]
  for (const { manifest: m, sessionBytes } of listing.items) {
    lines.push(`- ${m.snapId}  ${formatTime(m.createdAt)}  ${m.sessions.length} 个会话  ${size(sessionBytes)}${m.note === undefined ? '' : `  ${m.note}`}`)
  }
  if (listing.broken.length > 0) lines.push(`读不出的快照目录：${listing.broken.join('、')}`)
  return lines.join('\n')
}
