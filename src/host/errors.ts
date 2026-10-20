/**
 * 把操作抛出的错误翻成给用户看的一句中文（斜杠命令和网页界面共用）。
 * @module newsnap/host/errors
 */

import { LockBusy } from '../core/lock.ts'
import { GitMissing } from '../core/shadow-git.ts'
import { RemoveRefused, SnapshotNotFound } from '../core/store.ts'
import { UnsupportedTeamState } from '../core/teams.ts'
import { NotATeamSession, SnapshotBlocked } from './capture.ts'
import { formatBlocked } from './format.ts'
import { RestoreNotFound, RestoreUnsupported } from './restore.ts'

/** @param action - 被拦截时用的动词（「拍快照」「恢复」）。 */
export function errorText(error: unknown, action: string): string {
  if (error instanceof GitMissing) return `newsnap：${error.message}`
  if (error instanceof SnapshotBlocked) return formatBlocked(error.blockers, action)
  if (error instanceof NotATeamSession) return 'newsnap：当前会话不属于任何活动团队。'
  if (error instanceof UnsupportedTeamState) return `newsnap：团队状态格式不认识，拒绝操作（${error.message}）。`
  if (error instanceof LockBusy) return `newsnap：另一项操作正在进行（${error.holder.purpose}）。`
  if (error instanceof RemoveRefused || error instanceof SnapshotNotFound) return `newsnap：${error.message}`
  if (error instanceof RestoreUnsupported || error instanceof RestoreNotFound) return `newsnap：${error.message}`
  return `newsnap 失败：${error instanceof Error ? error.message : String(error)}`
}
