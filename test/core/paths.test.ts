import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  currentGeneration, encodeSegment, listGenerations, parseGeneration, projectKey, resolveDshHome, sessionDir,
} from '../../src/core/paths.ts'

test('encodeSegment 与宿主规则一致', () => {
  assert.equal(encodeSegment('session-abc_1.2'), 'session-abc_1.2')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('~'), '~007E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.throws(() => encodeSegment(''))
})

test('projectKey 合并分隔符、去前导、加 -- 包裹', () => {
  assert.equal(projectKey('/workspace/work/hl-tb'), '--workspace-work-hl-tb--')
  assert.equal(projectKey('C:\\Users\\me\\proj'), '--C-Users-me-proj--')
  assert.equal(projectKey('/'), '--root--')
  assert.equal(projectKey('/a b'), '--a~0020b--')
  assert.equal(projectKey('/' + 'x'.repeat(300)).length, 255)
})

test('与真实 DSH 目录对得上（hl-tb 测试 home）', () => {
  // /workspace/work/hl-tb/home/sessions/--workspace-work-hl-tb--/session-…/ 由 DSH rc.2 生成
  assert.equal(
    sessionDir('/h', '/workspace/work/hl-tb', 'session-f9488b4f'),
    '/h/sessions/--workspace-work-hl-tb--/session-f9488b4f',
  )
  assert.equal(sessionDir('/h', undefined, 's'), '/h/sessions/_no-cwd/s')
})

test('resolveDshHome', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/x/y' }), '/x/y')
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({}), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '~/d' }), join(homedir(), 'd'))
})

test('parseGeneration 只认规范代文件名', () => {
  assert.deepEqual(parseGeneration('session.jsonl'), { file: 'session.jsonl', version: 0, compression: 'none' })
  assert.deepEqual(parseGeneration('session.v4.jsonl.zstd'), { file: 'session.v4.jsonl.zstd', version: 4, compression: 'zstd' })
  for (const bad of ['session.v0.jsonl', 'session.v04.jsonl', 'Session.jsonl', 'session.v4.jsonl.tmp', 'session.lock']) {
    assert.equal(parseGeneration(bad), undefined, bad)
  }
})

test('currentGeneration 取最高版本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ns-gen-'))
  assert.equal(await currentGeneration(join(dir, 'nope')), undefined)
  await mkdir(dir, { recursive: true })
  for (const f of ['session.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v12.jsonl.zstd', 'session.lock']) await writeFile(join(dir, f), '')
  assert.equal((await currentGeneration(dir))?.file, 'session.v12.jsonl.zstd')
  assert.equal((await listGenerations(dir)).length, 3)
})
