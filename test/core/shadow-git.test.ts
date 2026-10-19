import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitFiles, git, listWorkspace, restoreWorkspace, snapshotWorkspace, workspaceMatches } from '../../src/core/shadow-git.ts'

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'ns-git-'))
  const cwd = join(base, 'ws')
  const repoDir = join(base, 'repo.git')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await git(['init', '-q', cwd])
  await writeFile(join(cwd, '.gitignore'), 'build/\n*.log\n')
  await writeFile(join(cwd, 'src/a.ts'), 'export const a = 1\n')
  await writeFile(join(cwd, 'run.sh'), '#!/bin/sh\n')
  await chmod(join(cwd, 'run.sh'), 0o755)
  await git(['-C', cwd, 'add', '-A'])
  await git(['-C', cwd, 'commit', '-qm', 'init'])
  await writeFile(join(cwd, 'untracked.md'), 'u\n')
  await writeFile(join(cwd, 'crlf.txt'), 'a\r\nb\r\n')
  await mkdir(join(cwd, 'build'))
  await writeFile(join(cwd, 'build/out.js'), 'ignored')
  await writeFile(join(cwd, 'big.bin'), Buffer.alloc(2048))
  await symlink('src/a.ts', join(cwd, 'link'))
  await mkdir(join(cwd, '.agent-teams/t'), { recursive: true })
  await writeFile(join(cwd, '.agent-teams/t/team.json'), '{}')
  await writeFile(join(cwd, '.git/info/exclude'), 'secret.txt\n')
  await writeFile(join(cwd, 'secret.txt'), 's')
  // 嵌套仓库，带自己的忽略规则
  await mkdir(join(cwd, 'vendor/lib'), { recursive: true })
  await git(['init', '-q', join(cwd, 'vendor/lib')])
  await writeFile(join(cwd, 'vendor/lib/.gitignore'), 'tmp/\n')
  await writeFile(join(cwd, 'vendor/lib/x.c'), 'int x;\n')
  await mkdir(join(cwd, 'vendor/lib/tmp'))
  await writeFile(join(cwd, 'vendor/lib/tmp/junk'), 'j')
  await utimes(join(cwd, 'src/a.ts'), 1_600_000_000, 1_600_000_000)
  return { cwd, repoDir }
}

test('listWorkspace 收录规则', async () => {
  const { cwd, repoDir } = await setup()
  const { files, skipped } = await listWorkspace(cwd, repoDir, 1024)
  const paths = files.map((f) => f.path)
  assert.deepEqual(paths, [
    '.gitignore', 'crlf.txt', 'link', 'run.sh', 'src/a.ts', 'untracked.md',
    'vendor/lib/.gitignore', 'vendor/lib/x.c',
  ])
  assert.deepEqual(skipped, ['big.bin'])
  assert.equal(files.find((f) => f.path === 'run.sh')?.mode, '100755')
  assert.equal(files.find((f) => f.path === 'link')?.mode, '120000')
})

