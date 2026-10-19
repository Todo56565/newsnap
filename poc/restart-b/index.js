import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '/workspace/work/npm021/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
export const name = 'newsnap-restart-poc'
export const inject = ['tools']
const here = path.dirname(fileURLToPath(import.meta.url))
const LOG = process.env.SNAPB_LOG ?? '/workspace/work/snapb/poc.log'
const log = m => fs.appendFileSync(LOG, new Date().toISOString() + ' [plugin pid ' + process.pid + '] ' + m + '\n')
export function apply(ctx) {
  log('apply; argv=' + JSON.stringify(process.argv) + ' cmdlineArgs=' + JSON.stringify(ctx.get('cmdlineArgs')))
  ctx.tools.register(defineTool({
    name: 'newsnap_restart',
    description: 'PoC: restart DSH and resume this session.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(_args, exec) {
      const sessionId = exec.agent?.session?.id
      const exit = ctx.get('appExit')
      const payload = { parentPid: process.pid, execPath: process.execPath, execArgv: process.execArgv, argv: process.argv.slice(1), cwd: process.cwd(), sessionId }
      log('tool called; appExit=' + typeof exit + ' payload=' + JSON.stringify(payload))
      const child = spawn(process.execPath, [path.join(here, 'helper.mjs'), JSON.stringify(payload)], { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env })
      child.unref()
      setTimeout(() => { log('calling appExit(0)'); exit?.(0) }, Number(process.env.SNAPB_DELAY ?? 300))
      return { text: 'restart scheduled' }
    },
  }))
}
