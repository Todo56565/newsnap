// newsnap 网页客户端模块（M5-0 PoC）。手写的 DSH 客户端包格式：
// window.__ModuleLoader__.load({ id, factory(require) })，外部依赖经 require 从平台模块表取（react）。
// 在会话头部挂一个「时光机」按钮，经 connection.rpc.call('/api', 'newsnap/list') 读快照列表。
window.__ModuleLoader__.load({
  id: 'newsnap',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const inject = ['slots', 'connection']

    function fmt(ms) {
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function TimeMachine(props) {
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const load = React.useCallback(async () => {
        const r = await props.call('list', { sessionId: props.sessionId })
        if (r.ok) { setView(r.value); setError(null) } else setError(r.error && (r.error.code || r.error.message) || 'error')
      }, [props.sessionId])
      React.useEffect(() => { load() }, [load])
      const count = view ? view.snapshots.length : 0
      if (view && view.team === null) return null
      return h('div', { 'data-newsnap': 'time-machine', style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          title: error ? `newsnap：${error}` : `newsnap：${count} 个快照`,
          'aria-label': 'newsnap 时光机',
          onClick: () => { setOpen(!open); if (!open) load() },
          style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', opacity: 0.85 },
        }, '⟲', h('span', { 'data-newsnap': 'count', style: { fontSize: 12 } }, error ? '!' : String(count))),
        open && h('div', {
          'data-newsnap': 'popover',
          style: { position: 'absolute', top: '100%', right: 0, marginTop: 6, minWidth: 260, padding: 8, borderRadius: 10, background: 'var(--color-bg-elevated, Canvas)', color: 'inherit', boxShadow: '0 6px 24px rgba(0,0,0,.18)', zIndex: 50, fontSize: 13 },
        },
        h('div', { style: { fontWeight: 600, padding: '2px 4px 6px' } }, view && view.team ? `团队 ${view.team.name} 的快照` : '快照'),
        error && h('div', { style: { color: 'var(--color-text-danger, #c00)', padding: 4 } }, String(error)),
        view && view.snapshots.length === 0 && h('div', { style: { opacity: 0.7, padding: 4 } }, '还没有快照，用 /newsnap snap 拍一张'),
        view && view.snapshots.map((s) => h('div', { key: s.id, 'data-newsnap-row': s.id, style: { display: 'flex', gap: 8, padding: '4px', alignItems: 'baseline' } },
          h('span', { style: { opacity: 0.6 } }, '◆'),
          h('span', null, fmt(s.createdAt)),
          h('span', { style: { flex: 1, opacity: 0.85 } }, s.note || s.id),
          h('span', { style: { opacity: 0.6, fontSize: 12 } }, `${s.sessions} 个会话`))),
        view && view.lastApplied && h('div', { style: { borderTop: '1px solid rgba(127,127,127,.25)', marginTop: 6, paddingTop: 6, opacity: 0.8 } },
          `最近恢复到 ${view.lastApplied.target}（${fmt(view.lastApplied.at)}）${view.lastApplied.canUndo ? '，可撤销' : ''}`)))
    }

    function apply(ctx) {
      const call = (method, args) => ctx.connection.rpc.call('/api', `newsnap/${method}`, { args })
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'newsnap-time-machine',
        order: -6,
        inject: (sessionId) => ({ sessionId, call }),
      }, TimeMachine))
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
