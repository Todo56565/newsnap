import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, stat, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyTree, isClean, restoreMtimes, scanTree, verifyTree } from '../../src/core/tree.ts'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ns-tree-'))
  await mkdir(join(root, 'a/b'), { recursive: true })
  await mkdir(join(root, 'empty'))
  await writeFile(join(root, 'a/b/c.txt'), 'hello')
  await writeFile(join(root, 'top.json'), '{}')
  await symlink('a/b/c.txt', join(root, 'link'))
  await utimes(join(root, 'a/b/c.txt'), 1_600_000_000.123, 1_600_000_000.123)
  await utimes(join(root, 'empty'), 1_500_000_000, 1_500_000_000)
  return root
}

test('scanTree 有序、含目录与符号链接、不跟随链接', async () => {
  const root = await fixture()
  const entries = await scanTree(root)
  assert.deepEqual(entries.map((e) => `${e.type}:${e.path}`), [
    'dir:a', 'dir:a/b', 'file:a/b/c.txt', 'dir:empty', 'symlink:link', 'file:top.json',
  ])
  const c = entries.find((e) => e.path === 'a/b/c.txt')
  assert.ok(c?.type === 'file' && c.size === 5 && c.sha256.length === 64)
  assert.deepEqual(await scanTree(join(root, 'missing')), [])
  assert.deepEqual((await scanTree(root, { exclude: (p) => p === 'a' })).map((e) => e.path), ['empty', 'link', 'top.json'])
})

test('copyTree 复制内容与 mtime，verifyTree 通过', async () => {
  const src = await fixture()
  const entries = await scanTree(src)
  const dst = join(await mkdtemp(join(tmpdir(), 'ns-dst-')), 'copy')
  await mkdir(dst)
  await writeFile(join(dst, 'stale'), 'x') // 复制前整体清掉
  await copyTree(src, dst, entries)
  assert.ok(isClean(await verifyTree(dst, entries, { checkMtime: true })))
  // utimes 以秒为单位的浮点往返，会丢亚微秒精度（MTIME_TOLERANCE_MS）
  assert.ok(Math.abs((await stat(join(dst, 'a/b/c.txt'))).mtimeMs - (await stat(join(src, 'a/b/c.txt'))).mtimeMs) < 0.01)
  assert.equal(await readFile(join(dst, 'link'), 'utf8'), 'hello')
})

test('verifyTree 报告缺失、多余、改动、mtime', async () => {
  const root = await fixture()
  const entries = await scanTree(root)
  await rm(join(root, 'top.json'))
  await writeFile(join(root, 'new.txt'), 'n')
  await writeFile(join(root, 'a/b/c.txt'), 'HELLO')
  await utimes(join(root, 'empty'), 1_700_000_000, 1_700_000_000)
  const diff = await verifyTree(root, entries, { checkMtime: true })
  assert.deepEqual(diff.missing, ['top.json'])
  assert.deepEqual(diff.extra, ['new.txt'])
  assert.deepEqual(diff.changed, ['a/b/c.txt'])
  assert.ok(diff.mtime.includes('empty'))
})

test('restoreMtimes 写回并跳过不存在的条目', async () => {
  const root = await fixture()
  const entries = await scanTree(root)
  await writeFile(join(root, 'a/b/c.txt'), 'hello') // 内容相同、mtime 变
  await rm(join(root, 'top.json'))
  await restoreMtimes(root, entries)
  const diff = await verifyTree(root, entries.filter((e) => e.path !== 'top.json'), { checkMtime: true })
  assert.ok(isClean(diff), JSON.stringify(diff))
})