test('拍照 → 改动 → 还原：exact 语义、mtime、不碰用户 .git', async () => {
  const { cwd, repoDir } = await setup()
  const userHead = await readFile(join(cwd, '.git/HEAD'), 'utf8')
  const userIndexMtime = (await stat(join(cwd, '.git/index'))).mtimeMs
  const snap = await snapshotWorkspace({ cwd, repoDir, ref: 's1', maxFileBytes: 1024 })
  assert.ok((await commitFiles(repoDir, snap.commit)).includes('vendor/lib/x.c'))
  assert.equal(await git(['--git-dir', repoDir, 'rev-parse', 'refs/newsnap/s1']).then((s) => s.trim()), snap.commit)
  assert.ok(await workspaceMatches({ cwd, repoDir, commit: snap.commit, maxFileBytes: 1024 }))

  // 快照之后的改动
  await writeFile(join(cwd, 'src/a.ts'), 'export const a = 2\n')
  await rm(join(cwd, 'untracked.md'))
  await mkdir(join(cwd, 'src/new'), { recursive: true })
  await writeFile(join(cwd, 'src/new/b.ts'), 'b')
  await writeFile(join(cwd, 'build/out2.js'), 'ignored too')
  await writeFile(join(cwd, 'app.log'), 'log')
  await rm(join(cwd, 'link'))
  await writeFile(join(cwd, 'link'), 'now a file')
  await writeFile(join(cwd, 'crlf.txt'), 'changed')
  assert.equal(await workspaceMatches({ cwd, repoDir, commit: snap.commit, maxFileBytes: 1024 }), false)

  const result = await restoreWorkspace({ cwd, repoDir, commit: snap.commit, mtimes: snap.mtimes, maxFileBytes: 1024 })
  assert.deepEqual(result.deleted, ['src/new/b.ts'])
  assert.ok(await workspaceMatches({ cwd, repoDir, commit: snap.commit, maxFileBytes: 1024 }))
  assert.equal(await readFile(join(cwd, 'src/a.ts'), 'utf8'), 'export const a = 1\n')
  assert.equal(await readFile(join(cwd, 'crlf.txt'), 'utf8'), 'a\r\nb\r\n') // 原始字节
  assert.equal(await readFile(join(cwd, 'untracked.md'), 'utf8'), 'u\n')
  assert.equal(await readlink(join(cwd, 'link')), 'src/a.ts')
  assert.ok(((await stat(join(cwd, 'run.sh'))).mode & 0o111) !== 0)
  assert.equal(Math.round((await stat(join(cwd, 'src/a.ts'))).mtimeMs), 1_600_000_000_000)
  await assert.rejects(lstat(join(cwd, 'src/new'))) // 空目录也清掉
  // 被忽略、超限、.agent-teams 都不动
  assert.equal(await readFile(join(cwd, 'build/out2.js'), 'utf8'), 'ignored too')
  assert.equal(await readFile(join(cwd, 'app.log'), 'utf8'), 'log')
  assert.equal((await stat(join(cwd, 'big.bin'))).size, 2048)
  assert.equal(await readFile(join(cwd, '.agent-teams/t/team.json'), 'utf8'), '{}')
  assert.equal(await readFile(join(cwd, 'vendor/lib/tmp/junk'), 'utf8'), 'j')
  // 用户仓库没被碰
  assert.equal(await readFile(join(cwd, '.git/HEAD'), 'utf8'), userHead)
  assert.equal((await stat(join(cwd, '.git/index'))).mtimeMs, userIndexMtime)
})

test('文件变目录：空目录清掉后还原；非空目录（含被忽略文件）拒绝', async () => {
  const { cwd, repoDir } = await setup()
  const snap = await snapshotWorkspace({ cwd, repoDir, ref: 's2', maxFileBytes: 1024 })
  await rm(join(cwd, 'untracked.md'))
  await mkdir(join(cwd, 'untracked.md'))
  await writeFile(join(cwd, 'untracked.md/x.ts'), 'x')
  await restoreWorkspace({ cwd, repoDir, commit: snap.commit, mtimes: snap.mtimes, maxFileBytes: 1024 })
  assert.equal(await readFile(join(cwd, 'untracked.md'), 'utf8'), 'u\n')

  await rm(join(cwd, 'untracked.md'))
  await mkdir(join(cwd, 'untracked.md'))
  await writeFile(join(cwd, 'untracked.md/keep.log'), 'ignored')
  await assert.rejects(
    restoreWorkspace({ cwd, repoDir, commit: snap.commit, mtimes: snap.mtimes, maxFileBytes: 1024 }),
    /path conflict/,
  )
})

test('没有用户仓库的普通目录也能拍', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ns-plain-'))
  const cwd = join(base, 'ws')
  await mkdir(cwd)
  await writeFile(join(cwd, 'a.txt'), 'a')
  const snap = await snapshotWorkspace({ cwd, repoDir: join(base, 'r.git'), ref: 'p' })
  assert.deepEqual(await commitFiles(join(base, 'r.git'), snap.commit), ['a.txt'])
  await rm(join(cwd, 'a.txt'))
  await restoreWorkspace({ cwd, repoDir: join(base, 'r.git'), commit: snap.commit, mtimes: snap.mtimes })
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'a')
})
