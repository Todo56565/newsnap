import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InvalidManifest, readManifest, readPending, validateManifest, validatePending, writeManifest, writePending,
  type PendingRestore, type SnapManifest,
} from '../../src/core/manifest.ts'
import { newId } from '../../src/core/fsutil.ts'

const manifest: SnapManifest = {
  schema: 1, snapId: 'abc', kind: 'snapshot', createdAt: 1, cwd: '/w',
  team: { id: 'alpha', name: 'Alpha', createdAt: 2 },
  sessions: [{ id: 'cap', cwd: '/w', generation: 'session.v4.jsonl.zstd', size: 10, sha256: 'x', role: 'captain' }],
  agentTeams: [{ path: 'alpha/team.json', type: 'file', size: 1, sha256: 'y', mtimeMs: 3 }],
  retiredTeamMembers: [],
  workspace: { commit: 'deadbeef', mtimes: 'mtimes.json', skipped: [] },
  otherTeams: [], versions: { newsnap: '0.1.0-dev' },
}

const pending: PendingRestore = {
  schema: 1, target: { kind: 'snapshot', id: 'abc' }, status: 'registered', steps: [{ name: 'lock', done: false }],
  relaunch: { execPath: '/node', execArgv: [], argv: ['dsh', '--profile', 'web'], cwd: '/w', profile: 'web' }, createdAt: 5,
}

test('manifest 往返；写前校验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ns-man-'))
  assert.equal(await readManifest(dir), undefined)
  await writeManifest(dir, manifest)
  assert.deepEqual(await readManifest(dir), manifest)
  assert.deepEqual(await readdir(dir), ['manifest.json']) // 没留下临时文件
  await assert.rejects(writeManifest(dir, { ...manifest, sessions: [] }), InvalidManifest)
})

test('manifest 拒绝未知 schema、重复会话、越界路径', () => {
  assert.throws(() => validateManifest({ ...manifest, schema: 2 }), InvalidManifest)
  assert.throws(() => validateManifest({ ...manifest, sessions: [manifest.sessions[0], manifest.sessions[0]] }), /duplicate/)
  assert.throws(
    () => validateManifest({ ...manifest, agentTeams: [{ path: '../x', type: 'dir', mtimeMs: 1 }] }),
    /unsafe/,
  )
})

test('pending 往返与校验', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-pend-'))
  assert.equal(await readPending(root), undefined)
  await writePending(root, pending)
  assert.deepEqual(await readPending(root), pending)
  assert.doesNotThrow(() => validatePending({ ...pending, relaunch: null }))
  assert.throws(() => validatePending({ ...pending, status: 'weird' }), InvalidManifest)
})

test('newId 可按时间排序', () => {
  assert.ok(newId(1000) < newId(2000))
  assert.match(newId(), /^[0-9a-z]{9}-[0-9a-f]{4}$/)
})
