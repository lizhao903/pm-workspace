// 设置里的「连接器」分节（CONN-01d），照原型 web-next/src/connectors.tsx ConnectorsSettings（SPEC-settings-3）。
// 可以接哪些工具由后端定义列表决定，按分类分组；同一工具可以接多个（CONN-04），右上「添加连接器」打开按分类的目录。
// 和原型不同的地方（后端决定的）：
// - 连接 = 启用（暂停中的先 PATCH enabled）再做一次连通测试；断开先落成暂停，主动断开（disconnected）归 CONN-01b。
// - 后端的 connecting 是「接入后还没测过」，行上照样给「连接」。
// - 删除前的影响检查归 CONN-03，现在只确认删除。
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  errorText, QueryState, useConnectorDefs, useConnectors, usePatchConnector, useTestConnector,
  type Connector, type ConnectorDef,
} from '../../../core/data'
import { Button, cls, Drawer, EmptyState, PageTitle } from '../../../core/ui'
import { AUTH_LABEL, CATEGORIES, categoryOf, OFF_HINT, OTHER } from './catalog'
import { ConnectorDrawer } from './ConnectorDrawer'
import { fallbackDef, rowSummary, type ConnCheck } from './model'
import { StatusDot, ToolLogo } from './parts'
import './connectors.css'

// 新建成功后换成编辑同一条，slot 沿用新建时的 key，抽屉不重新挂载
type Open = { mode: 'new'; tool: string } | { mode: 'edit'; id: string; slot?: string }

