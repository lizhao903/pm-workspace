// 交易账户（TRD-07b，SPEC-trading-8、9、12）：账户卡片、新增账户抽屉、对账抽屉、实盘账户的交易所数据。
// 交互照原型 web-next/src/trading.tsx 的 AccountsView、AccountDrawer、ReconDrawer；和原型有出入的地方见 web-next/docs/spec/trading.md「正式前端」。
// - 模拟盘本地撮合；实盘账户（Binance、OKX）同步余额持仓：凭证走内核连接器（建连接器 → 测试连接 → 建账户，放弃时删掉连接器）。
//   连接器的密钥字段进 secrets，其余（「网络」正式网 / 测试网等）进 config。
// - 实盘下单（TRD-08d）：账户 trade_ready（闸门全开）时卡片上的「下单」可用、交易所数据里能平仓和撤掉全部挂单（都要确认）；
//   不然「下单」不可点，旁边逐条写 trade_blockers。
// - Bybit、券商还没有连接器，抽屉里归到不可用。
import { useEffect, useRef, useState } from 'react'
import {
  errorText, isApiError, useConnectTradeAccount, useConnectorDefs, useCreateConnector, useCreateLiveAccount, useCreateTradeAccount,
  useDeleteConnector, useDisconnectTradeAccount, usePatchConnector, useRecheckRecon, useRemoveTradeAccount, useResolveRecon,
  tradePlaceError, useCancelAllTradeOrders, useCloseTradePosition, useTestConnector, useTradeLiveFills, useTradeLiveSnapshot, useTradeRecon,
  type TradeAccount, type TradeLivePosition, type TradePlaceError, type TradePosition, type TradeReconItem,
} from '../../core/data'
import { Button, Drawer, EmptyState, ErrorState, LoadingState, cls } from '../../core/ui'
import { MARKETS, guessInstrument } from './model'
import { LIVE_RISK, ago, fmtQty, fmtTime, liveBlock, num, reconText, signed, tone } from './tradingModel'

const STATUS: Record<string, { label: string; tone: string }> = {
  connected: { label: '已连接', tone: 'ok' }, error: { label: '异常', tone: 'danger' }, disconnected: { label: '已断开', tone: 'muted' },
}

/* ---------- 账户卡片（SPEC-trading-8） ---------- */

export function AccountsView({ accounts, positions, onNew, onRecon, onLiveData, onOrder }: {
  accounts: TradeAccount[]; positions: TradePosition[]
  onNew: () => void; onRecon: (id: string) => void; onLiveData: (id: string) => void; onOrder: (id: string) => void
}) {
  if (!accounts.length) {
    return <EmptyState title="还没有接入交易账户" desc="接入交易所的 API（只读），或者先开一个模拟盘" action={<Button variant="primary" onClick={onNew}>新增账户</Button>} />
  }
  return (
    <div className="tr-cards">
      {accounts.map((a) => a.paper
        ? <AccountCard key={a.id} a={a} positions={positions.filter((p) => p.account_id === a.id).length} />
        : <LiveAccountCard key={a.id} a={a} onRecon={() => onRecon(a.id)} onLiveData={() => onLiveData(a.id)} onOrder={() => onOrder(a.id)} />)}
    </div>
  )
}

function CardHead({ a, status }: { a: TradeAccount; status: { label: string; tone: string } }) {
  return (
    <>
      <div className="tr-card-head">
        <span className="tr-card-title ellipsis" title={a.name}>{a.name}</span>
        <span className={`tr-conn tr-conn-${status.tone}`}><i />{status.label}</span>
      </div>
      <div className="tr-card-sub">
        <span className={cls('tag tr-tag-sm', !a.paper && 'tr-tag-live')}>{a.paper ? '模拟' : '实盘'}</span>
        <span className="ellipsis">{a.broker} · 交易所 · {a.markets.map((m) => MARKETS[m]?.label ?? m).join(' / ')}</span>
      </div>
    </>
  )
}

function CardNums({ a }: { a: TradeAccount }) {
  return (
    <div className="tr-card-nums">
      <div><span className="tr-stat-label">权益</span><b className="tr-num" title={num(a.equity, 2)}>{num(a.equity, 2)}</b></div>
      <div><span className="tr-stat-label">可用</span><b className="tr-num" title={num(a.available, 2)}>{num(a.available, 2)}</b></div>
      <div><span className="tr-stat-label">保证金</span><b className="tr-num" title={num(a.margin_used, 2)}>{num(a.margin_used, 2)}</b></div>
    </div>
  )
}

