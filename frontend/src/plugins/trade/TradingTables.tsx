// 持仓（SPEC-trading-3）、委托（SPEC-trading-4）。现价、盈亏、强平价、保证金全部来自后端，前端不撮合、不算账。
// 平仓走 POST /positions/{id}/close，挂止损是一笔仅减仓的止损单，都经统一下单入口：被风控拦下或要二次确认时就地显示。
// 持仓只有模拟盘的（实盘持仓在交易账户的「交易所数据」里看、平仓）；委托里有实盘委托（TRD-08d，live）：标「实盘」，
// 多「提交中」「状态未知」，不能改价（撤单后重新下），撤单到交易所撤，撤不掉原样写原因。
import { Fragment, useMemo, useState } from 'react'
import {
  errorText, tradePlaceError, useCancelAllTradeOrders, useCancelTradeOrder, useCloseTradePosition, useModifyTradeOrder, usePlaceTradeOrder,
  useTradeInstrumentMap, useTradeLive, useTradeOrders,
  type TradeAccount, type TradeInstrument, type TradeOrder, type TradePlaceError, type TradePosition, type TradeRun,
} from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, Pill, SearchSelect, cls } from '../../core/ui'
import { KIND_SHORT, MARKETS, digitsFor, fmtPct, fmtPrice, guessInstrument } from './model'
import type { TradeNotice } from './TradingParts'
import { LIVE_STATUS_NOTE, ORDER_SOURCE, ORDER_STATUS, ORDER_TYPE, fmtQty, fmtTime, isActive, isContract, num, signed, signedUsd, tone, usd } from './tradingModel'

type Q<T> = { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }

const instOr = (m: Record<string, TradeInstrument>, s: string) => m[s] ?? guessInstrument(s)
const px = (i: TradeInstrument, v: number) => fmtPrice(v, digitsFor(i.digits >= 0 ? i : undefined, v))

/** 平仓、挂止损、改价被拦时的就地提示：风控逐条原样列出；要二次确认的给确认按钮 */
function PlaceErr({ err, onConfirm, confirmLabel, busy }: { err: TradePlaceError; onConfirm?: () => void; confirmLabel: string; busy?: boolean }) {
  if (err.kind === 'confirm') {
    return (
      <div className="tr-inline-msg tr-inline-warn">
        <span>金额约 <b>{usd(err.value)}</b>，超过 {usd(err.confirm_above)} 二次确认线</span>
        {onConfirm && <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>}
      </div>
    )
  }
  if (err.kind === 'risk') {
    return (
      <div className="tr-inline-msg tr-inline-bad" role="alert">
        <span><b>风控未通过</b>{err.order ? '这笔已记成被拒绝的委托。' : ''}
          <ul>{err.blocks.map((b) => <li key={b}>{b}</li>)}</ul>
        </span>
      </div>
    )
  }
  return <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{err.message}</span></div>
}

/* ---------- 持仓 ---------- */

type RowAct =
  | { id: string; kind: 'close'; err?: TradePlaceError }
  | { id: string; kind: 'stop'; price: string; err?: TradePlaceError }

