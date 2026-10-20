import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRepo, gitCandidates, GitMissing, resolveGit } from '../../src/core/shadow-git.ts'

test('B1：找不到 git 时抛中文 GitMissing，且不留下空的 repo.git；装好后可重试', async () => {
  assert.deepEqual(gitCandidates({ NEWSNAP_GIT: '/g' }, 'linux'), ['/g', 'git'])
  assert.ok(gitCandidates({ ProgramFiles: 'C:\\PF' }, 'win32').some((c) => c.includes('Git') && c.endsWith('git.exe')))
  const savedPath = process.env.PATH
  process.env.PATH = '/nonexistent'
  process.env.NEWSNAP_GIT = '/nonexistent/git'
  const dir = await mkdtemp(join(tmpdir(), 'ns-nogit-'))
  try {
    await assert.rejects(resolveGit(), (e: unknown) => e instanceof GitMissing && /未找到 git/.test(e.message))
    await assert.rejects(ensureRepo(join(dir, 'repo.git')), GitMissing)
    assert.deepEqual(await readdir(dir), [])
  } finally {
    process.env.PATH = savedPath
    delete process.env.NEWSNAP_GIT
  }
  assert.equal(await resolveGit(), 'git')
})
