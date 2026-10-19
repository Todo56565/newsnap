/**
 * 启动对账（实现设计 §4.5）：插件 apply 时看每个工作区根下的 pending-restore.json，
 * 把结果变成要告诉用户的提示，已结束的登记归档。M5 之前提示经日志与 `/newsnap status` 给出。
 * @module newsnap/host/reconcile
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { archivePending } from '../core/apply.ts'
import { layout, readManifest, readPending, writePending } from '../core/manifest.ts'
import { pidAlive } from '../core/lock.ts'
import { cleanupPartials } from '../core/store.ts'
import { allRoots } from './restore.ts'

export interface Notice {
  readonly cwd: string
  readonly level: 'info' | 'warn'
  readonly text: string
}

/** 工作区根对应的 cwd：从任意一份 manifest 里读（根目录名是编码过的 cwd，不一定可逆）。 */
async function rootCwd(root: string): Promise<string | undefined> {
  const L = layout(root)
  for (const base of [L.snaps, L.rescue]) {
    let names: string[] = []
    try {
      names = await readdir(base)
    } catch {
      continue
    }
    for (const name of names) {
      const m = await readManifest(join(base, name)).catch(() => undefined)
      if (m !== undefined) return m.cwd
    }
  }
  return undefined
}

export async function reconcile(home: string, now: () => number = Date.now): Promise<Notice[]> {
  const notices: Notice[] = []
  for (const root of await allRoots(home)) {
    const cwd = await rootCwd(root)
    if (cwd === undefined) continue
    await cleanupPartials(home, cwd).catch(() => undefined)
    let pending
    try {
      pending = await readPending(root)
    } catch (error) {
      notices.push({ cwd, level: 'warn', text: `恢复登记文件读不出（${error instanceof Error ? error.message : String(error)}），请运行 newsnap doctor。` })
      continue
    }
    if (pending === undefined) continue
    const what = `${pending.target.kind === 'snapshot' ? '快照' : '救援点'} ${pending.target.id}`
    const helperAlive = pending.helperPid !== undefined && pidAlive(pending.helperPid)
    switch (pending.status) {
      case 'applied':
        notices.push({ cwd, level: 'info', text: `已恢复到${what}。恢复前的状态在救援点 ${pending.rescueId}，/newsnap undo 可撤销。` })
        await archivePending(home, cwd)
        break
      case 'failed':
      case 'rolled-back':
        notices.push({ cwd, level: 'warn', text: `恢复到${what}没有成功：${pending.result?.message ?? '原因不明'}。现场保持恢复前的样子。` })
        await archivePending(home, cwd)
        break
      case 'registered':
      case 'exiting':
        if (helperAlive) {
          notices.push({ cwd, level: 'warn', text: `恢复到${what}正在等待 DSH 退出（辅助进程 ${pending.helperPid}）。` })
        } else {
          await writePending(root, { ...pending, status: 'failed', result: { ok: false, message: 'restore was not performed (helper did not run)', at: now() } })
          await archivePending(home, cwd)
          notices.push({ cwd, level: 'warn', text: `恢复到${what}没有执行（辅助进程没起来或 DSH 没退出），什么都没改。` })
        }
        break
      case 'applying':
        notices.push(helperAlive
          ? { cwd, level: 'warn', text: `恢复到${what}正在进行（辅助进程 ${pending.helperPid}），请先不要操作这个团队。` }
          : { cwd, level: 'warn', text: `恢复到${what}中途停下了。用 /newsnap resume 续做，或 /newsnap rollback 回到恢复前；在这之前不要让团队继续工作。` })
        break
    }
  }
  return notices
}
