/**
 * 开发/测试用工具 `newsnap_dev`：headless 没有斜杠命令服务，e2e 由 mock 模型调用这个工具来触发
 * 与 `/newsnap ...` 相同的处理。只有环境变量 NEWSNAP_DEV_TOOLS=1 时注册；运行时动态加载 dsh-tools，
 * 不给正式包增加依赖。
 * @module newsnap/host/dev-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const DEV_TOOL = 'newsnap_dev'

export function registerDevTool(ctx: Context, run: (invocation: CommandInvocation) => Promise<CommandResult>): void {
  if (process.env.NEWSNAP_DEV_TOOLS !== '1') return
  ctx.inject(['tools'], async (toolCtx) => {
    const spec = '@deepseek-ai/dsh-tools'
    const { defineTool } = (await import(spec)) as { defineTool: (def: unknown) => unknown }
    const tools = (toolCtx as unknown as { tools: { register(tool: unknown): () => void } }).tools
    toolCtx.effect(() => tools.register(defineTool({
      name: DEV_TOOL,
      description: 'newsnap development hook: runs a /newsnap subcommand (e.g. "snap note", "restore <id> confirm").',
      parameters: { command: { type: 'string', description: 'the text after /newsnap', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
      },
      async execute(args: { command: string }, exec: { agent: CommandInvocation['agent'] }) {
        const result = await run({ rawInput: args.command, agent: exec.agent } as CommandInvocation)
        return { text: `${result.kind}: ${'text' in result ? String(result.text) : ''}` }
      },
    })), 'newsnap: dev tool')
  })
}