export function PositionsView({ accounts, positions, runs, acctName, onNew, onChart, onNotice }: {
  accounts: TradeAccount[]; positions: Q<TradePosition[]>; runs: TradeRun[]; acctName: (id: string) => string
  onNew: () => void; onChart: (symbol: string) => void; onNotice: (n: TradeNotice) => void
}) {
  const [acct, setAcct] = useState('')
  const [mkt, setMkt] = useState('')
  const [folded, setFolded] = useState<string[]>([])
  const [act, setAct] = useState<RowAct | null>(null)
  const close = useCloseTradePosition()
  const place = usePlaceTradeOrder()
  const all = useMemo(() => positions.data ?? [], [positions.data])
  const insts = useTradeInstrumentMap(useMemo(() => all.map((p) => p.symbol), [all]))

  if (positions.data === undefined) {
    return positions.isError ? <ErrorState title="持仓没取到" error={errorText(positions.error)} onRetry={() => void positions.refetch()} /> : <LoadingState />
  }
  const marketOf = (s: string) => instOr(insts, s).market
  const rows = all.filter((p) => (!acct || p.account_id === acct) && (!mkt || marketOf(p.symbol) === mkt))
  const totalPnl = rows.reduce((s, p) => s + p.pnl, 0)
  const totalVal = rows.reduce((s, p) => s + Math.abs(p.value), 0)
  const groups = accounts.map((a) => ({ key: a.id, a: a as TradeAccount | undefined, items: rows.filter((p) => p.account_id === a.id) })).filter((g) => g.items.length)
  const orphan = rows.filter((p) => !accounts.some((a) => a.id === p.account_id))
  const sections = acct ? [{ key: acct, a: undefined, items: rows }] : [...groups, ...(orphan.length ? [{ key: '-', a: undefined, items: orphan }] : [])]
  const fold = (k: string) => setFolded(folded.includes(k) ? folded.filter((x) => x !== k) : [...folded, k])
  const runName = (id?: string) => (!id ? '手动' : runs.find((r) => r.id === id)?.strategy_name || '策略')

  const doClose = (p: TradePosition, confirmed = false) => {
    close.mutate({ id: p.id, confirmed: confirmed || undefined }, {
      onSuccess: (o) => {
        setAct(null)
        onNotice(o.status === 'rejected'
          ? { tone: 'danger', text: `平仓单被拒：${p.name}，${o.reject_reason ?? ''}` }
          : { tone: 'ok', text: `已下平仓单：${o.side === 'buy' ? '买入' : '卖出'} ${fmtQty(o.qty)} ${p.name}，市价` })
      },
      onError: (e) => setAct({ id: p.id, kind: 'close', err: tradePlaceError(e) }),
    })
  }
  const doStop = (p: TradePosition, price: number, confirmed = false) => {
    const i = instOr(insts, p.symbol)
    place.mutate({
      account_id: p.account_id, symbol: p.symbol, side: p.side === 'long' ? 'sell' : 'buy', type: 'stop', qty: p.qty, stop_price: price,
      reduce_only: isContract(i) || undefined, confirmed: confirmed || undefined,
    }, {
      onSuccess: (o) => {
        setAct(null)
        onNotice(o.status === 'rejected'
          ? { tone: 'danger', text: `止损单被拒：${p.name}，${o.reject_reason ?? ''}` }
          : { tone: 'ok', text: `已挂止损单：${p.name} 触发价 ${px(i, price)}，触发后市价${p.side === 'long' ? '卖出' : '买入'} ${fmtQty(p.qty)}` })
      },
      onError: (e) => setAct({ id: p.id, kind: 'stop', price: String(price), err: tradePlaceError(e) }),
    })
  }

  return (
    <>
      <div className="tr-toolbar">
        <div className="tr-seg" role="group" aria-label="按市场筛">
          <button type="button" className={cls(!mkt && 'on')} aria-pressed={!mkt} onClick={() => setMkt('')}>全部市场<span className="seg-n">{all.length}</span></button>
          {Object.entries(MARKETS).map(([k, m]) => (
            <button key={k} type="button" className={cls(mkt === k && 'on')} aria-pressed={mkt === k} onClick={() => setMkt(k)}>
              {m.label}<span className="seg-n">{all.filter((p) => marketOf(p.symbol) === k).length}</span>
            </button>
          ))}
        </div>
        {accounts.length > 1 && (
          <SearchSelect value={acct} noneLabel="全部账户" placeholder="全部账户" aria-label="按账户筛" onChange={(v: string) => setAcct(v)}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
        )}
        <span className="spacer" />
        <span className="tr-muted tr-num">市值 {usd(totalVal)} · 浮盈 <b style={{ color: tone(totalPnl) }}>{signedUsd(totalPnl, 2)}</b></span>
      </div>
      {!rows.length ? (
        <EmptyState title={acct || mkt ? '没有匹配的持仓' : '还没有持仓'} desc="下单成交后会出现在这里" action={<Button variant="primary" onClick={onNew}>下单</Button>} />
      ) : (
        <div className="tr-table" role="table" aria-label="持仓">
          <div className="tr-pos-row tr-th" role="row"><span>标的</span><span className="tr-r tr-c-qty">数量</span><span className="tr-r tr-c-px">成本 / 现价</span><span className="tr-r">浮盈</span><span className="tr-r tr-c-val">市值</span><span className="tr-r tr-c-lev">杠杆 / 强平</span><span className="tr-r">操作</span></div>
          {sections.map((g) => {
            const pnl = g.items.reduce((s, p) => s + p.pnl, 0)
            const shut = !acct && folded.includes(g.key)
            return (
              <Fragment key={g.key}>
                {!acct && (
                  <button type="button" className="tr-grp" onClick={() => fold(g.key)} aria-expanded={!shut}>
                    <svg className={cls('tr-grp-chev', shut && 'shut')} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <b className="ellipsis">{g.a?.name ?? '已删除的账户'}</b>
                    <span className="tr-muted tr-grp-sub">{g.items.length} 个持仓{g.a ? ` · 权益 ${num(g.a.equity, 2)} ${g.a.currency}` : ''}</span>
                    <span className="spacer" />
                    <span className="tr-muted tr-num">浮盈 <b style={{ color: tone(pnl) }}>{signedUsd(pnl, 2)}</b></span>
                  </button>
                )}
                {!shut && g.items.map((p) => {
                  const i = instOr(insts, p.symbol)
                  const liqDist = p.liq_price && p.last ? Math.abs(p.liq_price - p.last) / p.last : undefined
                  const mine = act?.id === p.id ? act : null
                  const busy = close.isPending || place.isPending
                  return (
                    <div key={p.id} className="tr-pos-wrap" role="row">
                      <div className="tr-pos-row">
                        <span className="tr-main">
                          <span className="tr-title">
                            <span className={cls('tr-side', p.side === 'long' ? 'buy' : 'sell')}>{p.side === 'long' ? '多' : '空'}</span>
                            <span className="ellipsis">{p.name || p.symbol}</span>
                            {KIND_SHORT[i.kind] && <span className="tag tr-tag-sm">{KIND_SHORT[i.kind]}</span>}
                          </span>
                          <span className="tr-meta ellipsis">{acctName(p.account_id)} · {runName(p.run_id)}{p.mark_status !== 'live' ? ' · 现价非实时' : ''}</span>
                        </span>
                        <span className="tr-r tr-num tr-c-qty">{fmtQty(p.qty, i.lot)}</span>
                        <span className="tr-r tr-num tr-c-px tr-two"><span className="faint">{px(i, p.avg_price)}</span><span title={p.mark_at ? `数据时间 ${fmtTime(p.mark_at)}` : undefined}>{p.last ? px(i, p.last) : '-'}</span></span>
                        <span className="tr-r tr-num tr-two" style={{ color: tone(p.pnl) }}><span>{signed(p.pnl)}</span><span className="tr-pct">{fmtPct(p.pct)}</span></span>
                        <span className="tr-r tr-num tr-c-val tr-two"><span>{num(Math.abs(p.value), 2)}</span><span className="faint">保证金 {num(p.margin, 2)}</span></span>
                        <span className="tr-r tr-num tr-c-lev tr-two">
                          <span>{p.leverage ? `${p.leverage}x` : '-'}</span>
                          {p.liq_price ? <span className={cls(liqDist !== undefined && liqDist < 0.1 ? 'danger-text' : 'faint')}>{px(i, p.liq_price)}{liqDist !== undefined ? ` · 距 ${(liqDist * 100).toFixed(1)}%` : ''}</span> : <span className="faint">-</span>}
                        </span>
                        <span className="tr-ops">
                          {mine?.kind === 'close' && !mine.err ? (
                            <>
                              <Button size="sm" onClick={() => setAct(null)}>取消</Button>
                              <Button size="sm" variant="danger" disabled={busy} onClick={() => doClose(p)}>市价全平</Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setAct({ id: p.id, kind: 'close' })}>平仓</Button>
                              <Button size="sm" onClick={() => onChart(p.symbol)}>看图</Button>
                              <Button size="sm" onClick={() => setAct({ id: p.id, kind: 'stop', price: p.last ? String(Number((p.last * (p.side === 'long' ? 0.95 : 1.05)).toFixed(Math.max(0, i.digits))) ) : '' })}>加止损</Button>
                            </>
                          )}
                        </span>
                      </div>
                      {mine?.kind === 'close' && mine.err && (
                        <div className="tr-stop-row">
                          <PlaceErr err={mine.err} confirmLabel="确认平仓" busy={busy} onConfirm={() => doClose(p, true)} />
                          <span className="spacer" />
                          <Button size="sm" onClick={() => setAct(null)}>取消</Button>
                        </div>
                      )}
                      {mine?.kind === 'stop' && (() => {
                        const sp = Number(mine.price)
                        const bad = !(sp > 0) || (p.last > 0 && (p.side === 'long' ? sp >= p.last : sp <= p.last))
                        return (
                          <div className="tr-stop-row">
                            <span className="tr-muted">止损价</span>
                            <input className={cls('tr-input', bad && 'bad')} inputMode="decimal" aria-label="止损价" value={mine.price} autoFocus
                              onChange={(e) => setAct({ id: p.id, kind: 'stop', price: e.target.value })} />
                            <span className="tr-muted tr-stop-hint">{bad ? (p.side === 'long' ? '多单止损价要低于现价' : '空单止损价要高于现价')
                              : `触发后市价${p.side === 'long' ? '卖出' : '买入'} ${fmtQty(p.qty, i.lot)}${p.last ? `，距现价 ${((Math.abs(sp - p.last) / p.last) * 100).toFixed(1)}%` : ''}`}</span>
                            <span className="spacer" />
                            <Button size="sm" onClick={() => setAct(null)}>取消</Button>
                            <Button size="sm" variant="primary" disabled={bad || busy} onClick={() => doStop(p, sp)}>挂止损单</Button>
                            {mine.err && <PlaceErr err={mine.err} confirmLabel="确认挂单" busy={busy} onConfirm={() => doStop(p, sp, true)} />}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
              </Fragment>
            )
          })}
        </div>
      )}
    </>
  )
}

/* ---------- 委托 ---------- */

const ORDER_PAGE = 50

export function OrdersView({ accounts, acctName }: { accounts: TradeAccount[]; acctName: (id: string) => string }) {
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [acct, setAcct] = useState('')
  const [limit, setLimit] = useState(ORDER_PAGE)
  const [edit, setEdit] = useState<{ id: string; price: string; err?: string } | null>(null)
  const [cancelAllAsk, setCancelAllAsk] = useState(false)
  const q = useTradeOrders({ status: tab, account_id: acct || undefined, limit: tab === 'history' ? limit : 1000 })
  const cancel = useCancelTradeOrder()
  const cancelAll = useCancelAllTradeOrders()
  const modify = useModifyTradeOrder()
  const rows = useMemo(() => q.data?.data ?? [], [q.data])
  const symbols = useMemo(() => [...new Set(rows.filter((o) => isActive(o.status)).map((o) => o.symbol))], [rows])
  const live = useTradeLive(symbols, '')
  const insts = useTradeInstrumentMap(useMemo(() => rows.map((o) => o.symbol), [rows]))
  const setTabTo = (t: 'active' | 'history') => { setTab(t); setLimit(ORDER_PAGE); setEdit(null); setCancelAllAsk(false) }

  const savePrice = (o: TradeOrder, v: number) => {
    // 止损单改触发价；止损限价没触发前改触发价，触发后只能改委托价；限价改委托价
    const body = o.type === 'stop' || editsStop(o) ? { stop_price: v } : { price: v }
    modify.mutate({ id: o.id, ...body }, {
      onSuccess: () => setEdit(null),
      onError: (e) => {
        const pe = tradePlaceError(e)
        setEdit({ id: o.id, price: String(v), err: pe.kind === 'risk' ? `风控未通过：${pe.blocks.join('；')}` : pe.message })
      },
    })
  }

  return (
    <>
      <div className="tr-toolbar">
        <div className="tr-seg" role="group" aria-label="委托">
          <button type="button" className={cls(tab === 'active' && 'on')} aria-pressed={tab === 'active'} onClick={() => setTabTo('active')}>当前委托<span className="seg-n">{q.data?.active ?? '-'}</span></button>
          <button type="button" className={cls(tab === 'history' && 'on')} aria-pressed={tab === 'history'} onClick={() => setTabTo('history')}>历史委托<span className="seg-n">{q.data?.history ?? '-'}</span></button>
        </div>
        {accounts.length > 1 && (
          <SearchSelect value={acct} noneLabel="全部账户" placeholder="全部账户" aria-label="按账户筛" onChange={(v: string) => { setAcct(v); setLimit(ORDER_PAGE) }}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
        )}
        <span className="spacer" />
        {tab === 'active' && rows.length > 1 && (cancelAllAsk ? (
          <span className="tr-inline-ask">
            <span className="danger-text tr-small">撤掉{acct ? '这个账户' : '全部'} {rows.length} 笔挂单？{rows.some((o) => o.live) ? '实盘的会到交易所撤' : ''}</span>
            <Button size="sm" onClick={() => setCancelAllAsk(false)}>取消</Button>
            <Button size="sm" variant="danger" disabled={cancelAll.isPending} onClick={() => cancelAll.mutate(acct || undefined, { onSettled: () => setCancelAllAsk(false) })}>全部撤单</Button>
          </span>
        ) : <Button size="sm" onClick={() => setCancelAllAsk(true)}>全部撤单</Button>)}
      </div>
      {cancel.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>撤单失败：{errorText(cancel.error)}{tradePlaceError(cancel.error).kind === 'upstream' ? '（交易所没撤掉，稍后再试或到交易所处理）' : ''}</span></div>}
      {cancelAll.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>全部撤单失败：{errorText(cancelAll.error)}</span></div>}
      {q.data === undefined ? (
        q.isError ? <ErrorState title="委托没取到" error={errorText(q.error)} onRetry={() => void q.refetch()} /> : <LoadingState />
      ) : !rows.length ? (
        <EmptyState title={tab === 'active' ? '没有未完成的委托' : '没有历史委托'} desc={tab === 'active' ? '挂单中的委托会在这里，市价单通常一秒内成交' : '成交、撤单、被拒的委托会在这里'} />
      ) : (
        <div className="tr-table" role="table" aria-label={tab === 'active' ? '当前委托' : '历史委托'}>
          <div className="tr-ord-row tr-th" role="row"><span>标的</span><span className="tr-c-type">类型</span><span className="tr-r tr-c-oprice">价格</span><span className="tr-r tr-c-oqty">成交 / 数量</span><span>状态</span><span className="tr-r">操作</span></div>
          {rows.map((o) => {
            const i = instOr(insts, o.symbol)
            const act = isActive(o.status)
            const shown = o.type === 'stop' ? o.stop_price : o.price
            const last = live.quotes[o.symbol]?.last
            const editing = edit?.id === o.id ? edit : null
            return (
              <div key={o.id} className="tr-ord-wrap" role="row">
                <div className={cls('tr-ord-row', !act && o.status !== 'filled' && 'tr-dim')}>
                  <span className="tr-main">
                    <span className="tr-title">
                      <span className={cls('tr-side', o.side === 'buy' ? 'buy' : 'sell')}>{o.side === 'buy' ? '买' : '卖'}</span>
                      <span className="ellipsis">{i.name}</span>
                      {o.live && <span className="tag tr-tag-sm tr-tag-live" title="实盘委托：发到交易所，状态以交易所回报为准">实盘</span>}
                      {o.reduce_only && <span className="tag tr-tag-sm">仅减仓</span>}
                      {o.source !== 'manual' && <span className="tag tr-tag-sm">{ORDER_SOURCE[o.source]}</span>}
                    </span>
                    <span className="tr-meta ellipsis" title={o.client_order_id ? `委托编号 ${o.client_order_id}${o.exchange_order_id ? `，交易所委托号 ${o.exchange_order_id}` : ''}` : undefined}>
                      {acctName(o.account_id)} · {fmtTime(o.created_at)}{o.leverage > 1 ? ` · ${o.leverage}x` : ''}{o.exchange_order_id ? ` · #${o.exchange_order_id}` : ''}
                    </span>
                  </span>
                  <span className="tr-c-type"><span className="tag">{ORDER_TYPE[o.type]}</span></span>
                  <span className="tr-r tr-num tr-c-oprice tr-two">
                    <span>{o.type === 'market' ? '市价' : shown !== undefined ? px(i, shown) : '-'}</span>
                    <span className="faint">{o.status === 'filled' && o.avg_fill !== undefined ? `均价 ${px(i, o.avg_fill)}`
                      : o.type === 'stop_limit' && o.stop_price !== undefined ? `${o.triggered ? '已触发' : '触发'} ${px(i, o.stop_price)}`
                        : act && last ? `现价 ${px(i, last)}` : o.fee ? `手续费 ${num(o.fee, 2)}` : ''}</span>
                  </span>
                  <span className="tr-r tr-num tr-c-oqty">{fmtQty(o.filled, i.lot)} / {fmtQty(o.qty, i.lot)}</span>
                  <span className="tr-ord-st">
                    <Pill {...ORDER_STATUS[o.status]} />
                    {(o.status === 'rejected' || o.status === 'canceled') && o.reject_reason && <span className={cls('tr-small', o.status === 'rejected' ? 'tr-reject' : 'faint ellipsis')} title={o.reject_reason}>{o.reject_reason}</span>}
                    {o.live && LIVE_STATUS_NOTE[o.status] && <span className="faint tr-small ellipsis" title={LIVE_STATUS_NOTE[o.status]}>{LIVE_STATUS_NOTE[o.status]}</span>}
                  </span>
                  <span className="tr-ops">
                    {act && o.type !== 'market' && o.live && <Button size="sm" disabled title="实盘委托不能改价：撤单后重新下">改价</Button>}
                    {act && o.type !== 'market' && !o.live && <Button size="sm" onClick={() => setEdit({ id: o.id, price: String((o.type === 'stop' || editsStop(o) ? o.stop_price : o.price) ?? '') })}>改价</Button>}
                    {act && <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(o.id)}>撤单</Button>}
                    {!act && <span className="faint tr-small">{fmtTime(o.updated_at)}</span>}
                  </span>
                </div>
                {editing && (() => {
                  const v = Number(editing.price)
                  const bad = !(v > 0)
                  const stopField = o.type === 'stop' || editsStop(o)
                  return (
                    <div className="tr-stop-row">
                      <span className="tr-muted">{stopField ? '新触发价' : '新价格'}</span>
                      <input className={cls('tr-input', bad && 'bad')} inputMode="decimal" aria-label={stopField ? '新触发价' : '新价格'} autoFocus value={editing.price}
                        onChange={(e) => setEdit({ id: o.id, price: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && !bad) savePrice(o, v) }} />
                      <span className="tr-muted tr-stop-hint">{last ? `现价 ${px(i, last)}${!bad ? ` · 偏离 ${fmtPct((v - last) / last)}` : ''}` : ''}</span>
                      <span className="spacer" />
                      <Button size="sm" onClick={() => setEdit(null)}>取消</Button>
                      <Button size="sm" variant="primary" disabled={bad || modify.isPending} onClick={() => savePrice(o, v)}>保存</Button>
                      {editing.err && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{editing.err}</span></div>}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}
      {tab === 'history' && q.data && q.data.total > rows.length && (
        <button type="button" className="tr-more tr-link" onClick={() => setLimit(limit + ORDER_PAGE)}>
          再显示 {Math.min(ORDER_PAGE, q.data.total - rows.length)} 条<span className="faint">（还有 {q.data.total - rows.length} 条更早的）</span>
        </button>
      )}
    </>
  )
}

/** 止损限价没触发前，改价框改的是触发价 */
const editsStop = (o: TradeOrder) => o.type === 'stop_limit' && !o.triggered
