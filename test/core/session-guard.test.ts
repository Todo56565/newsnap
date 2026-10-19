import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBusy, semaphoreGuard, win32LockName, type Win32SemaphoreApi } from '../../src/core/session-guard.ts'

test('Windows 信号量守卫：名字与 DSH 一致；被占时抛 SessionBusy；释放后可再拿', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const dir = await mkdtemp(j(tmpdir(), 'ns-sem-'))
  const expect = `Local\\dsh-session-lock-${createHash('sha256').update(j(dir, 'session.lock').toLowerCase()).digest('hex')}`
  assert.equal(win32LockName(j(dir, 'session.lock')), expect)
  const counts = new Map<string, number>()
  const handles = new Map<number, string>()
  let next = 1
  const api: Win32SemaphoreApi = {
    createSemaphoreW: (_s, initial, _m, name) => { if (!counts.has(name)) counts.set(name, initial); handles.set(next, name); return next++ },
    waitForSingleObject: (h) => { const n = handles.get(h)!; const c = counts.get(n)!; if (c > 0) { counts.set(n, c - 1); return 0 } return 0x102 },
    releaseSemaphore: (h) => { const n = handles.get(h)!; counts.set(n, counts.get(n)! + 1); return 1 },
    closeHandle: (h) => (handles.delete(h), 1),
    getLastError: () => 0,
  }
  const g = semaphoreGuard(api)
  const release = await g.acquire(dir)
  await assert.rejects(g.acquire(dir), SessionBusy)
  await release()
  await (await g.acquire(dir))()
  assert.equal(handles.size, 0)
})