/** 删除：先确认，后端拦下（模拟盘还有持仓、挂单、没停的部署）时原样写原因 */
function DeleteFoot({ a, onCancel }: { a: TradeAccount; onCancel: () => void }) {
  const remove = useRemoveTradeAccount()
  if (remove.error) {
    return (
      <>
        <span className="tr-small danger-text tr-foot-msg">不能删除：{errorText(remove.error)}</span>
        <span className="spacer" />
        <Button size="sm" onClick={() => { remove.reset(); onCancel() }}>知道了</Button>
      </>
    )
  }
  return (
    <>
      <span className="tr-small danger-text tr-foot-msg">
        {a.paper ? '删除后不能恢复，已停止的运行和成交记录保留' : '只删交易套件里的账户和本地记录，交易所那边不动；连接器（凭证）保留，要到设置 / 连接器里删'}
      </span>
      <span className="spacer" />
      <Button size="sm" onClick={onCancel}>取消</Button>
      <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>{remove.isPending ? '删除中…' : '删除'}</Button>
    </>
  )
}

function AccountCard({ a, positions }: { a: TradeAccount; positions: number }) {
  const [askDel, setAskDel] = useState(false)
  return (
    <section className="tr-card" aria-label={a.name}>
      <CardHead a={a} status={STATUS.connected} />
      <CardNums a={a} />
      <div className="tr-kv"><span>币种</span><b>{a.currency}</b></div>
      <div className="tr-kv"><span>撮合</span><b>{a.api_hint || '本地模拟撮合'} · 手续费万分之 {num(a.fee_bp, 1)} · 滑点 {a.slippage_ticks} 跳</b></div>
      <div className="tr-kv"><span>盈亏</span><b className="tr-num"><span style={{ color: tone(a.realized_pnl) }}>已实现 {signed(a.realized_pnl)}</span> · 手续费 {num(a.fees, 2)}</b></div>
      <div className="tr-kv"><span>持仓</span><b>{positions} 个 · 估值于 {ago(a.updated_at)}</b></div>
      <div className="tr-kv"><span>对账</span><b className="faint">本地撮合，不用对账</b></div>
      <div className="tr-card-foot">
        {askDel ? <DeleteFoot a={a} onCancel={() => setAskDel(false)} /> : (
          <>
            <span className="spacer" />
            <Button size="sm" onClick={() => setAskDel(true)}>删除账户</Button>
          </>
        )}
      </div>
    </section>
  )
}

function LiveAccountCard({ a, onRecon, onLiveData, onOrder }: { a: TradeAccount; onRecon: () => void; onLiveData: () => void; onOrder: () => void }) {
  const [ask, setAsk] = useState<'' | 'off' | 'del'>('')
  const connect = useConnectTradeAccount()
  const disconnect = useDisconnectTradeAccount()
  const snap = useTradeLiveSnapshot(a.id, a.status !== 'disconnected')
  const busy = connect.isPending || disconnect.isPending
  const st = connect.isPending ? { label: '连接中', tone: 'info' } : STATUS[a.status] ?? STATUS.error
  const rc = reconText(a.recon)
  const trade = a.permissions.includes('trade')
  const n = snap.data?.positions.length
  const block = liveBlock(a)
  return (
    <section className={cls('tr-card', a.status === 'error' && 'tr-card-bad')} aria-label={a.name}>
      <CardHead a={a} status={st} />
      {a.status === 'error' && (
        <div className="tr-inline-msg tr-inline-bad" role="alert">
          <span>{a.error || '连接异常'}</span>
          <Button size="sm" disabled={busy} onClick={() => connect.mutate(a.id)}>{connect.isPending ? '连接中…' : '重新连接'}</Button>
        </div>
      )}
      {connect.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>没连上：{errorText(connect.error)}</span></div>}
      <CardNums a={a} />
      <div className="tr-kv"><span>币种</span><b>{a.currency}<span className="faint">（估值折 USD{a.marks_status === 'stale' ? '，有的币取不到价没计入' : ''}）</span></b></div>
      <div className="tr-kv"><span>API</span><b className="mono">{a.api_hint}</b></div>
      <div className="tr-kv"><span>权限</span>
        <b>{trade ? '读取 + 交易' : '只读'}<span className="faint">，不开提币{a.want_trade && !trade ? '；要了交易权限，但 Key 只有读取' : ''}</span></b>
      </div>
      <div className="tr-kv"><span>持仓</span><b>{n === undefined ? '-' : `${n} 个`} · 同步于 {a.synced_at ? ago(a.synced_at) : '还没同步成功'}</b></div>
      <div className="tr-kv"><span>对账</span>
        <button type="button" className={cls('tr-link tr-recon-link', rc.bad && 'danger-text')} onClick={onRecon}>
          {rc.text}{a.recon?.at ? ` · ${ago(a.recon.at)}` : ''}<span className="faint">，查看</span>
        </button>
      </div>
      {block ? (
        <div className="tr-live-note" title={block}>
          <Button size="sm" disabled title={block}>下单</Button>
          <span className="faint tr-small">
            实盘不能下单，现在只读同步：
            {a.trade_blockers?.length ? <ul className="tr-banner-list">{a.trade_blockers.map((x) => <li key={x}>{x}</li>)}</ul> : '要先过实盘评审、申请 trade:live、打开实盘开关（交易设置）'}
          </span>
        </div>
      ) : (
        <div className="tr-live-note">
          <Button size="sm" variant="primary" onClick={onOrder}>下单</Button>
          <span className="tr-small"><span className="tag tr-tag-sm tr-tag-live">实盘</span> 闸门全开，可以下单：{LIVE_RISK}，每笔都要二次确认</span>
        </div>
      )}
      <div className="tr-card-foot">
        {ask === 'del' ? <DeleteFoot a={a} onCancel={() => setAsk('')} /> : ask === 'off' ? (
          <>
            <span className="tr-small danger-text tr-foot-msg">断开后不再同步、不对账；交易所那边和连接器都不动</span>
            <span className="spacer" />
            <Button size="sm" onClick={() => setAsk('')}>取消</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => disconnect.mutate(a.id, { onSettled: () => setAsk('') })}>断开</Button>
          </>
        ) : (
          <>
            {a.status === 'connected' && <Button size="sm" disabled={busy} onClick={() => setAsk('off')}>断开连接</Button>}
            {a.status === 'disconnected' && <Button size="sm" variant="primary" disabled={busy} onClick={() => connect.mutate(a.id)}>{connect.isPending ? '连接中…' : '连接'}</Button>}
            <Button size="sm" onClick={onLiveData}>交易所数据</Button>
            <span className="spacer" />
            <Button size="sm" onClick={() => setAsk('del')}>删除账户</Button>
          </>
        )}
      </div>
    </section>
  )
}

