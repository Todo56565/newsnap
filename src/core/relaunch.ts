/**
 * 重启参数（实现设计 §4.3）：按登记时记下的 process.* 重新拉起 DSH。
 * - web：原参数原样；端口固定时追加 `--no-open`，避免再开一个重复标签页（已打开的页面靠 cookie 自动重连）。
 *   `--port 0` 时不加（端口会变，原本自动开浏览器的仍由新进程打开新地址；README 已知局限）。
 * - headless：原参数里的任务文本换成续接提示，并加 `--session-id`。
 * env 不落盘，由辅助进程直接继承。
 * @module newsnap/core/relaunch
 */

import type { RelaunchSpec } from './manifest.ts'

export const SUPPORTED_RELAUNCH_PROFILES = ['web', 'headless'] as const

export function resumePrompt(message: string): string {
  return `[newsnap] ${message}. Continue from here.`
}

function hasRandomPort(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] === '0') return true
    if (argv[i] === '--port=0') return true
  }
  return false
}

export function relaunchCommand(spec: RelaunchSpec, message: string): { file: string; args: string[]; cwd: string } {
  const [script, ...rest] = spec.argv
  if (script === undefined) throw new Error('relaunch: argv is empty')
  let args: string[]
  if (spec.profile === 'headless') {
    if (spec.sessionId === undefined) throw new Error('relaunch: headless needs a session id')
    args = [script, '--profile', 'headless', ...(rest.includes('--json') ? ['--json'] : []), '--session-id', spec.sessionId, resumePrompt(message)]
  } else {
    args = [script, ...rest]
    if (!hasRandomPort(rest) && !rest.includes('--no-open')) args.push('--no-open')
  }
  return { file: spec.execPath, args: [...spec.execArgv, ...args], cwd: spec.cwd }
}
