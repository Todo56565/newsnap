import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureSnapshot } from '../../src/core/capture.ts'
import { readPending, writePending, layout } from '../../src/core/manifest.ts'
import { newsnapRoot } from '../../src/core/paths.ts'
import { relaunchCommand } from '../../src/core/relaunch.ts'
import { runHelper } from '../../src/helper/helper.ts'
import { reconcile } from '../../src/host/reconcile.ts'
import { previewRestore, startRestore, RestoreUnsupported, type RestoreContext } from '../../src/host/restore.ts'
import { SnapshotBlocked, type HostRuntime } from '../../src/host/capture.ts'
import { world, writeSession } from '../helpers/world.ts'

const idle: HostRuntime = { agentStatus: () => 'idle', flush: async () => undefined, freeze: () => () => undefined }

function rctx(home: string, cwd: string, over: Partial<RestoreContext> = {}): RestoreContext & { calls: string[] } {
  const calls: string[] = []
  return {
    home, cwd, sessionId: 'cap', profile: 'web',
    appExit: (code) => calls.push(`exit ${code}`),
    relaunch: { execPath: '/usr/bin/node', execArgv: [], argv: ['/x/dsh', '--profile', 'web', '--port', '8790'], cwd: '/x' },
    spawnHelper: (mode) => (calls.push(`helper ${mode}`), 123),
    schedule: (fn) => (calls.push('scheduled'), fn()),
    ...over, calls,
  }
}

test('relaunchCommand：web 加 --no-open（--port 0 除外）；headless 换任务文本并加 --session-id', () => {
  const base = { execPath: '/n', execArgv: ['--x'], cwd: '/c' }
  assert.deepEqual(relaunchCommand({ ...base, argv: ['/d', '--profile', 'web'], profile: 'web' }, 'm').args, ['--x', '/d', '--profile', 'web', '--no-open'])
  assert.deepEqual(relaunchCommand({ ...base, argv: ['/d', '--port', '0'], profile: 'web' }, 'm').args, ['--x', '/d', '--port', '0'])
  const h = relaunchCommand({ ...base, argv: ['/d', '--profile', 'headless', '--json', 'do things'], profile: 'headless', sessionId: 's1' }, 'restored')
  assert.deepEqual(h.args.slice(0, 7), ['--x', '/d', '--profile', 'headless', '--json', '--session-id', 's1'])
  assert.match(h.args[7]!, /restored/)
})

test('previewRestore：显示新增会话与其他团队；desktop 拒绝；有运行中会话拒绝', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  await writeSession(home, cwd, 'sub9', 'cap')
  const impact = await previewRestore(idle, rctx(home, cwd), { kind: 'snapshot', id: 's1' })
  assert.deepEqual(impact.removedSessions, ['sub9'])
  assert.deepEqual(impact.otherTeams, ['beta'])
  await assert.rejects(previewRestore(idle, rctx(home, cwd, { profile: 'desktop' }), { kind: 'snapshot', id: 's1' }), RestoreUnsupported)
  const busy: HostRuntime = { ...idle, agentStatus: (id) => (id === 'm1' ? 'running' : 'idle') }
  await assert.rejects(previewRestore(busy, rctx(home, cwd), { kind: 'snapshot', id: 's1' }), SnapshotBlocked)
  // 调用者自己的会话不算
  const self: HostRuntime = { ...idle, agentStatus: (id) => (id === 'cap' ? 'running' : 'idle') }
  await previewRestore(self, rctx(home, cwd), { kind: 'snapshot', id: 's1' })
})

test('startRestore 登记 exiting、拉起辅助进程、安排退出；辅助进程等父进程退出后 apply；对账归档', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  await writeFile(join(cwd, 'main.ts'), 'changed')
  const c = rctx(home, cwd)
  await startRestore(idle, c, { kind: 'snapshot', id: 's1' })
  assert.deepEqual(c.calls, ['helper apply', 'scheduled', 'exit 0'])
  const root = newsnapRoot(home, cwd)
  const p = (await readPending(root))!
  assert.equal(p.status, 'exiting')
  assert.equal(p.relaunch?.profile, 'web')
  // 不自动重启，只测 apply：去掉 relaunch
  await writePending(root, { ...p, relaunch: null })
  const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300)'])
  const code = await runHelper(home, cwd, parent.pid!, 'apply', 5000)
  assert.equal(code, 0)
  assert.equal(await readFile(join(cwd, 'main.ts'), 'utf8'), 'code')
  assert.equal((await readPending(root))?.status, 'applied')
  assert.match(await readFile(join(root, 'helper.log'), 'utf8'), /DSH exited after/)
  const notices = await reconcile(home)
  assert.equal(notices.length, 1)
  assert.match(notices[0]!.text, /已恢复到快照 s1/)
  assert.equal(await readPending(root), undefined)
  assert.equal((await readdir(layout(root).history)).length, 1)
})

test('对账：exiting 但辅助进程已不在 → 标记未执行并归档；applying → 提示续做', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  const root = newsnapRoot(home, cwd)
  const base = { schema: 1 as const, target: { kind: 'snapshot' as const, id: 's1' }, steps: [], relaunch: null, createdAt: 1, helperPid: 999999 }
  await writePending(root, { ...base, status: 'exiting' })
  let n = await reconcile(home)
  assert.match(n[0]!.text, /没有执行/)
  assert.equal(await readPending(root), undefined)
  await writePending(root, { ...base, status: 'applying', createdAt: 2 })
  n = await reconcile(home)
  assert.match(n[0]!.text, /resume/)
  assert.equal((await readPending(root))?.status, 'applying')
})