export function ConnectorsSection() {
  const defsQ = useConnectorDefs()
  const listQ = useConnectors()
  const test = useTestConnector()
  const patch = usePatchConnector()
  const [open, setOpen] = useState<Open | null>(null)
  const [cat, setCat] = useState('')
  const [askOff, setAskOff] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [checks, setChecks] = useState<Record<string, ConnCheck>>({})
  const [testErrors, setTestErrors] = useState<Record<string, unknown>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState(false)

  // 定义随插件启停出现、隐藏（CONN-02），插件管理那边改了不会通知这里：进来时缓存里已有的重新取一次，
  // 免得停用的插件的工具还在、重新启用的还挂在「提供方已停用」里
  const refreshed = useRef(false)
  useEffect(() => {
    if (refreshed.current) return
    refreshed.current = true
    if (!defsQ.isFetching) void defsQ.refetch()
    if (!listQ.isFetching) void listQ.refetch()
  }, [defsQ, listQ])

  const defs = defsQ.data ?? []
  const list = listQ.data ?? []
  const defOf = (tool: string) => defs.find((d) => d.tool === tool)
  const namesOf = (tool: string) => list.filter((c) => c.tool === tool).map((c) => c.name)
  const add = (tool: string) => { setCatalog(false); setOpen({ mode: 'new', tool }) }

  function runTest(id: string) {
    setPending((m) => ({ ...m, [id]: true }))
    setTestErrors((m) => ({ ...m, [id]: undefined }))
    test.mutate(id, {
      onSuccess: (r) => setChecks((m) => ({ ...m, [id]: { ok: r.ok, message: r.message, at: Date.now() } })),
      onError: (e) => setTestErrors((m) => ({ ...m, [id]: e })),
      onSettled: () => setPending((m) => ({ ...m, [id]: false })),
    })
  }

  // 暂停、断开的先启用再测；异常、还没测过的直接测
  function connect(c: Connector) {
    setActionError(null)
    if (c.status !== 'paused' && c.status !== 'disconnected') { runTest(c.id); return }
    setPending((m) => ({ ...m, [c.id]: true }))
    patch.mutate({ id: c.id, patch: { enabled: true } }, {
      onSuccess: () => runTest(c.id),
      onError: (e) => {
        setPending((m) => ({ ...m, [c.id]: false }))
        setActionError(`连接「${c.name}」失败：${errorText(e)}`)
      },
    })
  }

  function disconnect(c: Connector) {
    setActionError(null)
    patch.mutate({ id: c.id, patch: { enabled: false } }, {
      onError: (e) => setActionError(`断开「${c.name}」失败：${errorText(e)}`),
    })
  }

  const editing = open?.mode === 'edit' ? list.find((c) => c.id === open.id) : undefined
  const n = (...s: Connector['status'][]) => list.filter((c) => s.includes(c.status)).length
  const notLinked = defs.filter((d) => !list.some((c) => c.tool === d.tool)).length
  // 只列有工具的分类；不认识的分类归「其他」，排最后
  const cats = [...CATEGORIES, OTHER].filter((c) => defs.some((d) => categoryOf(d.category).key === c.key))
  const shownCats = cats.filter((c) => !cat || c.key === cat)
  const orphans = list.filter((c) => !c.available || !defOf(c.tool))

  const row = (c: Connector, def: ConnectorDef | undefined) => {
    const busy = !!pending[c.id]
    const asking = askOff === c.id && c.status === 'connected'
    const act = (e: MouseEvent, f: () => void) => { e.stopPropagation(); f() }
    return (
      <div key={c.id} role="button" tabIndex={0} className={cls('cn-row', editing?.id === c.id && 'sel')} data-connector={c.id}
        onClick={() => setOpen({ mode: 'edit', id: c.id })}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen({ mode: 'edit', id: c.id }) }}>
        <div className="cn-row-main">
          {c.icon && <img className="cn-row-icon" src={c.icon} alt="" aria-hidden="true" />}
          <span className="cn-name ellipsis" title={c.name}>{c.name}</span>
          <span className="cn-account ellipsis">{c.account}</span>
          <span className="spacer" />
          {/* 行上断开和抽屉里一样先确认：按钮换成「取消 / 断开」 */}
          {!busy && asking && (
            <>
              <Button size="sm" onClick={(e) => act(e, () => setAskOff(null))}>取消</Button>
              <Button size="sm" variant="danger" onClick={(e) => act(e, () => { setAskOff(null); disconnect(c) })}>断开</Button>
            </>
          )}
          {!busy && !asking && c.status === 'connected' && (
            <Button size="sm" title="断开后配置保留，随时可以再连" onClick={(e) => act(e, () => setAskOff(c.id))}>断开</Button>
          )}
          {!busy && c.status !== 'connected' && c.available && (
            <Button size="sm" variant="outline" onClick={(e) => act(e, () => connect(c))}>{c.status === 'error' ? '重连' : '连接'}</Button>
          )}
        </div>
        {asking && !busy ? <div className="cn-row-side danger-text">{OFF_HINT}</div> : (
          <div className="cn-row-side">
            <StatusDot s={c.status} pending={busy} />
            <span className="cn-faint ellipsis">{rowSummary(def, c, AUTH_LABEL[c.auth_mode] ?? c.auth_mode)}</span>
          </div>
        )}
      </div>
    )
  }

  const card = (d: ConnectorDef) => {
    const mine = list.filter((c) => c.tool === d.tool && c.available)
    return (
      <div key={d.tool} className={cls('cn-card', mine.some((c) => c.status === 'error') && 'cn-card-bad')} data-tool={d.tool}>
        <div className="cn-card-top">
          <ToolLogo def={d} />
          <div className="cn-card-text">
            <div className="cn-tool-name">{d.label}</div>
            <div className="cn-tool-desc">{d.desc}</div>
          </div>
        </div>
        {mine.length ? <div className="cn-list">{mine.map((c) => row(c, d))}</div> : <div className="cn-none">还没有接入</div>}
        {/* 同一工具可以接多个：接过了给「再接一个」，改配置点上面那一行 */}
        <div className="cn-card-foot">
          {mine.length
            ? <Button variant="outline" onClick={() => add(d.tool)}>再接一个</Button>
            : <Button variant="primary" onClick={() => add(d.tool)}>接入</Button>}
        </div>
      </div>
    )
  }

  const drawerDef = open?.mode === 'new' ? defOf(open.tool) : editing ? (editing.available && defOf(editing.tool)) || fallbackDef(editing) : undefined

  return (
    <div className="page cn-page">
      <PageTitle parent="设置" count={listQ.data ? `${list.length} 个已接入` : undefined}
        desc="把外部工具接进工作台，按分类管理；同一工具可以接多个账号"
        actions={defs.length > 0 && <Button variant="primary" onClick={() => { setOpen(null); setCatalog(true) }}>添加连接器</Button>}>连接器</PageTitle>
      {actionError && <div className="cn-alert" role="alert">{actionError}</div>}
      <QueryState query={defsQ}>
        {() => (
          <QueryState query={listQ}>
            {() => (
              <>
                <section className="cn-stats" aria-label="统计">
                  <div className="cn-stat"><div className="cn-stat-label">已连接</div><div className="cn-stat-value cn-ok">{n('connected')}</div></div>
                  <div className="cn-stat"><div className="cn-stat-label">异常</div><div className={cls('cn-stat-value', n('error') > 0 && 'cn-danger')}>{n('error')}</div></div>
                  <div className="cn-stat"><div className="cn-stat-label">已断开 / 暂停</div><div className="cn-stat-value">{n('disconnected', 'paused')}</div></div>
                  <div className="cn-stat"><div className="cn-stat-label">可接未接</div><div className="cn-stat-value">{notLinked}</div></div>
                </section>

                {!defs.length && !orphans.length ? (
                  <EmptyState title="还没有可以接入的工具"
                    desc="连接器由工作台和插件登记，GitHub 等真实连接器接通后会出现在这里" />
                ) : (
                  <>
                    {cats.length > 0 && (
                      <div className="cn-seg" role="group" aria-label="分类">
                        <button type="button" className={cls(!cat && 'on')} aria-pressed={!cat} onClick={() => setCat('')}>
                          全部分类<span className="seg-n">{defs.length}</span>
                        </button>
                        {cats.map((c) => (
                          <button key={c.key} type="button" className={cls(cat === c.key && 'on')} aria-pressed={cat === c.key} onClick={() => setCat(c.key)}>
                            {c.label}<span className="seg-n">{defs.filter((d) => categoryOf(d.category).key === c.key).length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {shownCats.map((c) => (
                      <section key={c.key} className="cn-section" aria-label={c.label}>
                        <div className="cn-section-head"><h2>{c.label}</h2>{c.desc && <span className="cn-faint">{c.desc}</span>}</div>
                        <div className="cn-grid">{defs.filter((d) => categoryOf(d.category).key === c.key).map(card)}</div>
                      </section>
                    ))}
                    {!cat && orphans.length > 0 && (
                      <section className="cn-section" aria-label="提供方已停用">
                        <div className="cn-section-head"><h2>提供方已停用</h2><span className="cn-faint">提供它们的插件停用了，只能改名、启停和删除</span></div>
                        <div className="cn-list cn-orphans">{orphans.map((c) => row(c, undefined))}</div>
                      </section>
                    )}
                  </>
                )}
              </>
            )}
          </QueryState>
        )}
      </QueryState>

      <Drawer open={catalog} onClose={() => setCatalog(false)} kicker="添加连接器" className="cn-catalog" aria-label="添加连接器">
        <div className="cn-catalog-body">
          <div className="cn-faint">选一个工具接入；自己的服务选「自定义」里的 MCP 服务或 OpenAPI 接口，填地址和认证就能用</div>
          {cats.map((cg) => (
            <section key={cg.key} className="cn-catalog-group" aria-label={`目录：${cg.label}`}>
              <div className="cn-group-title">{cg.label}</div>
              {defs.filter((d) => categoryOf(d.category).key === cg.key).map((d) => {
                const n = list.filter((c) => c.tool === d.tool).length
                return (
                  <div key={d.tool} className="cn-catalog-row" data-tool={d.tool}>
                    <ToolLogo def={d} size={32} />
                    <span className="cn-catalog-text">
                      <span className="cn-tool-name">{d.label}{n > 0 && <span className="cn-group-hint">已接 {n} 个</span>}</span>
                      <span className="cn-tool-desc">{d.desc}</span>
                    </span>
                    <Button size="sm" variant={n ? 'outline' : 'primary'} aria-label={`${n ? '再接一个' : '接入'} ${d.label}`}
                      onClick={() => add(d.tool)}>{n ? '再接一个' : '接入'}</Button>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      </Drawer>

      {open && drawerDef && (open.mode === 'new' ? (
        <ConnectorDrawer key={`new-${open.tool}`} def={drawerDef} taken={namesOf(open.tool)} pending={false} onTest={runTest}
          onCreated={(c) => setOpen({ mode: 'edit', id: c.id, slot: `new-${open.tool}` })} onClose={() => setOpen(null)} />
      ) : editing ? (
        <ConnectorDrawer key={open.slot ?? editing.id} def={drawerDef} connector={editing} check={checks[editing.id]}
          pending={!!pending[editing.id]} testError={testErrors[editing.id]} onTest={runTest}
          onConnect={() => connect(editing)} onDisconnect={() => disconnect(editing)}
          onCreated={() => undefined} onClose={() => setOpen(null)} />
      ) : null)}
    </div>
  )
}
