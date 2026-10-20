import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureSnapshot } from '../../src/core/capture.ts'
import { NewsnapRemote, REMOTE_NAMESPACE, REMOTE_SERVICE_KEY } from '../../src/host/remote.ts'
import type { HostRuntime } from '../../src/host/capture.ts'
import type { RestoreContext } from '../../src/host/restore.ts'
import { world } from '../helpers/world.ts'

const idle: HostRuntime = { agentStatus: () => 'idle', flush: async () => undefined, freeze: () => () => undefined }

function remote(home: string, calls: string[] = []): NewsnapRemote {
  return new NewsnapRemote({
    home, host: idle, version: 'test',
    restoreContext: (cwd, sessionId): RestoreContext => ({
      home, cwd, sessionId, profile: 'web',
      appExit: (code) => calls.push(`exit ${code}`),
      relaunch: { execPath: '/usr/bin/node', execArgv: [], argv: ['/x/dsh', '--profile', 'web'], cwd: '/x' },
      spawnHelper: (mode) => (calls.push(`helper ${mode}`), 1),
      schedule: (fn) => (calls.push('scheduled'), fn()),
    }),
  })
}

test('Remote：原型带 Typert SRC 描述符，绑定指向自身，方法参数名以 session 开头', () => {
  const r = remote('/nowhere')
  const d = Object.getOwnPropertyDescriptor(NewsnapRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods')?.value as { version: number; methods: { method: string; invocation: { kind: string } }[] }
  assert.equal(d.version, 1)
  assert.deepEqual(d.methods.map((m) => m.method), ['list', 'snap', 'preview', 'restore', 'undo'])
  assert.ok(d.methods.every((m) => m.invocation.kind === 'direct'))
  assert.deepEqual(r.typertRemote, { service: r, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE })
  // Gateway 的 SRC 回退从函数源码读参数名
  for (const m of d.methods) {
    const src = String((NewsnapRemote.prototype as unknown as Record<string, () => unknown>)[m.method])
    assert.match(src, new RegExp(`^async ${m.method}\\(session\\b`))
  }
})

test('Remote list：团队会话列出快照与 commandId；非团队会话 team 为 null；不抛错', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1', note: '第一张', openCommand: { sessionId: 'cap', commandId: 'cmd-1', text: 'x' } })
  const r = remote(home)
  const got = await r.list({ id: 'cap', header: { cwd } })
  assert.ok(got.ok)
  assert.equal(got.value.team?.id, team.id)
  assert.deepEqual(got.value.snapshots.map((s) => [s.id, s.note, s.commandId]), [['s1', '第一张', 'cmd-1']])
  assert.equal(got.value.lastApplied, null)
  const none = await r.list({ id: 'stranger', header: { cwd } })
  assert.ok(none.ok && none.value.team === null)
  const nocwd = await r.list({ id: 'cap', header: {} })
  assert.ok(nocwd.ok && nocwd.value.team === null)
})

test('Remote preview/restore：非法 id 返回消息而不是抛错；restore 回应后才安排退出', async () => {
  const { home, cwd, team } = await world()
  await captureSnapshot({ home, cwd, team, id: 's1' })
  const calls: string[] = []
  const r = remote(home, calls)
  const bad = await r.preview({ id: 'cap', header: { cwd } }, '../x')
  assert.ok(!bad.ok && /不合法/.test(bad.message))
  const missing = await r.preview({ id: 'cap', header: { cwd } }, 'nope')
  assert.ok(!missing.ok)
  const p = await r.preview({ id: 'cap', header: { cwd } }, 's1')
  assert.ok(p.ok && p.value.relaunches && p.value.otherTeams.includes('beta'))
  const started = await r.restore({ id: 'cap', header: { cwd } }, 's1')
  assert.ok(started.ok)
  assert.deepEqual(calls, ['helper apply'])
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(calls, ['helper apply', 'scheduled', 'exit 0'])
  const undo = await r.undo({ id: 'cap', header: { cwd } })
  assert.ok(!undo.ok)
})
