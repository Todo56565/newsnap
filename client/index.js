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

    const inject = ['slots', 'connection']

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

    // 其他子命令：照 DSH 的 GenericCommandCard 画（DisclosureRow + 摘要，多行输出可展开）
    function GenericRow({ node }) {
      const [open, setOpen] = useState(false)
      const text = node.outcome ? node.outcome.text : undefined
      const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
      const summary = node.outcome === null ? '执行中…' : (text || (state === 'error' ? '失败' : '完成'))
      const body = text !== undefined && text.includes('\n') ? text : null
      const sub = (node.args || '').trim().split(/\s+/)[0]
      return h('div', { className: 'nsn-cmd', 'data-newsnap': 'command', 'data-state': state },
        h(DisclosureRow, {
          titleClassName: 'nsn-cmd-title',
          icon: icon('IconClockOutlineRegular'),
          title: sub ? `newsnap ${sub}` : 'newsnap',
          running: state === 'running',
          open: open && body !== null,
          expandable: body !== null,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setOpen((v) => !v),
          collapsedContent: h(React.Fragment, null,
            h('span', { className: 'nsn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
            h('span', { className: 'nsn-summary', 'data-error': state === 'error' || undefined }, h(TextShimmer, null, body ? summary.split('\n')[0] : summary))),
        }, open && body !== null ? h('pre', { className: 'nsn-body', 'data-error': state === 'error' || undefined }, body) : undefined))
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
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