/* ---------- 新增账户抽屉（SPEC-trading-9） ---------- */

type BrokerDef = { key: string; label: string; markets: string; tool?: string; paper?: boolean; off?: string; note: string }
const BROKERS: BrokerDef[] = [
  { key: 'binance', label: 'Binance', markets: '数币', tool: 'binance_account', note: '在币安「API 管理」创建，只读同步勾「读取」就够；要实盘下单再勾现货 / 合约交易。不要勾提币、内部划转、万向划转，建议绑 IP 白名单' },
  { key: 'okx', label: 'OKX', markets: '数币', tool: 'okx_account', note: '权限选「读取」；要实盘下单再选「交易」。不选「提币」' },
  { key: 'paper', label: '模拟', markets: '数币', paper: true, note: '本地模拟撮合，按后端行情成交，不连真实账户；现在只有数币有行情源' },
  { key: 'bybit', label: 'Bybit', markets: '数币', off: '还没有连接器', note: '' },
  { key: 'futu', label: '富途', markets: '港股 / 美股', off: '还没有连接器', note: '' },
  { key: 'tiger', label: '老虎', markets: '港股 / 美股', off: '还没有连接器', note: '' },
  { key: 'ibkr', label: '盈透 IBKR', markets: '美股 / 港股', off: '还没有连接器', note: '' },
  { key: 'htsc', label: '华泰', markets: 'A 股', off: '还没有连接器', note: '' },
  { key: 'citic', label: '中信', markets: 'A 股', off: '还没有连接器', note: '' },
]

type TestState = { state: 'idle' | 'testing' | 'ok' | 'fail'; msg?: string }
/** 连接器「网络」字段（env）的中文 */
const ENV_LABEL: Record<string, string> = { mainnet: '正式网', testnet: '测试网（只给联调用，资金不是真钱）' }

