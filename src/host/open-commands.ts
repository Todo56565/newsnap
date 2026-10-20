/**
 * 恢复后补记悬空的斜杠命令（测试报告 B4）。
 * `/newsnap snap` 是在命令处理函数里拍的：DSH 先写 `command/run`，处理函数返回后才写 `command/done`，
 * 所以快照里的会话日志总以一条没收尾的 run 结尾。恢复到这份快照后，界面会一直显示「执行中」。
 * 插件在新宿主里等那个会话加载，用宿主自己的 `session.append` 补一条配对的 `command/done`；
 * 每次恢复（以救援点 id 区分）只补一次，记在 `<root>/closed-commands.json`。
 * @module newsnap/host/open-commands
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { lastAppliedIn } from '../core/apply.ts'
import { layout, readManifest } from '../core/manifest.ts'
import { formatSnapshot } from './format.ts'
import { allRoots } from './restore.ts'

export interface OpenCommandFix {
  readonly root: string
  /** 这次恢复的救援点 id：同一份快照再次恢复时 key 不同，会再补一次。 */
  readonly key: string
  readonly sessionId: string
  readonly commandId: string
  readonly text: string
}

const CLOSED_FILE = 'closed-commands.json'

async function readClosed(root: string): Promise<string[]> {
  try {
    const v = JSON.parse(await readFile(join(root, CLOSED_FILE), 'utf8')) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 列出所有工作区里「最近一次恢复到快照、快照带着悬空命令、还没补记」的项。 */
export async function pendingCommandFixes(home: string): Promise<OpenCommandFix[]> {
  const out: OpenCommandFix[] = []
  for (const root of await allRoots(home)) {
    try {
      const last = await lastAppliedIn(root)
      if (last === undefined || last.target.kind !== 'snapshot' || last.rescueId === undefined) continue
      const manifest = await readManifest(layout(root).snapDir(last.target.id))
      const oc = manifest?.openCommand
      if (manifest === undefined || oc === undefined) continue
      if ((await readClosed(root)).includes(last.rescueId)) continue
      out.push({ root, key: last.rescueId, sessionId: oc.sessionId, commandId: oc.commandId, text: formatSnapshot(manifest) })
    } catch {
      // 读不了就不补；最坏情况是界面显示「执行中」，发一条消息即可盖过
    }
  }
  return out
}

/** 记下这次恢复的悬空命令已补记。只留最近 50 条。 */
export async function markCommandClosed(root: string, key: string): Promise<void> {
  const list = (await readClosed(root)).filter((k) => k !== key)
  list.push(key)
  const path = join(root, CLOSED_FILE)
  await writeFile(`${path}.tmp`, JSON.stringify(list.slice(-50)))
  await rename(`${path}.tmp`, path)
}
