import http from 'node:http'
import fs from 'node:fs'
const LOG = process.env.MOCK_LOG ?? new URL('./mock.log', import.meta.url).pathname
let n = 0
http.createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    n++
    let j = {}; try { j = JSON.parse(body) } catch {}
    fs.appendFileSync(LOG, JSON.stringify({ n, t: Date.now(), method: req.method, url: req.url, body: j }) + '\n')
    if (!req.url.includes('messages')) { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"data":[]}') }
    const msgs = j.messages ?? []
    const last = [...msgs].reverse().find(x => x.role === 'user')
    const lastText = JSON.stringify(last?.content ?? '')
    const m = /NSDEV:([^"\\]+)/.exec(lastText)
    const wantTool = m !== null && !lastText.includes('tool_result')
    const blocks = wantTool
      ? [{ type: 'tool_use', id: 'toolu_' + n, name: 'newsnap_dev', input: { command: m[1].trim() } }]
      : [{ type: 'text', text: 'mock reply #' + n }]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`)
    ev('message_start', { message: { id: 'msg_' + n, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    blocks.forEach((b, i) => {
      if (b.type === 'text') {
        ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
        ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } })
      } else {
        ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
        ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
      }
      ev('content_block_stop', { index: i })
    })
    ev('message_delta', { delta: { stop_reason: wantTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    res.end()
  })
}).listen(18890, '127.0.0.1', () => console.log('mock on 18889'))
