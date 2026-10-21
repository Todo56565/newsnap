// newsnap 网页客户端模块（M5-1：对话书签卡、B 轻量确认框、恢复后提示条）。
// 手写的 DSH 客户端包格式：window.__ModuleLoader__.load({ id, factory(require) })，
// 外部依赖经 require 从平台模块表取（react、react-dom、ui-primitives）。
// 数据经 connection.rpc.call('/api', 'newsnap/<method>', { args }) 读写宿主侧 host/remote.ts。
window.__ModuleLoader__.load({
  id: 'newsnap',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createPortal } = require('react-dom')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Modal, Tooltip, DisclosureRow, TextShimmer } = P
    const icon = (name, size = 14) => (P[name] ? h(P[name], { size }) : null)
    const h = React.createElement
    const { useState, useEffect, useCallback, useSyncExternalStore } = React

    const inject = ['slots', 'connection', 'sidebarRight', 'sidebarRightTabs']

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #666)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      accent: 'var(--dsw-alias-state-business-primary, #2f6bff)',
      warn: 'var(--dsw-alias-state-warn-primary, #d9480f)',
      error: 'var(--dsw-alias-state-error-primary, #c92a2a)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
      base: 'var(--dsw-alias-bg-base, #fff)',
    }

    // 原生感：类名与数值照抄 DSH 自己的 GoalBar（输入框上方条）和 GenericCommandCard（命令行），全部用设计令牌。
    const STYLE = `
.nsn-dock{box-sizing:border-box;width:calc(100% - 2*var(--dsh-composer-side-clearance,0px) - 4*var(--dsh-composer-dock-inset,0px));margin:0 auto}
.nsn-bar{position:relative;isolation:isolate;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;max-width:calc(var(--dsh-composer-card-max-width,760px) - 4*var(--dsh-composer-dock-inset,0px));height:36px;margin:0 auto;padding:4px 5px 4px 12px;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel)}
.nsn-bar::before{position:absolute;z-index:-1;inset:0;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:'';pointer-events:none}
.nsn-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.nsn-label{flex:none;font-size:13px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.nsn-objective{flex:1;min-width:0;overflow:hidden;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary-dimmed);text-overflow:ellipsis;white-space:nowrap}
.nsn-actions{display:flex;align-items:center;gap:6px;flex:none}
.nsn-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nsn-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.nsn-icon-btn:disabled{opacity:.4;cursor:default}
.nsn-text-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.nsn-text-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nsn-cmd{display:flex;flex-direction:column}
.nsn-cmd-title{font-weight:400}
.nsn-cmd[data-quiet] .nsn-cmd-title,.nsn-cmd[data-quiet] .nsn-summary,.nsn-cmd[data-quiet] .nsn-glyph{color:var(--dsw-alias-label-tertiary)}
.nsn-cmd[data-quiet]{opacity:.85}
.nsn-folded{display:none}

.nsn-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.nsn-summary{min-width:0;overflow:hidden;flex:1 1 auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap}
.nsn-summary[data-error],.nsn-body[data-error]{color:var(--dsw-alias-state-error-primary)}
.nsn-body{max-height:260px;margin:4px 0 4px 4px;padding:12px 16px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap}
.nsn-mark{position:relative;display:flex;align-items:center;gap:8px;min-height:32px;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nsn-mark-line{flex:1;height:0;border-top:1px dashed var(--dsw-alias-border-l3)}
.nsn-mark-time{color:var(--dsw-alias-label-primary);font-weight:500}
.nsn-mark-meta{color:var(--dsw-alias-label-tertiary)}
.nsn-mark-action{position:absolute;right:0;top:50%;transform:translateY(-50%);padding-left:6px;background:var(--dsw-alias-bg-base);opacity:0;pointer-events:none;transition:opacity .15s}
.nsn-mark:hover .nsn-mark-action,.nsn-mark:focus-within .nsn-mark-action{opacity:1;pointer-events:auto}
.nsn-note{margin:0 0 8px;line-height:1.65;color:var(--dsw-alias-label-primary)}
.nsn-note-dim{color:var(--dsw-alias-label-secondary)}
.nsn-details{margin-top:8px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary)}
.nsn-tm{box-sizing:border-box;height:100%;overflow:auto;padding:8px 12px 24px;color:var(--dsw-alias-label-primary);font-size:13px}
.nsn-tm-head{display:flex;align-items:center;gap:6px;height:28px;margin:8px 0 4px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nsn-tm-head>span:first-child{flex:1}
.nsn-tl{position:relative;margin:0;padding:0;list-style:none}
.nsn-tl::before{position:absolute;top:14px;bottom:14px;left:9px;border-left:1px dashed var(--dsw-alias-border-l3);content:''}
.nsn-tl-item{position:relative;display:flex;align-items:center;gap:8px;min-height:28px;padding:2px 8px 2px 0;border-radius:var(--dsw-radius-sm)}
.nsn-tl-item[data-kind='snap']{cursor:pointer}
.nsn-tl-item[data-kind='snap']:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nsn-tl-item[aria-selected='true']{background:var(--dsw-alias-bg-layer-1)}
.nsn-tl-dot{position:relative;z-index:1;display:inline-flex;flex:none;align-items:center;justify-content:center;width:19px;height:19px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base);border-radius:50%}
.nsn-tl-item[aria-selected='true'] .nsn-tl-dot{color:var(--dsw-alias-label-primary)}
.nsn-tl-now{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.nsn-tl-time{flex:none;font-weight:500;font-variant-numeric:tabular-nums}
.nsn-tl-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.nsn-tl-item[data-kind='event']{min-height:22px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.nsn-tl-item[data-kind='event'] .nsn-tl-text,.nsn-tl-item[data-kind='event'] .nsn-tl-time{color:var(--dsw-alias-label-tertiary);font-weight:400}
.nsn-cmp{margin-top:12px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1)}
.nsn-cmp-title{display:flex;align-items:center;gap:8px;min-height:28px;font-weight:500}
.nsn-cmp-title>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsn-cmp-sum{margin:2px 0 6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.nsn-file{display:flex;align-items:center;gap:8px;width:100%;min-height:26px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.nsn-file:hover,.nsn-file[aria-expanded='true']{background:var(--dsw-alias-interactive-bg-hover)}
.nsn-file-st{flex:none;width:12px;font-family:var(--ds-font-family-code);font-size:11px;text-align:center}
.nsn-file-st[data-st='added']{color:var(--dsw-alias-state-success-primary)}
.nsn-file-st[data-st='deleted']{color:var(--dsw-alias-state-error-primary)}
.nsn-file-st[data-st='modified']{color:var(--dsw-alias-state-warn-primary)}
.nsn-file-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.nsn-counts{display:inline-flex;flex:none;gap:6px;font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.nsn-add{color:var(--dsw-alias-state-success-primary)}
.nsn-del{color:var(--dsw-alias-state-error-primary)}
.nsn-diff{margin:4px 0 8px}
.nsn-diff-note{margin:4px 6px 8px 26px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nsn-sess{display:flex;align-items:center;gap:8px;min-height:24px;padding:0 6px;font-size:12px}
.nsn-sess-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsn-sess-id{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px}
.nsn-sess-eff{flex:none;color:var(--dsw-alias-label-secondary)}
.nsn-sess-eff[data-warn]{color:var(--dsw-alias-state-warn-primary)}
.nsn-tm-foot{display:flex;align-items:center;gap:8px;margin-top:14px}
.nsn-tm-foot .nsn-note-dim{flex:1;font-size:12px;line-height:18px}
.nsn-empty{padding:24px 8px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.7;text-align:center}
@keyframes nsn-spin{to{transform:rotate(360deg)}}
.nsn-spin{display:inline-flex;animation:nsn-spin 1s linear infinite;color:var(--dsw-alias-label-tertiary)}
`
    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById('newsnap-style')) return
      const el = document.createElement('style'); el.id = 'newsnap-style'; el.textContent = STYLE; document.head.appendChild(el)
    }

    function IconAction({ label, iconName, onClick, disabled, ...rest }) {
      return h(Tooltip, { portal: true, label, side: 'top', delayMs: 400 },
        h('button', { type: 'button', className: 'nsn-icon-btn', 'aria-label': label, onClick, disabled, ...rest }, icon(iconName)))
    }

    const pad = (n) => String(n).padStart(2, '0')
    function hm(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
    function when(ms) {
      const d = new Date(ms); const now = new Date()
      return d.toDateString() === now.toDateString() ? hm(ms) : `${d.getMonth() + 1}月${d.getDate()}日 ${hm(ms)}`
    }

    // ── 每个会话一份快照视图缓存，书签卡和提示条共用 ──
    function createStore(call) {
      const entries = new Map()
      function entry(sessionId) {
        let e = entries.get(sessionId)
        if (e === undefined) {
          e = { state: { status: 'idle' }, listeners: new Set(), inflight: null }
          entries.set(sessionId, e)
        }
        return e
      }
      function set(e, state) { e.state = state; for (const l of e.listeners) l() }
      function refresh(sessionId) {
        const e = entry(sessionId)
        if (e.inflight !== null) return e.inflight
        e.inflight = call('list', { sessionId }).then((r) => {
          if (r.ok && r.value.ok) set(e, { status: 'ready', view: r.value.value })
          else set(e, { status: 'error', message: r.ok ? r.value.message : (r.error && (r.error.message || r.error.code)) || '读取失败' })
        }, (err) => set(e, { status: 'error', message: String(err && err.message || err) })).finally(() => { e.inflight = null })
        return e.inflight
      }
      return {
        refresh,
        subscribe(sessionId, listener) {
          const e = entry(sessionId)
          e.listeners.add(listener)
          if (e.state.status === 'idle') void refresh(sessionId)
          return () => { e.listeners.delete(listener) }
        },
        get(sessionId) { return entry(sessionId).state },
      }
    }

    function useView(store, sessionId) {
      const subscribe = useCallback((l) => store.subscribe(sessionId, l), [store, sessionId])
      const get = useCallback(() => store.get(sessionId), [store, sessionId])
      return useSyncExternalStore(subscribe, get)
    }

    // ── 恢复：确认后显示过渡层；网页端等宿主重启完成后自动刷新页面 ──
    function waitAndReload(ctx) {
      let sawDown = false
      let reset = false
      const off = typeof ctx.on === 'function' ? ctx.on('connection/reset', () => { reset = true }) : undefined
      const started = Date.now()
      const tick = async () => {
        let up = false
        try {
          const res = await fetch(`${location.pathname}?newsnap-probe=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' })
          up = res.status > 0
        } catch { up = false }
        if (!up) sawDown = true
        if ((sawDown && up) || (reset && up && Date.now() - started > 2000)) {
          if (typeof off === 'function') off()
          setTimeout(() => location.reload(), 800)
          return
        }
        if (Date.now() - started > 120000) return
        setTimeout(tick, 700)
      }
      setTimeout(tick, 600)
    }

    function Transition({ title, relaunches }) {
      return createPortal(h('div', {
        'data-newsnap': 'transition',
        style: { position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 92%, transparent)', backdropFilter: 'blur(2px)' },
      }, h('div', { style: { textAlign: 'center', color: C.text, maxWidth: 420, padding: 24 } },
        h('span', { className: 'nsn-spin' }, icon('IconLoadingOutlineRegular', 24)),
        h('div', { style: { fontSize: 15, fontWeight: 500, marginTop: 10 } }, title),
        h('div', { style: { fontSize: 13, color: C.sub, marginTop: 8, lineHeight: 1.6 } }, relaunches
          ? 'DSH 正在退出、恢复文件和会话、再重新启动。完成后页面会自动刷新，通常十几秒。'
          : 'DSH 会关闭，弹出「启动失败」对话框后点「重启」即可，这是 newsnap 让宿主退出造成的。'))), document.body)
    }

    // B 轻量确认框：一句话写清代价，细节收在「查看详情」里。
    function ConfirmDialog({ ctx, call, sessionId, mode, snap, onClose }) {
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [details, setDetails] = useState(false)
      const [going, setGoing] = useState(null)
      useEffect(() => {
        if (mode !== 'restore') return
        let live = true
        call('preview', { sessionId, id: snap.id }).then((r) => {
          if (!live) return
          if (r.ok && r.value.ok) setPreview(r.value.value)
          else setError(r.ok ? r.value.message : (r.error && r.error.message) || '读取失败')
        })
        return () => { live = false }
      }, [mode, snap && snap.id])
      const title = mode === 'restore' ? `回到 ${when(snap.createdAt)}${snap.note ? `「${snap.note}」` : ''}？` : '撤销这次恢复？'
      const go = async () => {
        setBusy(true); setError(null)
        const r = mode === 'restore' ? await call('restore', { sessionId, id: snap.id }) : await call('undo', { sessionId })
        if (r.ok && r.value.ok) {
          const relaunches = r.value.value.relaunches
          setGoing({ relaunches })
          if (relaunches) waitAndReload(ctx)
        } else {
          setBusy(false)
          setError(r.ok ? r.value.message : (r.error && r.error.message) || '恢复失败')
        }
      }
      if (going !== null) return h(Transition, { title: mode === 'restore' ? `正在回到 ${when(snap.createdAt)}…` : '正在撤销…', relaunches: going.relaunches })
      const body = mode === 'restore'
        ? [
            h('p', { key: 'p', className: 'nsn-note' },
              '这次快照之后的对话、团队状态和工作区文件改动都会撤回，恢复前会先自动存一个撤销点。',
              h('span', { className: 'nsn-note-dim' }, '被 .gitignore 忽略的生成物（如 dist、node_modules）不回退。')),
            preview && preview.otherTeams.length > 0 && h('p', { key: 'w', style: { margin: '0 0 8px', color: C.warn } }, `同一工作区还有团队 ${preview.otherTeams.join('、')}，工作区文件回退也会影响它们。`),
            h('button', { key: 'd', type: 'button', className: 'nsn-text-btn', style: { marginLeft: -8 }, onClick: () => setDetails(!details), 'aria-expanded': details }, icon(details ? 'IconChevronDownOutlineRegular' : 'IconChevronRightOutlineRegular', 12), '查看详情'),
            details && h('div', { key: 'dd', className: 'nsn-details' },
              preview === null && error === null ? '正在读取…' : preview && [
                h('div', { key: 1 }, `快照 ${preview.id} · 团队 ${preview.team}`),
                h('div', { key: 2 }, preview.removedSessions > 0 ? `快照之后新开的 ${preview.removedSessions} 个会话会移进撤销点` : '没有快照之后新开的会话'),
                h('div', { key: 3 }, preview.relaunches ? 'DSH 会退出并自动重启，页面随后自动刷新' : 'DSH 会关闭，弹出对话框后点「重启」'),
              ]),
          ]
        : [h('p', { key: 'p', style: { margin: 0, lineHeight: 1.65 } }, '会回到这次恢复之前的状态：对话、团队状态和工作区文件一起回去。DSH 同样会重启。')]
      return h(Modal, {
        open: true, onClose: busy ? () => {} : onClose, title, closeLabel: '关闭',
        footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(Button, { variant: 'outline', onClick: onClose, disabled: busy }, '取消'),
          h(Button, { variant: 'primary', onClick: go, disabled: busy || (mode === 'restore' && preview === null), 'data-newsnap': 'confirm' },
            mode === 'restore' ? `回到 ${when(snap.createdAt)}` : '撤销')),
      }, h('div', { 'data-newsnap': 'dialog', style: { fontSize: 13, color: C.text } },
        ...body,
        error && h('p', { style: { margin: '8px 0 0', color: C.error, whiteSpace: 'pre-wrap' } }, error)))
    }

    // 其他子命令：照 DSH 的 GenericCommandCard 画（DisclosureRow + 摘要），并做三件事让它们不抢眼：
    // 1) 摘要只留一句短话，点开看全文；2) 只查看的命令（status/list/preview/help）再淡一档、不显示摘要；
    // 3) 相邻的几条折叠成一行「newsnap · N 条操作」。
    const QUIET = new Set(['status', 'list', 'preview', 'help'])
    function shortSummary(text) {
      let t = text.replace(/^\s*newsnap\s*[:：]\s*/, '')
      const cut = t.search(/[。\n（(；;，,]/)
      if (cut > 0) t = t.slice(0, cut)
      t = t.trim()
      return t.length > 28 ? `${t.slice(0, 27)}…` : t
    }
    function rowInfo(node) {
      const text = node.outcome ? node.outcome.text : undefined
      const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
      const sub = (node.args || '').trim().split(/\s+/)[0]
      const summary = node.outcome === null ? '执行中…' : text ? shortSummary(text) : (state === 'error' ? '失败' : '完成')
      const full = text !== undefined && text.trim() !== '' && text.trim() !== summary ? text : null
      return { text, state, sub, summary, full, quiet: QUIET.has(sub) && state !== 'error' }
    }

    // 折叠协调：按 DOM 顺序找出相邻的 newsnap 命令行，组头记组员数，组员在折叠时只留一个空标记（保持相邻关系可测）
    const folds = (() => {
      let roles = new Map() // cid -> { head: cid, count }
      const open = new Set()
      const listeners = new Set()
      let scheduled = false
      let observer = null
      const emit = () => { for (const l of listeners) l() }
      function adjacent(prevEl, el) {
        let a = el
        for (let i = 0; i < 10 && a && a.parentElement; i++) {
          const prev = a.previousElementSibling
          if (prev) {
            const rows = prev.matches('[data-newsnap-row]') ? [prev] : Array.from(prev.querySelectorAll('[data-newsnap-row]'))
            if (rows[rows.length - 1] !== prevEl) return false
            // 前一块里除了 newsnap 的行/组头之外不能有别的内容
            let rest = prev.textContent
            for (const n of prev.querySelectorAll('[data-newsnap="group"],[data-newsnap-row]')) rest = rest.replace(n.textContent, '')
            return rest.trim() === ''
          }
          a = a.parentElement
        }
        return false
      }
      function compute() {
        scheduled = false
        const els = Array.from(document.querySelectorAll('[data-newsnap-row]'))
        const next = new Map()
        let head = null; let members = []
        const flush = () => { if (head) for (const m of members) next.set(m, { head, count: members.length }) }
        els.forEach((el, i) => {
          const cid = el.getAttribute('data-newsnap-row')
          if (i > 0 && head && adjacent(els[i - 1], el)) members.push(cid)
          else { flush(); head = cid; members = [cid] }
        })
        flush()
        let changed = next.size !== roles.size
        if (!changed) for (const [k, v] of next) { const o = roles.get(k); if (!o || o.head !== v.head || o.count !== v.count) { changed = true; break } }
        if (changed) { roles = next; emit() }
      }
      function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(compute) } }
      return {
        subscribe(l) {
          listeners.add(l)
          if (!observer) { observer = new MutationObserver(schedule); observer.observe(document.body, { childList: true, subtree: true }) }
          schedule()
          return () => listeners.delete(l)
        },
        role: (cid) => roles.get(cid),
        isOpen: (head) => open.has(head),
        toggle(head) { open.has(head) ? open.delete(head) : open.add(head); emit() },
        version: () => roles,
        openVersion: () => open.size,
        schedule,
      }
    })()
    function useFold(cid) {
      useSyncExternalStore(folds.subscribe, folds.version)
      const openN = useSyncExternalStore(folds.subscribe, folds.openVersion)
      useEffect(() => { folds.schedule() }, [])
      const r = folds.role(cid)
      if (!r || r.count < 2) return { kind: 'single' }
      return { kind: r.head === cid ? 'head' : 'member', head: r.head, count: r.count, open: folds.isOpen(r.head), openN }
    }

    function CommandRow({ node }) {
      const [open, setOpen] = useState(false)
      const { state, sub, summary, full, quiet } = rowInfo(node)
      return h(DisclosureRow, {
        titleClassName: 'nsn-cmd-title',
        icon: icon('IconClockOutlineRegular'),
        title: sub ? `newsnap ${sub}` : 'newsnap',
        running: state === 'running',
        open: open && full !== null,
        expandable: full !== null,
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        onToggle: () => setOpen((v) => !v),
        collapsedContent: quiet && state !== 'running' ? undefined : h(React.Fragment, null,
          h('span', { className: 'nsn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
          h('span', { className: 'nsn-summary', 'data-error': state === 'error' || undefined }, h(TextShimmer, null, summary))),
      }, open && full !== null ? h('pre', { className: 'nsn-body', 'data-error': state === 'error' || undefined }, full) : undefined)
    }

    function GenericRow({ node }) {
      const cid = node.commandId || `${node.name}:${node.args}`
      const fold = useFold(cid)
      const info = rowInfo(node)
      const attrs = { 'data-newsnap': 'command', 'data-newsnap-row': cid, 'data-state': info.state }
      if (fold.kind === 'member' && !fold.open) return h('div', { ...attrs, className: 'nsn-folded', 'data-folded': true })
      const row = h('div', { className: 'nsn-cmd', ...attrs, 'data-quiet': info.quiet || undefined }, h(CommandRow, { node }))
      if (fold.kind !== 'head') return row
      return h(React.Fragment, null,
        h('div', { className: 'nsn-cmd', 'data-newsnap': 'group', 'data-quiet': true },
          h(DisclosureRow, {
            titleClassName: 'nsn-cmd-title',
            icon: icon('IconClockOutlineRegular'),
            title: 'newsnap',
            open: fold.open,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => folds.toggle(fold.head),
            collapsedContent: h(React.Fragment, null,
              h('span', { className: 'nsn-sep', 'aria-hidden': true }),
              h('span', { className: 'nsn-summary' }, `${fold.count} 条操作`)),
          })),
        fold.open ? h('div', { className: 'nsn-group-item' }, row) : h('div', { ...attrs, className: 'nsn-folded', 'data-folded': true }))
    }

    function makeBookmark(ctx, store, call) {
      return function NewsnapCommand(props) {
        const node = props.node
        const sessionId = props.sessionId
        const sub = (node.args || '').trim().split(/\s+/)[0]
        const isSnap = sub === 'snap' && node.outcome !== null && node.outcome.kind === 'success'
        const state = useView(store, sessionId)
        const [dialog, setDialog] = useState(false)
        const snap = state.status === 'ready' ? state.view.snapshots.find((s) => s.commandId === node.commandId) : undefined
        useEffect(() => {
          // 刚拍完：列表还没有这一张，补读一次
          if (isSnap && state.status === 'ready' && snap === undefined) void store.refresh(sessionId)
        }, [isSnap, node.commandId])
        if (!isSnap) return h(GenericRow, { node })
        return h('div', { className: 'nsn-mark', 'data-newsnap': 'bookmark', 'data-newsnap-snap': snap ? snap.id : '' },
          h('span', { className: 'nsn-mark-line' }),
          h('span', { className: 'nsn-glyph' }, icon('IconClockOutlineRegular')),
          snap
            ? h(React.Fragment, null,
                h('span', { className: 'nsn-mark-time' }, when(snap.createdAt)),
                h('span', null, snap.note ? `快照「${snap.note}」` : '快照'),
                h('span', { className: 'nsn-sep', style: { margin: 0 } }),
                h('span', { className: 'nsn-mark-meta' }, `${snap.sessions} 个会话`))
            : h('span', { className: 'nsn-mark-meta' }, state.status === 'ready' ? '快照已删除' : '快照'),
          h('span', { className: 'nsn-mark-line' }),
          // 操作浮在右端虚线上，不占位，书签内容始终居中；悬停或键盘聚焦时出现
          snap && h('span', { className: 'nsn-mark-action' },
            canOpenTimeline(ctx) && h('button', { type: 'button', className: 'nsn-text-btn', onClick: () => openTimeline(ctx, snap.id), 'data-newsnap': 'compare' }, icon('IconCompareSplitOutlineRegular', 12), '对比'),
            h('button', { type: 'button', className: 'nsn-text-btn', onClick: () => setDialog(true), 'data-newsnap': 'restore' }, icon('IconRefreshOutlineRegular', 12), '回到这里')),
        dialog && snap && h(ConfirmDialog, { ctx, call, sessionId, mode: 'restore', snap, onClose: () => setDialog(false) }))
      }
    }

    // ── 5 恢复后的提示条（输入框上方）──
    const DISMISS_KEY = 'newsnap.banner.dismissed'
    function makeBanner(ctx, store, call) {
      return function NewsnapBanner({ sessionId }) {
        const state = useView(store, sessionId)
        const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) } catch { return null } })
        const [dialog, setDialog] = useState(false)
        if (state.status !== 'ready' || state.view.lastApplied === null) return null
        const last = state.view.lastApplied
        const key = `${state.view.team && state.view.team.id}:${last.at}`
        if (dismissed === key) return null
        const close = () => { try { localStorage.setItem(DISMISS_KEY, key) } catch {} ; setDismissed(key) }
        const label = last.kind === 'snapshot' ? '已恢复' : '已撤销恢复'
        const objective = last.kind === 'snapshot'
          ? `回到${last.targetAt ? ` ${when(last.targetAt)} 的` : ''}快照${last.note ? `「${last.note}」` : ` ${last.target}`}`
          : '回到了上一次恢复之前的状态'
        // 与 DSH 的目标条（GoalBar）同一族：同尺寸的浮层条、图标、标题 + 灰色说明、右侧圆形图标按钮
        return h('div', { className: 'nsn-dock' }, h('div', { className: 'nsn-bar', 'data-newsnap': 'banner' },
          h('span', { className: 'nsn-glyph' }, icon('IconClockOutlineRegular')),
          h('span', { className: 'nsn-label' }, label),
          h('span', { className: 'nsn-objective' }, objective),
          h('div', { className: 'nsn-actions' },
            last.canUndo && h(IconAction, { label: last.kind === 'snapshot' ? '撤销这次恢复' : '再撤销一次', iconName: 'IconRefreshOutlineRegular', onClick: () => setDialog(true), 'data-newsnap': 'undo' }),
            h(IconAction, { label: '关闭提示', iconName: 'IconCloseOutlineRegular', onClick: close, 'data-newsnap': 'close' })),
        dialog && h(ConfirmDialog, { ctx, call, sessionId, mode: 'undo', onClose: () => setDialog(false) })))
      }
    }

    // ── 3 右侧栏「时光机」：时间线 + 选中快照与「现在」的对比（m5-web-ui.md §6）──
    const TAB_ID = 'newsnap/timeline'
    const TAB_KIND = 'newsnapTimeline'
    const canOpenTimeline = (ctx) => !!(ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function')
    function openTimeline(ctx, snapId) {
      try { ctx.sidebarRight.openTab(TAB_KIND, snapId ? { params: { newsnapSnap: snapId } } : {}) } catch (e) { console.warn('newsnap: open timeline failed', e) }
    }
    const ROLE = { captain: '队长', member: '成员', descendant: '子代理' }
    const ST = { added: 'A', modified: 'M', deleted: 'D' }
    const DIFF_LABELS = {
      copy: '复制', copied: '已复制', collapseAria: '收起', expandAria: (n) => `展开其余 ${n} 行`, collapse: '收起', expand: (n) => `展开其余 ${n} 行`,
      codeLabel: '差异', wrapLabel: '自动换行', unwrapLabel: '不换行',
    }
    const errText = (r, fallback) => (r.ok ? r.value.message : (r.error && (r.error.message || r.error.code)) || fallback)

    function FileRow({ call, sessionId, snapId, file }) {
      const [open, setOpen] = useState(false)
      const [diff, setDiff] = useState(null)
      useEffect(() => {
        if (!open || diff !== null) return
        let live = true
        call('fileDiff', { sessionId, id: snapId, path: file.path }).then((r) => {
          if (live) setDiff(r.ok && r.value.ok ? r.value.value : { kind: 'error', message: errText(r, '读取失败') })
        })
        return () => { live = false }
      }, [open])
      const counts = file.added === null
        ? h('span', { className: 'nsn-counts' }, '二进制')
        : h('span', { className: 'nsn-counts' }, file.added > 0 && h('span', { className: 'nsn-add' }, `+${file.added}`), file.removed > 0 && h('span', { className: 'nsn-del' }, `−${file.removed}`))
      let body = null
      if (open) {
        if (diff === null) body = h('div', { className: 'nsn-diff-note' }, '正在读取…')
        else if (diff.kind === 'error') body = h('div', { className: 'nsn-diff-note', style: { color: C.error } }, diff.message)
        else if (diff.kind === 'binary') body = h('div', { className: 'nsn-diff-note' }, '二进制文件，不显示内容')
        else if (diff.kind === 'too-large') body = h('div', { className: 'nsn-diff-note' }, '文件太大，不显示内容')
        else body = P.DiffBlock
          ? h('div', { className: 'nsn-diff' }, h(P.DiffBlock, { diffs: [{ path: file.path, oldText: diff.oldText, newText: diff.newText ?? '' }], labels: DIFF_LABELS, maxLines: 40 }))
          : h('pre', { className: 'nsn-body' }, `--- 快照\n${diff.oldText ?? ''}\n+++ 现在\n${diff.newText ?? ''}`)
      }
      return h('div', { 'data-newsnap': 'file', 'data-path': file.path },
        h('button', { type: 'button', className: 'nsn-file', 'aria-expanded': open, onClick: () => setOpen(!open), title: file.path },
          h('span', { className: 'nsn-file-st', 'data-st': file.status }, ST[file.status]),
          h('span', { className: 'nsn-file-path' }, h('bdi', null, file.path)),
          counts),
        body)
    }

    function sessionEffect(s) {
      if (s.change === 'removed') return { text: '快照之后新开，会移进撤销点', warn: true }
      if (s.change === 'restored') return { text: '现在已不在，会回来', warn: false }
      if (s.snapTurns === null || s.nowTurns === null) return { text: '轮数读不出', warn: false }
      const back = s.nowTurns - s.snapTurns
      return back > 0 ? { text: `退回 ${back} 轮（${s.nowTurns} → ${s.snapTurns}）`, warn: true } : { text: '没有新的轮次', warn: false }
    }

    function CompareView({ ctx, call, sessionId, snap }) {
      const [data, setData] = useState(null)
      const [dialog, setDialog] = useState(false)
      const [tick, setTick] = useState(0)
      useEffect(() => {
        let live = true
        setData(null)
        call('compare', { sessionId, id: snap.id }).then((r) => {
          if (live) setData(r.ok && r.value.ok ? { ok: true, value: r.value.value } : { ok: false, message: errText(r, '对比失败') })
        })
        return () => { live = false }
      }, [snap.id, tick])
      const v = data && data.ok ? data.value : null
      const n = (st) => v.files.filter((f) => f.status === st).length
      const parts = v ? [['新增', n('added')], ['修改', n('modified')], ['删除', n('deleted')]].filter(([, c]) => c > 0).map(([l, c]) => `${l} ${c}`) : []
      return h('section', { className: 'nsn-cmp', 'data-newsnap': 'compare', 'data-snap': snap.id },
        h('div', { className: 'nsn-cmp-title' },
          h('span', null, `${when(snap.createdAt)}${snap.note ? `「${snap.note}」` : ' 快照'} → 现在`),
          h(IconAction, { label: '重新对比', iconName: 'IconRefreshOutlineRegular', onClick: () => setTick(tick + 1) })),
        data === null && h('div', { className: 'nsn-cmp-sum' }, h(TextShimmer, null, '正在对比…')),
        data && !data.ok && h('div', { className: 'nsn-cmp-sum', style: { color: C.error } }, data.message),
        v && h(React.Fragment, null,
          h('div', { className: 'nsn-tm-head' }, h('span', null, '工作区文件')),
          h('div', { className: 'nsn-cmp-sum', 'data-newsnap': 'file-summary' }, v.files.length === 0 ? '和现在一样，没有改动' : `快照之后 ${parts.join(' · ')}，回到这里会撤回`),
          v.files.map((f) => h(FileRow, { key: `${snap.id}:${f.path}`, call, sessionId, snapId: snap.id, file: f })),
          h('div', { className: 'nsn-tm-head' }, h('span', null, '会话')),
          v.sessions.map((s) => {
            const e = sessionEffect(s)
            return h('div', { key: s.id, className: 'nsn-sess', 'data-newsnap': 'session', 'data-change': s.change },
              h('span', { className: 'nsn-sess-name' }, `${ROLE[s.role] || s.role} `, h('span', { className: 'nsn-sess-id' }, s.id.replace(/^session-/, '').slice(0, 8))),
              h('span', { className: 'nsn-sess-eff', 'data-warn': e.warn || undefined }, e.text))
          }),
          h('div', { className: 'nsn-tm-foot' },
            h('span', { className: 'nsn-note-dim' }, '被 .gitignore 忽略的生成物不回退；恢复前会先存撤销点。'),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => setDialog(true), 'data-newsnap': 'tm-restore' }, '回到这里'))),
        dialog && h(ConfirmDialog, { ctx, call, sessionId, mode: 'restore', snap, onClose: () => setDialog(false) }))
    }

    function makeTimeline(ctx, store, call) {
      return function NewsnapTimeline(props) {
        const sessionId = props.sessionId
        const useTabInfo = props.useTabInfo || (props.hooks && props.hooks.tabInfo)
        const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
        const nav = info && info.tab && info.tab.navigation
        const asked = nav && nav.params && nav.params.newsnapSnap
        const visible = !info || !info.tab || info.tab.visible !== false
        const state = useView(store, sessionId)
        const [picked, setPicked] = useState(asked || null)
        useEffect(() => { if (asked) setPicked(asked) }, [asked, nav && nav.revision])
        useEffect(() => { if (visible) void store.refresh(sessionId) }, [visible, sessionId])
        if (state.status === 'idle' || state.status === 'loading') return h('div', { className: 'nsn-tm' }, h('div', { className: 'nsn-empty' }, h(TextShimmer, null, '正在读取…')))
        if (state.status === 'error') return h('div', { className: 'nsn-tm' }, h('div', { className: 'nsn-empty', style: { color: C.error } }, state.message))
        const view = state.view
        if (view.team === null) return h('div', { className: 'nsn-tm', 'data-newsnap': 'timeline' }, h('div', { className: 'nsn-empty' }, '这个会话不属于 agent-teams 团队，没有团队快照。'))
        if (view.snapshots.length === 0) return h('div', { className: 'nsn-tm', 'data-newsnap': 'timeline' }, h('div', { className: 'nsn-empty' }, `团队 ${view.team.name} 还没有快照。`, h('br'), '在对话里输入 /newsnap snap 拍一张。'))
        const selected = view.snapshots.find((x) => x.id === picked) || view.snapshots[0]
        const byId = new Map(view.snapshots.map((x) => [x.id, x]))
        const items = [
          ...view.snapshots.map((x) => ({ kind: 'snap', at: x.createdAt, snap: x })),
          ...(view.history || []).map((e) => ({ kind: 'event', at: e.at, event: e })),
        ].sort((a, b) => b.at - a.at)
        return h('div', { className: 'nsn-tm', 'data-newsnap': 'timeline' },
          h('div', { className: 'nsn-tm-head' }, h('span', null, `团队 ${view.team.name} · ${view.snapshots.length} 张快照`),
            h(IconAction, { label: '刷新', iconName: 'IconRefreshOutlineRegular', onClick: () => store.refresh(sessionId) })),
          h('ul', { className: 'nsn-tl', role: 'listbox', 'aria-label': '快照时间线' },
            h('li', { className: 'nsn-tl-item', 'data-kind': 'now' }, h('span', { className: 'nsn-tl-dot' }, h('span', { className: 'nsn-tl-now' })), h('span', { className: 'nsn-tl-time' }, '现在')),
            items.map((it) => {
              if (it.kind === 'event') {
                const t = it.event.kind === 'snapshot' ? byId.get(it.event.target) : undefined
                const text = it.event.kind === 'snapshot' ? `恢复到${t ? ` ${when(t.createdAt)}${t.note ? `「${t.note}」` : ''}` : '快照'}` : '撤销了一次恢复'
                return h('li', { key: `e${it.at}`, className: 'nsn-tl-item', 'data-kind': 'event', 'data-newsnap': 'tl-event' },
                  h('span', { className: 'nsn-tl-dot' }, icon('IconRefreshOutlineRegular', 11)), h('span', { className: 'nsn-tl-time' }, when(it.at)), h('span', { className: 'nsn-tl-text' }, text))
              }
              const x = it.snap
              return h('li', {
                key: x.id, className: 'nsn-tl-item', 'data-kind': 'snap', 'data-newsnap': 'tl-snap', 'data-snap': x.id, role: 'option', tabIndex: 0,
                'aria-selected': x.id === selected.id, onClick: () => setPicked(x.id),
                onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(x.id) } },
              },
              h('span', { className: 'nsn-tl-dot' }, icon('IconClockOutlineRegular', 13)),
              h('span', { className: 'nsn-tl-time' }, when(x.createdAt)),
              h('span', { className: 'nsn-tl-text' }, x.note || '快照'),
              h('span', { className: 'nsn-mark-meta', style: { fontSize: 12 } }, `${x.sessions} 个会话`))
            })),
          h(CompareView, { key: selected.id, ctx, call, sessionId, snap: selected }))
      }
    }

    function apply(ctx) {
      const call = (method, args) => ctx.connection.rpc.call('/api', `newsnap/${method}`, { args })
      const store = createStore(call)
      ensureStyle()
      ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
        name: 'conversation.chat.commandview',
        key: 'newsnap',
      }, makeBookmark(ctx, store, call)))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'newsnap-restored',
        order: 20,
        inject: (sessionId) => ({ sessionId }),
      }, makeBanner(ctx, store, call)))
      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
        const def = {
          id: TAB_ID, kind: TAB_KIND, priority: 'extension', title: () => '时光机',
          guide: [{ id: 'open', order: 60, title: () => '时光机', description: () => '团队快照时间线，和现在对比', ...(P.IconClockOutlineRegular && { icon: P.IconClockOutlineRegular }) }],
        }
        if (typeof ctx.effect === 'function') ctx.effect(() => ctx.sidebarRightTabs.register(def), 'newsnap: timeline tab')
        else ctx.sidebarRightTabs.register(def)
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_ID,
          inject: (sessionId) => ({ sessionId }),
        }, makeTimeline(ctx, store, call)))
      }
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
