import fs from 'node:fs'
import { spawn } from 'node:child_process'
const p = JSON.parse(process.argv[2])
const LOG = process.env.SNAPB_LOG ?? '/workspace/work/snapb/poc.log'
const log = m => fs.appendFileSync(LOG, new Date().toISOString() + ' [helper pid ' + process.pid + '] ' + m + '\n')
log('start, waiting for parent ' + p.parentPid)
const t0 = Date.now()
while (true) {
  try { process.kill(p.parentPid, 0) } catch (e) { if (e.code === 'ESRCH') break }
  if (Date.now() - t0 > 30000) { log('timeout, give up'); process.exit(1) }
  await new Promise(r => setTimeout(r, 100))
}
log('parent gone after ' + (Date.now() - t0) + 'ms')
// fake apply
fs.writeFileSync(p.cwd + '/target.txt', 'v1\n')
fs.writeFileSync(p.cwd + '/APPLIED', String(Date.now()))
log('fake apply done')
// relaunch: replace the task text with a continue prompt and pin the session
const args = p.argv.slice()
const out = fs.openSync('/workspace/work/snapb/relaunch.out', 'a')
const finalArgs = [...p.execArgv, args[0], '--profile', 'headless', '--json', '--session-id', p.sessionId, 'continue after restart']
log('relaunch: ' + p.execPath + ' ' + JSON.stringify(finalArgs))
const c = spawn(p.execPath, finalArgs, { cwd: p.cwd, env: process.env, stdio: ['ignore', out, out], detached: true })
c.on('exit', code => { log('relaunched dsh exited code=' + code); process.exit(0) })
