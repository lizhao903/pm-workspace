import { useState } from 'react'
import { PageTitle } from './topbar'
import { AUTH_LABEL, IM_CHANNELS, TOOL_CATEGORIES, TOOLS, fieldView, testedAccount, tokenProblem, type ConnStatus, type Connector, type Tool } from './data'
import { cls, timeAgo } from './ui'

const STATUS: Record<ConnStatus, { label: string; tone: string }> = {
  connected: { label: '已连接', tone: 'ok' },
  error: { label: '异常', tone: 'danger' },
  paused: { label: '已暂停', tone: 'muted' },
  connecting: { label: '连接中', tone: 'info' },
  disconnected: { label: '已断开', tone: 'muted' },
}

/** 断开前的确认文案：列表和抽屉共用 */
const OFF_HINT = '断开后收不到消息，Agent 也调不了它的工具'

/** 抽屉顶部的连接状态条：连着的可以断开，断开的、异常的可以（重新）连接 */
export function ConnBar({ connector, onConnect, onDisconnect }: { connector: Connector; onConnect: () => void; onDisconnect: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const s = connector.status
  const oauth = connector.auth?.mode === 'oauth2'
  return (
    <div className={cls('conn-bar', `cb-${STATUS[s].tone}`)}>
      <StatusDot s={s} />
      <span className="conn-bar-text">
        {s === 'connected' && [connector.account, connector.last_sync_at && `${timeAgo(connector.last_sync_at)}同步`].filter(Boolean).join(' · ')}
        {s === 'connecting' && '正在连接…'}
        {s === 'error' && (connector.error ?? '连接异常')}
        {s === 'paused' && '配置保留，不同步、不调用'}
        {s === 'disconnected' && `配置保留，不同步、不调用${oauth ? '；授权已撤销，重新连接要再授权一次' : ''}`}
      </span>
      {confirm ? (
        <>
          <span className="danger-text">{OFF_HINT}</span>
          <button className="act act-quiet" onClick={() => setConfirm(false)}>取消</button>
          <button className="act btn-danger" onClick={() => { onDisconnect(); setConfirm(false) }}>断开</button>
        </>
      ) : s === 'connected' ? (
        <button className="act" onClick={() => setConfirm(true)}>断开连接</button>
      ) : s === 'connecting' ? null : (
        <button className="act act-primary" onClick={onConnect}>{s === 'error' ? '重新连接' : '连接'}</button>
      )}
    </div>
  )
}

export function ToolLogo({ tool, size = 40, src }: { tool: Tool; size?: number; src?: string }) {
  if (src) return <img className="tool-logo tool-logo-img" src={src} alt="" style={{ width: size, height: size }} />
  const short = IM_CHANNELS.find((c) => c.key === tool.key)?.short ?? tool.label.slice(0, 2)
  return (
    <span className="tool-logo" style={{ width: size, height: size, fontSize: size * (short.length > 2 ? 0.26 : 0.34), ['--c' as string]: tool.color }}>{short}</span>
  )
}

export function StatusDot({ s }: { s: ConnStatus }) {
  return <span className={`conn-status conn-${STATUS[s].tone}`}><i />{STATUS[s].label}</span>
}

/* ---------- IM 消息过期（IM-07）：即时通讯分类下的一行设置，和具体渠道无关 ---------- */

/** 过期天数：整数 0..365，0 为不过期；改了才能保存，超出范围红字说明（正式产品显示后端 400 的原因） */
function ImExpiry({ days, onSave }: { days: number; onSave: (n: number) => void }) {
  const [txt, setTxt] = useState(String(days))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const n = Number(txt)
  const bad = !/^\d+$/.test(txt.trim()) ? '填 0 或正整数' : n > 365 ? '过期天数要在 0 到 365 之间' : null
  const changed = !bad && n !== days
  const save = () => {
    if (bad) { setNote({ ok: false, text: `没保存：${bad}` }); return }
    if (!changed) return
    onSave(n)
    setNote({ ok: true, text: n ? `已保存：超过 ${n} 天没处理的消息标为已过期` : '已保存：消息不再过期' })
  }
  return (
    <div className="im-expiry">
      <span className="im-expiry-label">消息过期</span>
      <input type="number" min={0} max={365} step={1} inputMode="numeric" aria-label="过期天数" className={cls(note && !note.ok && 'bad')}
        value={txt} onChange={(e) => { setTxt(e.target.value); setNote(null) }} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <span className="muted">天</span>
      <button className="btn btn-outline" disabled={txt.trim() === String(days)} onClick={save}>保存</button>
      {note ? <span className={note.ok ? 'ok-text' : 'field-err'}>{note.text}</span>
        : <span className="field-hint-line">超过 N 天没处理的消息标为已过期，0 为不过期。从收到（或重新打开）时算起，设了稍后还没到点的不算</span>}
    </div>
  )
}

/* ---------- 列表（设置页里的一个分项） ---------- */

export function ConnectorsSettings({ connectors, messageCount, initialCat = '', onConfigure, onAdd, onConnect, onDisconnect, imExpireDays, onImExpireDays }: {
  /** IM 消息过期天数（IM-07），显示在即时通讯分类下面；0 为不过期 */
  imExpireDays: number; onImExpireDays: (n: number) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  connectors: Connector[]
  /** 从 IM 消息页「渠道配置」进来时直接落在即时通讯分类 */
  initialCat?: string
  /** 连接器 id -> 收进来的消息数 */
  messageCount: Record<string, number>
  onConfigure: (id: string) => void
  onAdd: (toolKey: string) => void
}) {
  const [cat, setCat] = useState<string>(initialCat)
  /** 列表上点了「断开」、等确认的连接器 */
  const [askOff, setAskOff] = useState<string | null>(null)
  const cats = TOOL_CATEGORIES.filter((c) => !cat || c.key === cat)
  const n = (s: ConnStatus) => connectors.filter((c) => c.status === s).length
  const notLinked = TOOLS.filter((t) => !connectors.some((c) => c.tool === t.key)).length

  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={`${connectors.length} 个已接入`} desc="把外部工具接进工作台，按分类管理；每个工具接一个账号">连接器</PageTitle>

      <section className="stats">
        <div className="stat"><div className="stat-label">已连接</div><div className="stat-value stat-ok">{n('connected')}</div></div>
        <div className="stat"><div className="stat-label">异常</div><div className={cls('stat-value', n('error') > 0 && 'stat-danger')}>{n('error')}</div></div>
        <div className="stat"><div className="stat-label">已断开 / 暂停</div><div className="stat-value">{n('disconnected') + n('paused')}</div></div>
        <div className="stat"><div className="stat-label">可接未接</div><div className="stat-value">{notLinked}</div></div>
      </section>

      <div className="toolbar">
        <div className="seg">
          <button className={cls(!cat && 'on')} onClick={() => setCat('')}>全部分类<span className="seg-n">{TOOLS.length}</span></button>
          {TOOL_CATEGORIES.map((c) => (
            <button key={c.key} className={cls(cat === c.key && 'on')} onClick={() => setCat(c.key)}>
              {c.label}<span className="seg-n">{TOOLS.filter((t) => t.category === c.key).length}</span>
            </button>
          ))}
        </div>
      </div>

      {cats.map((c) => (
        <section key={c.key} className="tool-section">
          <div className="tool-section-head">
            <h2>{c.label}</h2>
            <span className="muted">{c.desc}</span>
          </div>
          {c.key === 'im' && <ImExpiry days={imExpireDays} onSave={onImExpireDays} />}
          <div className="tool-grid">
            {TOOLS.filter((t) => t.category === c.key).map((t) => {
              const mine = connectors.filter((x) => x.tool === t.key)
              return (
                <div key={t.key} className={cls('tool-card', mine.some((x) => x.status === 'error') && 'tool-card-bad')}>
                  <div className="tool-card-top">
                    <ToolLogo tool={t} />
                    <div className="tool-card-text">
                      <div className="tool-name">{t.label}</div>
                      <div className="tool-desc">{t.desc}</div>
                    </div>
                  </div>
                  {mine.length > 0 ? (
                    <div className="conn-list">
                      {mine.map((x) => (
                        <div key={x.id} role="button" tabIndex={0} className="conn-row" onClick={() => onConfigure(x.id)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onConfigure(x.id)}>
                          <div className="conn-row-main">
                            {x.icon && <ToolLogo tool={t} src={x.icon} size={18} />}
                            <span className="conn-name ellipsis">{x.name}</span>
                            <span className="conn-account ellipsis">{x.account}</span>
                            <span className="spacer" />
                            {/* 列表上的断开和抽屉里一样先确认：行内换成「取消 / 断开」 */}
                            {x.status === 'connected' && askOff === x.id && (
                              <>
                                <button className="act act-quiet conn-act" onClick={(e) => { e.stopPropagation(); setAskOff(null) }}>取消</button>
                                <button className="act btn-danger conn-act" onClick={(e) => { e.stopPropagation(); onDisconnect(x.id); setAskOff(null) }}>断开</button>
                              </>
                            )}
                            {x.status === 'connected' && askOff !== x.id && <button className="act act-quiet conn-act" onClick={(e) => { e.stopPropagation(); setAskOff(x.id) }} title="断开后配置保留，随时可以再连">断开</button>}
                            {(x.status === 'disconnected' || x.status === 'paused' || x.status === 'error') && <button className="act conn-act" onClick={(e) => { e.stopPropagation(); onConnect(x.id) }}>{x.status === 'error' ? '重连' : '连接'}</button>}
                          </div>
                          {x.status === 'connected' && askOff === x.id ? <div className="conn-row-side danger-text">{OFF_HINT}</div> : (
                            <div className="conn-row-side">
                              <StatusDot s={x.status} />
                              <span className="faint">{x.auth
                                ? `${AUTH_LABEL[x.auth.mode]} · ${x.tools?.filter((t) => t.mode !== 'off').length ?? 0}/${x.tools?.length ?? 0} 个工具可用`
                                : `${x.direction === 'both' ? '收发' : '只收'} · ${messageCount[x.id] ?? 0} 条 · ${x.last_sync_at ? timeAgo(x.last_sync_at) : '未同步'}`}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="conn-none">还没有接入</div>
                  )}
                  {/* 一个工具只接一个账号：接过了就不再给「接入」，改配置点上面那一行 */}
                  {!mine.length && (
                    <div className="tool-card-foot">
                      <button className="btn btn-primary" onClick={() => onAdd(t.key)}>接入</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ---------- 配置抽屉：新建 / 编辑共用 ---------- */

type Draft = Pick<Connector, 'name' | 'config' | 'direction' | 'interval'> & { enabled: boolean }
type TestResult = { ok: boolean; text: string } | null

export function ConnectorDrawer({ tool, connector, onClose, onSave, onDelete, onConnect, onDisconnect, delImpact }: {
  onConnect?: () => void
  onDisconnect?: () => void
  tool: Tool
  connector: Connector | null
  onClose: () => void
  onSave: (d: Omit<Connector, 'id' | 'created_at'>) => void
  onDelete: () => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
}) {
  const creating = !connector
  const [d, setD] = useState<Draft>(() => connector
    ? { name: connector.name, config: { ...connector.config }, direction: connector.direction, interval: connector.interval, enabled: connector.status !== 'paused' }
    : { name: tool.label, config: Object.fromEntries(tool.fields.filter((f) => f.kind === 'select').map((f) => [f.key, f.options![0]])), direction: tool.canSend ? 'both' : 'receive', interval: 5, enabled: true })
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [test, setTest] = useState<TestResult>(null)
  const [testing, setTesting] = useState(false)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  const missing = tool.fields.filter((f) => f.required && !d.config[f.key]?.trim())
  const setCfg = (k: string, v: string) => { setD((x) => ({ ...x, config: { ...x.config, [k]: v } })); setTest(null) }

  // Slack 的 Token 和身份对不上（IM-06）：测试不调对方直接失败，保存后连接器是异常
  const problem = tokenProblem(tool.key, d.config)

  // 原型里的「测试连接」只校验必填项。wechat 的 secret 填成 expired 时模拟一次失败，方便看失败态
  const runTest = () => {
    setTesting(true); setTest(null)
    window.setTimeout(() => {
      setTesting(false)
      if (missing.length) setTest({ ok: false, text: `缺少必填项：${missing.map((f) => f.label).join('、')}` })
      else if (problem) setTest({ ok: false, text: problem })
      else if (Object.values(d.config).includes('expired')) setTest({ ok: false, text: '对方平台返回凭证无效（40001），请重新获取后再试' })
      else setTest({ ok: true, text: `连接成功，能读到 ${tool.label} 的会话列表` })
    }, 700)
  }

  const save = () => {
    setTried(true)
    if (missing.length || !d.name.trim()) return
    const bad = Object.values(d.config).includes('expired') || !!problem
    // 换了 Slack 身份：账号跟着换成 Bot 或我本人（原型里模拟连通测试的结果）
    const reTest = connector && tool.key === 'slack' && connector.config.identity !== d.config.identity
    onSave({
      tool: tool.key,
      name: d.name.trim(),
      account: reTest ? testedAccount(tool.key, d.config, connector.account) : connector?.account ?? '待首次同步',
      status: !d.enabled ? 'paused' : bad ? 'error' : 'connected',
      error: bad ? problem ?? connector?.error ?? '凭证无效' : undefined,
      config: d.config,
      direction: d.direction,
      interval: d.interval,
      last_sync_at: connector?.last_sync_at ?? null,
    })
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? `接入 ${tool.label}` : '配置连接器'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <div className="profile">
          <ToolLogo tool={tool} size={48} />
          <div className="profile-text">
            <h2>{tool.label}</h2>
            <div className="muted">{TOOL_CATEGORIES.find((c) => c.key === tool.category)?.label} · {tool.desc}</div>
          </div>
        </div>

        {connector && onConnect && onDisconnect && <ConnBar connector={connector} onConnect={onConnect} onDisconnect={onDisconnect} />}

        <label className="field">
          <span className="field-label">连接器名称<em>*</em></span>
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="例如 公司 Slack" className={cls(tried && !d.name.trim() && 'bad')} />
        </label>

        <div className="field-group">
          <div className="field-group-title">凭证与参数</div>
          {tool.fields.map((f) => { const v = fieldView(tool.key, f, d.config); return (
            <label key={f.key} className="field">
              <span className="field-label">{v.label}{f.required && <em>*</em>}</span>
              {f.kind === 'select' ? (
                <select className="select" value={d.config[f.key] ?? ''} onChange={(e) => setCfg(f.key, e.target.value)}>
                  {f.options!.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <div className="secret">
                  <input type={f.kind === 'secret' && !reveal[f.key] ? 'password' : 'text'} value={d.config[f.key] ?? ''} placeholder={v.placeholder}
                    className={cls(tried && f.required && !d.config[f.key]?.trim() && 'bad', f.kind === 'secret' && 'mono')}
                    onChange={(e) => setCfg(f.key, e.target.value)} />
                  {f.kind === 'secret' && (
                    <button type="button" className="secret-toggle" onClick={(e) => { e.preventDefault(); setReveal({ ...reveal, [f.key]: !reveal[f.key] }) }}>
                      {reveal[f.key] ? '隐藏' : '显示'}
                    </button>
                  )}
                </div>
              )}
              {v.hint && <span className="field-hint-line">{v.hint}</span>}
            </label>
          ) })}
          <div className="test-row">
            <button className="btn btn-ghost btn-outline" onClick={runTest} disabled={testing}>{testing ? '测试中…' : '测试连接'}</button>
            {test && <span className={test.ok ? 'test-ok' : 'test-bad'}>{test.text}</span>}
          </div>
        </div>

        <div className="field-group">
          <div className="field-group-title">同步</div>
          <div className="field">
            <span className="field-label">消息方向</span>
            <div className="seg seg-full">
              <button type="button" className={cls(d.direction === 'receive' && 'on')} onClick={() => setD({ ...d, direction: 'receive' })}>只收消息</button>
              <button type="button" className={cls(d.direction === 'both' && 'on')} disabled={!tool.canSend} onClick={() => setD({ ...d, direction: 'both' })}>收发（可在工作台回复）</button>
            </div>
          </div>
          <label className="field">
            <span className="field-label">拉取间隔</span>
            <select className="select" value={d.interval} onChange={(e) => setD({ ...d, interval: Number(e.target.value) })}>
              {[1, 5, 10, 15, 30, 60].map((x) => <option key={x} value={x}>每 {x} 分钟</option>)}
            </select>
          </label>
          <label className="switch-row">
            <span>
              <span className="field-label">启用</span>
              <span className="switch-hint">暂停后不再拉取新消息，已收进来的消息保留</span>
            </span>
            <input type="checkbox" className="switch" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
          </label>
        </div>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">{delImpact?.length ? `删除后不再同步：${delImpact.join('；')}` : '删除后不再同步，已收的消息保留'}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除连接器</button>}
            <div className="spacer" />
            {tried && (missing.length > 0 || !d.name.trim()) && <span className="field-err">还没填：{[...(d.name.trim() ? [] : ['连接器名称']), ...missing.map((f) => f.label)].join('、')}</span>}
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '接入' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}