export function AccountDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (a: TradeAccount) => void }) {
  const [bk, setBk] = useState('binance')
  const b = BROKERS.find((x) => x.key === bk) ?? BROKERS[0]
  const [name, setName] = useState('Binance 账户')
  const [vals, setVals] = useState<Record<string, string>>({})
  const [capital, setCapital] = useState('100000')
  const [trade, setTrade] = useState(false)
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  // 测试时建的连接器：保存时拿去建账户；放弃、换交易所时删掉，免得凭证留在保险箱里
  const [connId, setConnId] = useState('')
  const [synced, setSynced] = useState(false)
  const pending = useRef('')
  const defs = useConnectorDefs()
  const createConn = useCreateConnector()
  const patchConn = usePatchConnector()
  const testConn = useTestConnector()
  const delConn = useDeleteConnector()
  const createLive = useCreateLiveAccount()
  const createPaper = useCreateTradeAccount()
  const del = useRef(delConn.mutate)
  useEffect(() => { del.current = delConn.mutate })
  // 抽屉被关掉（含切走页面）时还没用上的连接器删掉
  useEffect(() => () => { if (pending.current) del.current(pending.current) }, [])

  const def = b.tool ? defs.data?.find((d) => d.tool === b.tool) : undefined
  const fields = (def?.fields ?? []).filter((f) => !f.auth || f.auth.includes('token'))
  const dropConn = () => {
    if (pending.current) delConn.mutate(pending.current)
    pending.current = ''
    setConnId('')
  }
  const pick = (k: string) => {
    const nb = BROKERS.find((x) => x.key === k)
    if (!nb || nb.off) return
    dropConn()
    setBk(k); setVals({}); setTest({ state: 'idle' }); setSynced(false); createLive.reset(); createPaper.reset()
    setName(nb.paper ? '模拟盘' : `${nb.label} 账户`)
  }
  const setVal = (k: string, v: string) => { setVals({ ...vals, [k]: v }); setTest({ state: 'idle' }); setSynced(false); createLive.reset() }

  const runTest = async () => {
    if (!b.tool) return
    const miss = fields.find((f) => f.required && !(vals[f.key] ?? f.default ?? '').trim())
    if (miss) return setTest({ state: 'fail', msg: `没填 ${miss.label}` })
    setTest({ state: 'testing' })
    // 密钥字段进 secrets，其余（「网络」等）进 config：内核按字段种类分开存，混着发会被拒
    const val = (k: string, d?: string) => (vals[k] ?? d ?? '').trim()
    const secrets = Object.fromEntries(fields.filter((f) => f.kind === 'secret').map((f) => [f.key, val(f.key)]))
    const config = Object.fromEntries(fields.filter((f) => f.kind !== 'secret').map((f) => [f.key, val(f.key, f.default)]))
    try {
      let id = connId
      if (!id) {
        const c = await createConn.mutateAsync({ tool: b.tool, name: name.trim() || `${b.label} 账户`, auth_mode: 'token', secrets, config })
        id = c.id
        pending.current = id
        setConnId(id)
      } else if (!synced) {
        await patchConn.mutateAsync({ id, patch: { secrets, config } })
      }
      setSynced(true)
      const r = await testConn.mutateAsync(id)
      setTest(r.ok ? { state: 'ok', msg: r.account || '连接成功' } : { state: 'fail', msg: r.message || '连接失败' })
    } catch (e) {
      setTest({ state: 'fail', msg: errorText(e) })
    }
  }

  const cap = Number(capital)
  const capBad = !(cap > 0) || cap > 1e9
  const save = () => {
    if (b.paper) {
      if (capBad) return
      createPaper.mutate({ name: name.trim() || '模拟盘', initial: cap, markets: ['crypto'] }, { onSuccess: onCreated })
      return
    }
    if (test.state !== 'ok' || !connId) return
    createLive.mutate({ connector_id: connId, name: name.trim() || undefined, trade }, {
      onSuccess: (a) => { pending.current = ''; onCreated(a) },
    })
  }
  const close = () => { dropConn(); onClose() }
  const saveErr = createLive.error ?? createPaper.error
  const canSave = b.paper ? !capBad : test.state === 'ok'
  const saving = createLive.isPending || createPaper.isPending

  return (
    <Drawer open onClose={close} kicker="新增交易账户" aria-label="新增交易账户" className="tr-drawer"
      footer={(requestClose) => (
        <>
          {saveErr ? <span className="field-err" role="alert">{saveErrText(saveErr)}</span>
            : !canSave && <span className="tr-muted tr-small">{b.paper ? '初始资金要大于 0' : '测试通过后才能保存'}</span>}
          <span className="spacer" />
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={!canSave || saving} onClick={save}>{saving ? '保存中…' : '保存'}</Button>
        </>
      )}>
      <div className="form">
        <div className="field">
          <span className="field-label">交易所 / 券商</span>
          <div className="tr-brokers">
            {BROKERS.map((x) => (
              <button key={x.key} type="button" className={cls('tr-broker', bk === x.key && 'on')} disabled={!!x.off} title={x.off} onClick={() => pick(x.key)}>
                <span>{x.label}</span><span className="faint tr-small">{x.off ?? x.markets}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="tr-hints"><div>{b.note}</div></div>
        <label className="field"><span className="field-label">名称</span>
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        {b.paper ? (
          <label className="field"><span className="field-label">初始资金（USD）</span>
            <input className={cls('input', capBad && 'bad')} inputMode="decimal" value={capital} onChange={(e) => setCapital(e.target.value)} />
            <span className="field-hint-line">手续费万分之 5、滑点 1 跳；只做数币（别的市场还没有行情源）</span>
          </label>
        ) : (
          <>
            {defs.isError && <div className="tr-inline-msg tr-inline-bad"><span>连接器定义没取到：{errorText(defs.error)}</span></div>}
            {b.tool && defs.data && !def && <div className="tr-inline-msg tr-inline-bad"><span>没有 {b.label} 的交易账户连接器：交易插件停用了或版本太旧</span></div>}
            {fields.map((f) => (
              <label key={f.key} className="field"><span className="field-label">{f.label}{f.required && <em aria-hidden="true">*</em>}</span>
                {f.kind === 'select' ? (
                  <>
                    <select className="select" value={vals[f.key] ?? f.default ?? f.options?.[0] ?? ''} onChange={(e) => setVal(f.key, e.target.value)}>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{f.key === 'env' ? ENV_LABEL[o] ?? o : o}</option>)}
                    </select>
                    {f.placeholder && <span className="field-hint-line">{f.placeholder}</span>}
                  </>
                ) : (
                  <input className="input" type={f.kind === 'secret' ? 'password' : 'text'} autoComplete="off" placeholder={f.placeholder}
                    value={vals[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)} />
                )}
              </label>
            ))}
            <div className="field">
              <span className="field-label">权限<span className="field-hint">不开提币权限，资金不会被转走</span></span>
              <div className="seg seg-full">
                <button type="button" className={cls(!trade && 'on')} onClick={() => setTrade(false)}>只读</button>
                <button type="button" className={cls(trade && 'on')} onClick={() => setTrade(true)}>读取 + 交易</button>
              </div>
              {trade && <span className="field-hint-line">开了交易权限也要过实盘评审、申请 trade:live、打开「交易设置」里的实盘开关才能下单，Key 本身也要有交易权限；在那之前只读同步</span>}
            </div>
            <div className="tr-act-row">
              <Button disabled={test.state === 'testing' || !def} onClick={() => void runTest()}>{test.state === 'testing' ? '测试中…' : '测试连接'}</Button>
              {test.state === 'ok' && <span className="tr-conn tr-conn-ok"><i />{test.msg}</span>}
              {test.state === 'fail' && <span className="tr-conn tr-conn-danger" role="alert"><i />{test.msg}</span>}
              {test.state === 'testing' && <span className="tr-conn tr-conn-info"><i />正在连接 {b.label}</span>}
            </div>
            <div className="faint tr-small">凭证存进本机的保险箱（设置 / 连接器），列表里只显示 API Key 后四位；Key 带提币或划转权限的一律不能接入</div>
          </>
        )}
      </div>
    </Drawer>
  )
}

function saveErrText(e: unknown) {
  if (isApiError(e) && e.extra.reason === 'key_withdraw') return `${errorText(e)}`
  return `没保存：${errorText(e)}`
}

/* ---------- 对账抽屉（SPEC-trading-12） ---------- */

const RECON_KIND: Record<string, string> = { position: '持仓', order: '挂单' }

export function ReconDrawer({ account, onClose }: { account: TradeAccount; onClose: () => void }) {
  const recon = useTradeRecon(account.id)
  const recheck = useRecheckRecon()
  const resolve = useResolveRecon()
  const [verify, setVerify] = useState<{ id: string; note: string } | null>(null)
  const rc = recon.data
  const left = rc?.items.filter((x) => !x.resolved_at) ?? []
  const st = recheck.isPending ? { label: '对账中', tone: 'info' }
    : !rc || rc.status === 'none' ? { label: '还没对过账', tone: 'muted' }
      : rc.status === 'failed' ? { label: '对账失败', tone: 'danger' }
        : left.length ? { label: `${left.length} 处差异`, tone: 'danger' } : { label: '一致', tone: 'ok' }
  const doVerify = (x: TradeReconItem) => {
    const note = verify?.note.trim() ?? ''
    if (!note) return
    resolve.mutate({ id: account.id, item: x.id, action: 'verify', note }, { onSuccess: () => setVerify(null) })
  }
  return (
    <Drawer open onClose={onClose} kicker={`对账 · ${account.name}`} aria-label="对账" className="tr-drawer"
      footer={(requestClose) => (
        <>
          {account.status !== 'connected' && <span className="tr-muted tr-small">账户{account.status === 'error' ? '连接异常' : '未连接'}，对账会失败</span>}
          <span className="spacer" />
          <Button onClick={requestClose}>关闭</Button>
          <Button variant="primary" disabled={recheck.isPending} onClick={() => recheck.mutate(account.id)}>{recheck.isPending ? '对账中…' : '重新对账'}</Button>
        </>
      )}>
      {rc === undefined ? (recon.isError ? <ErrorState compact title="对账没取到" error={errorText(recon.error)} onRetry={() => void recon.refetch()} /> : <LoadingState />) : (
        <div className="form">
          <div className="tr-kv"><span>结果</span><b><span className={`tr-conn tr-conn-${st.tone}`}><i />{st.label}</span></b></div>
          <div className="tr-kv"><span>最近一次</span><b>{rc.at ? `${fmtTime(rc.at)}（${ago(rc.at)}）` : '-'}</b></div>
          <div className="tr-kv"><span>对账项</span><b>{rc.at ? `${rc.checked} 项：每个持仓、每笔挂单（计价币余额不对账）` : '-'}</b></div>
          <div className="tr-kv"><span>熔断阈值</span><b>持仓差异到 {num(rc.threshold, 1)}% 自动熔断{rc.max_pct > 0 ? `；这次最大 ${num(rc.max_pct, 2)}%` : ''}</b></div>
          {rc.status === 'failed' && rc.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{rc.error}</span></div>}
          {(recheck.error || resolve.error) && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{errorText(recheck.error ?? resolve.error)}</span></div>}
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">差异<span className="tr-hint">本地记的和交易所返回的对不上的项</span></div>
            {!rc.items.length ? <div className="tr-empty-box">{rc.status === 'failed' ? '这次没拿到交易所数据，修好账户连接后重新对账' : '没有差异'}</div> : (
              <div className="tr-list">
                {rc.items.map((x) => (
                  <div key={x.id} className={cls('tr-list-row tr-recon-row', x.resolved_at && 'tr-dim')}>
                    <span className={cls('tr-dot', x.resolved_at ? 'ok' : 'bad')} />
                    <span className="tr-list-main">
                      <span><span className="tag tr-tag-sm tr-tag-first">{RECON_KIND[x.kind] ?? x.kind}</span>{x.label}</span>
                      <span className="tr-num tr-small">本地 <b>{x.local}</b> · 交易所 <b>{x.remote}</b>{x.kind === 'position' ? ` · 差 ${num(x.pct, 2)}%` : ''}</span>
                      {x.note && <span className="tr-muted tr-small">{x.note}</span>}
                      {!x.resolved_at && x.seen > 1 && <span className="tr-muted tr-small">连续 {x.seen} 次对账都在</span>}
                      {x.resolved_at && <span className="faint tr-small">{fmtTime(x.resolved_at)} {x.resolution}</span>}
                      {verify?.id === x.id && (
                        <span className="tr-act-row tr-verify">
                          <input className="tr-input tr-verify-input" aria-label="核实备注" placeholder="备注（必填）：为什么以本地为准" maxLength={200} autoFocus
                            value={verify.note} onChange={(e) => setVerify({ id: x.id, note: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') doVerify(x) }} />
                          <Button size="sm" onClick={() => setVerify(null)}>取消</Button>
                          <Button size="sm" variant="primary" disabled={!verify.note.trim() || resolve.isPending} onClick={() => doVerify(x)}>标为已核实</Button>
                        </span>
                      )}
                    </span>
                    {!x.resolved_at && verify?.id !== x.id && (
                      <span className="tr-recon-ops">
                        <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: account.id, item: x.id, action: 'adopt' })}>按交易所修正</Button>
                        <Button size="sm" disabled={resolve.isPending} title="本地记录不改，同样的差异不再报；要写备注" onClick={() => setVerify({ id: x.id, note: '' })}>标为已核实</Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <div className="faint tr-small">后端每分钟同步并对账；差异连续两次对账都在才记运行异常「交易对账异常」并通知，持仓差异到阈值自动熔断</div>
        </div>
      )}
    </Drawer>
  )
}

/* ---------- 实盘账户的交易所数据：余额、持仓、挂单、成交；闸门全开时能平仓、撤掉全部挂单（TRD-08d） ---------- */

/** 交易所数据里的行内操作：平仓（要确认）、撤掉全部挂单（要确认），被拦时就地写原因 */
type LiveAct = { kind: 'close'; key: string; err?: TradePlaceError } | { kind: 'cancel'; err?: TradePlaceError }

function LiveActErr({ err }: { err: TradePlaceError }) {
  if (err.kind === 'gate') {
    return <div className="tr-inline-msg tr-inline-bad" role="alert"><span><b>实盘闸门没过</b><ul>{err.missing.map((m) => <li key={m}>{m}</li>)}</ul></span></div>
  }
  if (err.kind === 'risk') {
    return <div className="tr-inline-msg tr-inline-bad" role="alert"><span><b>风控未通过</b><ul>{err.blocks.map((m) => <li key={m}>{m}</li>)}</ul></span></div>
  }
  if (err.kind === 'upstream' && err.failed.length) {
    return <div className="tr-inline-msg tr-inline-bad" role="alert"><span>交易所没撤掉：<ul>{err.failed.map((m) => <li key={m}>{m}</li>)}</ul></span></div>
  }
  return <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{err.message}</span></div>
}

export function LiveDataDrawer({ account, onClose }: { account: TradeAccount; onClose: () => void }) {
  const snap = useTradeLiveSnapshot(account.id)
  const fills = useTradeLiveFills(account.id)
  const close = useCloseTradePosition()
  const cancelAll = useCancelAllTradeOrders()
  const [act, setAct] = useState<LiveAct | null>(null)
  const [done, setDone] = useState('')
  const s = snap.data
  const block = liveBlock(account)
  const busy = close.isPending || cancelAll.isPending
  const doClose = (p: TradeLivePosition) => {
    if (!p.id) return
    // 用户已在行内确认过，直接带 confirmed（实盘每笔都要确认）
    close.mutate({ id: p.id, confirmed: true }, {
      onSuccess: (o) => {
        setAct(null)
        setDone(o.status === 'rejected' ? `平仓单被拒：${o.reject_reason ?? ''}` : `已下实盘平仓单：${o.side === 'buy' ? '买入' : '卖出'} ${fmtQty(o.qty)} ${p.name || guessInstrument(p.symbol).name}，市价`)
        void snap.refetch()
      },
      onError: (e) => setAct({ kind: 'close', key: p.key, err: tradePlaceError(e) }),
    })
  }
  const doCancelAll = () => cancelAll.mutate(account.id, {
    onSuccess: (r) => { setAct(null); setDone(`已到交易所撤掉 ${r.canceled} 笔挂单`); void snap.refetch() },
    onError: (e) => setAct({ kind: 'cancel', err: tradePlaceError(e) }),
  })
  return (
    <Drawer open onClose={onClose} kicker={`交易所数据 · ${account.name}`} aria-label="交易所数据" className="tr-drawer"
      footer={(requestClose) => (
        <>
          <span className="tr-muted tr-small">{block ? '只读：闸门没开全，这里不能平仓、撤单' : '实盘：平仓、撤单会在交易所真实执行，都要先确认'}</span>
          <span className="spacer" />
          <Button onClick={requestClose}>关闭</Button>
        </>
      )}>
      {s === undefined ? (snap.isError ? <ErrorState compact title="交易所数据没取到" error={errorText(snap.error)} onRetry={() => void snap.refetch()} /> : <LoadingState />) : (
        <div className="form">
          <div className="tr-kv"><span>同步于</span><b>{s.synced_at ? `${fmtTime(s.synced_at)}（${ago(s.synced_at)}）` : '还没同步成功'}{s.fail_count > 0 ? `，连续失败 ${s.fail_count} 次` : ''}</b></div>
          {s.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{s.error}</span></div>}
          <div className="tr-kv"><span>权益 / 可用 / 保证金</span><b className="tr-num">{num(s.equity, 2)} / {num(s.available, 2)} / {num(s.margin_used, 2)} USD</b></div>
          <div className="tr-kv"><span>Key 权限</span><b>{s.key_permissions.includes('trade') ? '读取 + 交易' : '只读'}</b></div>
          {done && <div className="tr-inline-msg" role="status"><span>{done}</span><Button size="sm" onClick={() => setDone('')}>知道了</Button></div>}
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">余额<span className="tr-hint">{s.balances.length} 项</span></div>
            {!s.balances.length ? <div className="tr-empty-box">没有余额</div> : (
              <div className="tr-list">
                {s.balances.map((x) => (
                  <div key={`${x.wallet}:${x.asset}`} className="tr-list-row">
                    <span className="tr-list-main"><span>{x.asset} <span className="faint tr-small">{x.wallet === 'spot' ? '现货' : x.wallet === 'futures' ? 'U 本位合约' : '统一账户'}</span></span>
                      <span className="tr-muted tr-small tr-num">可用 {fmtQty(x.free)} · 冻结 {fmtQty(x.locked)}</span></span>
                    <span className="tr-num tr-list-val">{fmtQty(x.total)}<span className="faint"> ≈ ${num(x.value, 2)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">持仓<span className="tr-hint">{s.positions.length} 个</span></div>
            {!s.positions.length ? <div className="tr-empty-box">没有持仓</div> : (
              <div className="tr-list">
                {s.positions.map((p) => {
                  const mine = act?.kind === 'close' && act.key === p.key ? act : null
                  const nm = p.name || guessInstrument(p.symbol).name
                  return (
                    <div key={p.key}>
                      <div className="tr-list-row">
                        <span className={cls('tr-side', p.side === 'long' ? 'buy' : 'sell')}>{p.side === 'long' ? '多' : '空'}</span>
                        <span className="tr-list-main"><span className="ellipsis" title={p.symbol}>{nm}</span>
                          <span className="tr-muted tr-small tr-num">{p.kind === 'spot' ? '现货' : `永续${p.leverage ? ` ${p.leverage}x` : ''}`} · {fmtQty(p.qty)}{p.avg_price ? ` @ ${num(p.avg_price, 2)}` : ''}{p.liq_price ? ` · 强平 ${num(p.liq_price, 2)}` : ''}</span></span>
                        <span className="tr-num tr-list-val" style={{ color: tone(p.pnl) }}>{p.kind === 'spot' ? `$${num(p.last * p.qty, 2)}` : signed(p.pnl)}</span>
                        {p.id && (
                          <Button size="sm" variant="outline" disabled={!!block || busy} title={block ?? `市价平掉 ${fmtQty(p.qty)}${p.kind === 'spot' ? '' : '，仅减仓'}`}
                            onClick={() => setAct({ kind: 'close', key: p.key })}>平仓</Button>
                        )}
                      </div>
                      {mine && !mine.err && (
                        <div className="tr-inline-msg tr-inline-warn" role="alert">
                          <span><span className="tag tr-tag-sm tr-tag-live">实盘</span> 市价{p.side === 'long' ? '卖出' : '买入'} {fmtQty(p.qty)} {nm}{p.kind === 'spot' ? '' : '（仅减仓）'}，{LIVE_RISK}</span>
                          <Button size="sm" onClick={() => setAct(null)}>取消</Button>
                          <Button size="sm" variant="danger" disabled={busy} onClick={() => doClose(p)}>确认平仓</Button>
                        </div>
                      )}
                      {mine?.err && <LiveActErr err={mine.err} />}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">挂单<span className="tr-hint">{s.orders.length} 笔{block ? '，只读' : '；交易套件下的单在委托里撤，这里能撤掉这个账户在交易所的全部挂单'}</span>
              {!block && s.orders.length > 0 && act?.kind !== 'cancel' && <><span className="spacer" /><Button size="sm" disabled={busy} onClick={() => setAct({ kind: 'cancel' })}>全部撤单</Button></>}
            </div>
            {act?.kind === 'cancel' && !act.err && (
              <div className="tr-inline-msg tr-inline-warn" role="alert">
                <span><span className="tag tr-tag-sm tr-tag-live">实盘</span> 到交易所撤掉这个账户的全部 {s.orders.length} 笔挂单（含不是交易套件下的）？</span>
                <Button size="sm" onClick={() => setAct(null)}>取消</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={doCancelAll}>确认撤单</Button>
              </div>
            )}
            {act?.kind === 'cancel' && act.err && <LiveActErr err={act.err} />}
            {!s.orders.length ? <div className="tr-empty-box">没有挂单</div> : (
              <div className="tr-list">
                {s.orders.map((o) => (
                  <div key={o.id} className="tr-list-row">
                    <span className={cls('tr-side', o.side === 'buy' ? 'buy' : 'sell')}>{o.side === 'buy' ? '买' : '卖'}</span>
                    <span className="tr-list-main"><span className="ellipsis">{guessInstrument(o.symbol).name} <span className="faint tr-small">#{o.id}</span></span>
                      <span className="tr-muted tr-small tr-num">{o.type} · {fmtQty(o.qty)}{o.price ? ` @ ${num(o.price, 2)}` : ''} · 已成交 {fmtQty(o.filled)}</span></span>
                    <span className="faint tr-small">{fmtTime(o.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">成交<span className="tr-hint">{fills.data ? `最近 ${fills.data.data.length} 笔，共 ${fills.data.total} 笔` : ''}</span></div>
            {fills.data === undefined ? (fills.isError ? <ErrorState compact title="成交没取到" error={errorText(fills.error)} /> : <LoadingState />)
              : !fills.data.data.length ? <div className="tr-empty-box">没有成交</div> : (
                <div className="tr-list">
                  {fills.data.data.map((f) => (
                    <div key={f.id} className="tr-list-row">
                      <span className={cls('tr-side', f.side === 'buy' ? 'buy' : 'sell')}>{f.side === 'buy' ? '买' : '卖'}</span>
                      <span className="tr-list-main"><span className="ellipsis">{guessInstrument(f.symbol).name}</span>
                        <span className="tr-muted tr-small tr-num">{fmtQty(f.qty)} @ {num(f.price, 2)} · 手续费 {fmtQty(f.fee)} {f.fee_asset}</span></span>
                      <span className="faint tr-small">{fmtTime(f.at)}</span>
                    </div>
                  ))}
                </div>
              )}
          </section>
        </div>
      )}
    </Drawer>
  )
}
