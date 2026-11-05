// 下单抽屉（SPEC-trading-5）：标的、账户、方向、类型、价格、数量、合约设置。
// 模拟盘账户和闸门全开（trade_ready）的实盘账户能下；提交走后端统一下单入口（POST /api/trade/orders），风控、二次确认都以后端为准（SPEC-trading-0.12）：
// - 前端的预检查只做提示，不拦提交；
// - 409 reason=risk：后端的拦截原因逐条原样显示，那笔委托已记成被拒绝；
// - 409 reason=confirm：底部出确认条（金额和阈值取后端返回的），确认后带 confirmed: true 重新提交。
// 实盘（TRD-08d）：抽屉标题和顶上横幅标「实盘」；只给市价、限价；每笔都先在底部确认（写明会在交易所真实成交、产生真实盈亏）再带 confirmed: true 提交；
// 403 live_gate 时逐条列缺什么，502 upstream、400（不符合交易所下单规则、杠杆不一致等）原样显示。
// A 股 T+1、涨跌停、部分成交后端还没做（没有 A 股行情源），这里不出这些提示；非数币市场的账户归到不可用，原因「行情源还没接」。
import { useState } from 'react'
import {
  tradePlaceError, usePlaceTradeOrder, useTradeInstrument, useTradeLive,
  type TradeAccount, type TradeOrder, type TradeOrderSide, type TradeOrderType, type TradePlaceError, type TradePosition, type TradeRisk,
} from '../../core/data'
import { Button, Drawer, cls } from '../../core/ui'
import { MARKETS, digitsFor, fmtPrice, guessInstrument } from './model'
import { SymbolField } from './MonitorDrawer'
import { NoAccount } from './TradingParts'
import { LIVE_RISK, LIVE_TYPES, ORDER_TYPE, acctBlock, fmtQty, isContract, isOpening, num, riskHints, roundLot, usd } from './tradingModel'

const TYPES: TradeOrderType[] = ['market', 'limit', 'stop', 'stop_limit']
const LEV_MAX = 50

export function OrderDrawer({ init, accounts, positions, risk, onClose, onPlaced }: {
  /** accountId：从实盘账户卡片的「下单」进来时预选这个账户 */
  init: { symbol: string; side: TradeOrderSide; accountId?: string }
  accounts: TradeAccount[]; positions: TradePosition[]; risk?: TradeRisk
  onClose: () => void
  onPlaced: (o: TradeOrder) => void
}) {
  const [symbol, setSymbol] = useState(init.symbol)
  const instQ = useTradeInstrument(symbol)
  const inst = instQ.data ?? guessInstrument(symbol)
  const lot = instQ.data?.lot
  const live = useTradeLive([symbol], symbol)
  const quote = live.quotes[symbol]
  const last = quote?.last ?? 0
  const digits = digitsFor(instQ.data ?? undefined, last)
  // 选过的账户能用就用它，否则默认第一个能用的（账户列表是异步来的，不在初始化时定死）
  const [acctId, setAcctId] = useState(init.accountId ?? '')
  const [showBlocked, setShowBlocked] = useState(false)
  const [side, setSide] = useState<TradeOrderSide>(init.side)
  const [rawType, setType] = useState<TradeOrderType>('limit')
  const [price, setPrice] = useState('')
  const [stop, setStop] = useState('')
  const [qty, setQty] = useState('')
  const [lev, setLev] = useState(() => positions.find((p) => p.symbol === init.symbol)?.leverage ?? 3)
  const [reduce, setReduce] = useState(false)
  const [tried, setTried] = useState(false)
  const [placeErr, setPlaceErr] = useState<TradePlaceError | null>(null)
  /** 实盘单提交前的确认 */
  const [liveAsk, setLiveAsk] = useState(false)
  const place = usePlaceTradeOrder()

  /** 改了任何一项，后端上一次的拦截和确认就作废 */
  const touch = () => { setPlaceErr(null); setLiveAsk(false) }
  const pick = (s: string) => {
    setSymbol(s)
    setPrice(''); setStop(''); setQty(''); setReduce(false); touch()
    setLev(positions.find((p) => p.account_id === account?.id && p.symbol === s)?.leverage ?? 3)
  }

  const usable = accounts.filter((a) => !acctBlock(a, inst))
  // 选过的能用就用它；否则默认第一个能用的模拟盘，没有再取第一个能用的（SPEC-trading-0.2）
  const account = usable.find((a) => a.id === acctId) ?? usable.find((a) => a.paper) ?? usable[0]
  const blocked = accounts.flatMap((a) => { const why = acctBlock(a, inst); return why ? [{ a, why }] : [] })
  const isLive = !!account && !account.paper
  // 实盘只支持市价、限价：选了止损类再换到实盘账户时按限价算
  const type: TradeOrderType = isLive && !LIVE_TYPES.includes(rawType) ? 'limit' : rawType
  const contract = isContract(inst)
  const needPrice = type === 'limit' || type === 'stop_limit'
  const needStop = type === 'stop' || type === 'stop_limit'
  const priceN = Number(price)
  const stopN = Number(stop)
  const ref = type === 'market' ? last : type === 'stop' ? stopN || last : priceN || last
  const rawQty = Number(qty)
  const qtyN = rawQty > 0 ? (lot ? roundLot(rawQty, lot) : rawQty) : 0
  const mult = instQ.data?.multiplier ?? 1
  const value = ref * qtyN * mult
  const levN = contract && inst.kind !== 'option' ? lev : 1
  const pos = positions.find((p) => p.account_id === account?.id && p.symbol === symbol)
  const opening = account ? isOpening(positions, account.id, inst, side, qtyN, contract && reduce) : side === 'buy'

  // 最多能下多少：卖现货看持仓；其他按可用资金（合约乘杠杆）。只是估算，可用资金不足后端会拒
  const maxQty = (() => {
    if (!account) return 0
    if (!contract && side === 'sell') return pos?.side === 'long' ? pos.qty : 0
    const unit = ref * mult
    if (!(unit > 0) || account.available <= 0) return 0
    const q = (account.available * levN) / unit / (1 + account.fee_bp / 10000)
    return lot ? roundLot(q, lot) : Number(q.toFixed(6))
  })()

  const errors: string[] = []
  if (!account) errors.push('选一个可交易的账户')
  if (needPrice && !(priceN > 0)) errors.push('填委托价格')
  if (needStop && !(stopN > 0)) errors.push('填触发价')
  if (!(qtyN > 0)) errors.push(rawQty > 0 && lot ? `数量不足最小单位 ${lot}` : '填数量')
  if (type === 'market' && !(last > 0)) errors.push('还没有最新价，市价单下不了')
  const hints = risk && qtyN > 0 ? riskHints({ risk, account, inst, value, leverage: levN, opening, positions }) : []
  const confirming = placeErr?.kind === 'confirm' ? placeErr : null

  const submit = (confirmed = false) => {
    setTried(true)
    if (errors.length || !account) return
    // 实盘每笔都要确认（不看金额）：先在底部确认，确认后带 confirmed 提交
    if (isLive && !confirmed) { setLiveAsk(true); return }
    place.mutate({
      account_id: account.id, symbol, side, type, qty: qtyN,
      price: needPrice ? priceN : undefined, stop_price: needStop ? stopN : undefined,
      leverage: contract && inst.kind !== 'option' ? lev : undefined, reduce_only: contract ? reduce : undefined,
      confirmed: confirmed || undefined,
    }, {
      onSuccess: onPlaced,
      onError: (e) => { setLiveAsk(false); setPlaceErr(tradePlaceError(e)) },
    })
  }
  const sideLabel = side === 'buy' ? '买入' : '卖出'
  const liveConfirm = isLive && (liveAsk || !!confirming)

  return (
    <Drawer open onClose={onClose} kicker={isLive ? '下单 · 实盘' : '下单 · 模拟盘'} aria-label="下单" className="tr-drawer"
      footer={(requestClose) => liveConfirm && account ? (
        <>
          <span className="tr-confirm-q" role="alert">
            <span className="tag tr-tag-sm tr-tag-live">实盘</span>
            {account.name}：{sideLabel} {fmtQty(qtyN, lot)} {inst.name}，金额约 <b>{num(value, 2)} {account.currency}</b>，{LIVE_RISK}
          </span>
          <span className="spacer" />
          <Button onClick={touch}>返回修改</Button>
          <button type="button" className={cls('btn', side === 'buy' ? 'tr-btn-buy' : 'tr-btn-sell')} disabled={place.isPending} onClick={() => submit(true)}>
            {place.isPending ? '提交中…' : `确认实盘${sideLabel}`}
          </button>
        </>
      ) : confirming ? (
        <>
          <span className="tr-confirm-q">金额约 <b>{usd(confirming.value)}</b>，超过 {usd(confirming.confirm_above)} 二次确认线</span>
          <span className="spacer" />
          <Button onClick={touch}>返回修改</Button>
          <button type="button" className={cls('btn', side === 'buy' ? 'tr-btn-buy' : 'tr-btn-sell')} disabled={place.isPending} onClick={() => submit(true)}>确认{sideLabel}</button>
        </>
      ) : (
        <>
          {tried && errors.length > 0 ? <span className="field-err" role="alert">{errors[0]}</span>
            : <span className="tr-muted tr-small">{account ? `${account.name}（${account.paper ? '模拟' : '实盘'}）` : ''}</span>}
          <span className="spacer" />
          <Button onClick={requestClose}>取消</Button>
          <button type="button" className={cls('btn', side === 'buy' ? 'tr-btn-buy' : 'tr-btn-sell')} disabled={place.isPending} onClick={() => submit()}>
            {place.isPending ? '提交中…' : `${sideLabel}${qtyN > 0 ? ` ${fmtQty(qtyN, lot)}` : ''}`}
          </button>
        </>
      )}>
      <div className="form">
        {isLive && account && (
          <div className="tr-banner tr-banner-danger tr-live-banner" role="note" aria-label="实盘提示">
            <span className="tag tr-tag-sm tr-tag-live">实盘</span>
            <span>用的是实盘账户「{account.name}」：这笔会发到 {account.broker}，{LIVE_RISK}。只支持市价、限价，每笔都要二次确认；不改交易所杠杆。</span>
          </div>
        )}
        <div className="field">
          <span className="field-label">标的</span>
          <SymbolField value={symbol} inst={inst} price={last || undefined} digits={digits} onChange={(s) => pick(s)} />
          {quote && quote.status !== 'live' && <span className="field-hint-line">行情{quote.status === 'stale' ? '暂时取不到，显示的是缓存' : quote.status === 'no_source' ? '源还没接' : '加载中'}；行情不是实时时后端不撮合</span>}
        </div>

        <div className="field">
          <span className="field-label">账户<span className="tr-hint">只能选支持{MARKETS[inst.market].label}的模拟盘，或闸门全开的实盘账户</span></span>
          {!accounts.length ? <NoAccount compact /> : (
            <>
              <div className="tr-acct-pick">
                {usable.map((a) => (
                  <button key={a.id} type="button" className={cls('tr-acct-opt', account?.id === a.id && 'on')} aria-pressed={account?.id === a.id} onClick={() => { setAcctId(a.id); touch() }}>
                    <span><span className="ellipsis">{a.name}</span><span className={cls('tag tr-tag-sm', !a.paper && 'tr-tag-live')}>{a.paper ? '模拟' : '实盘'}</span></span>
                    <span className="tr-small tr-muted">可用 {num(a.available, 2)} {a.currency}</span>
                  </button>
                ))}
                {showBlocked && blocked.map(({ a, why }) => (
                  <button key={a.id} type="button" disabled className="tr-acct-opt" title={why}>
                    <span className="ellipsis">{a.name}</span>
                    <span className="tr-small faint">{why}</span>
                  </button>
                ))}
              </div>
              {!usable.length && <div className="tr-empty-box">没有能交易{MARKETS[inst.market].label}的账户{blocked[0] ? `：${blocked[0].why}` : ''}</div>}
              {blocked.length > 0 && (
                <button type="button" className="tr-link tr-acct-more" onClick={() => setShowBlocked(!showBlocked)}>
                  {showBlocked ? '收起不可用的账户' : `其他 ${blocked.length} 个账户不可用`}
                </button>
              )}
            </>
          )}
        </div>

        <div className="field-row">
          <div className="field">
            <span className="field-label">方向</span>
            <div className="tr-seg tr-seg-full tr-side-seg" role="group" aria-label="方向">
              <button type="button" className={cls(side === 'buy' && 'on buy')} aria-pressed={side === 'buy'} onClick={() => { setSide('buy'); touch() }}>{contract ? '买入 / 开多' : '买入'}</button>
              <button type="button" className={cls(side === 'sell' && 'on sell')} aria-pressed={side === 'sell'} onClick={() => { setSide('sell'); touch() }}>{contract ? '卖出 / 开空' : '卖出'}</button>
            </div>
          </div>
          <div className="field">
            <span className="field-label">类型</span>
            <div className="tr-seg tr-seg-full" role="group" aria-label="委托类型">
              {TYPES.map((k) => {
                const off = isLive && !LIVE_TYPES.includes(k)
                return (
                  <button key={k} type="button" className={cls(type === k && 'on')} aria-pressed={type === k} disabled={off} title={off ? '实盘只支持市价、限价' : undefined}
                    onClick={() => { setType(k); touch() }}>{k === 'stop' ? '止损' : ORDER_TYPE[k]}</button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="field-row">
          {needStop && (
            <label className="field"><span className="field-label">触发价<span className="tr-hint">{side === 'sell' ? '跌到这个价触发' : '涨到这个价触发'}</span></span>
              <input className={cls('input', tried && !(stopN > 0) && 'bad')} inputMode="decimal" aria-label="触发价" value={stop} placeholder={last ? fmtPrice(last, digits) : ''}
                onChange={(e) => { setStop(e.target.value); touch() }} />
            </label>
          )}
          {needPrice ? (
            <label className="field"><span className="field-label">委托价<span className="tr-hint">现价 {last ? fmtPrice(last, digits) : '-'}</span></span>
              <span className="tr-input-row">
                <input className={cls('input', tried && !(priceN > 0) && 'bad')} inputMode="decimal" aria-label="委托价" value={price} placeholder={last ? fmtPrice(last, digits) : ''}
                  onChange={(e) => { setPrice(e.target.value); touch() }} />
                <Button size="sm" disabled={!(last > 0)} onClick={() => { setPrice(last.toFixed(Math.max(0, digits))); touch() }}>现价</Button>
              </span>
            </label>
          ) : type === 'market' ? (
            <div className="field"><span className="field-label">价格</span><div className="tr-static tr-num">市价，约 {last ? fmtPrice(last, digits) : '-'}，成交时加减滑点</div></div>
          ) : null}
          <label className="field"><span className="field-label">数量<span className="tr-hint">{lot ? `最小单位 ${lot}` : ''}{mult !== 1 ? `，每张 ${mult}` : ''}</span></span>
            <input className={cls('input', tried && !(qtyN > 0) && 'bad')} inputMode="decimal" aria-label="数量" value={qty} placeholder={lot ? String(lot) : ''}
              onChange={(e) => { setQty(e.target.value); touch() }} onBlur={() => { if (qtyN > 0 && qtyN !== rawQty) setQty(String(qtyN)) }} />
          </label>
        </div>
        <div className="tr-qty-quick">
          {[0.25, 0.5, 1].map((f) => (
            <Button key={f} size="sm" disabled={!maxQty} onClick={() => { setQty(String(lot ? roundLot(maxQty * f, lot) : Number((maxQty * f).toFixed(6)))); touch() }}>{f === 1 ? '最大' : `${f * 100}%`}</Button>
          ))}
          <span className="faint tr-small">最多约 {fmtQty(maxQty, lot)}</span>
          <span className="spacer" />
          <span className="tr-num tr-amount">金额 {num(value, 2)} {account?.currency ?? 'USD'}</span>
        </div>
        {qtyN > 0 && qtyN !== rawQty && <div className="field-hint-line">按最小单位取整为 {fmtQty(qtyN, lot)}</div>}

        {contract && (
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">合约设置</div>
            {inst.kind !== 'option' && (
              <div className="field">
                <span className="field-label">杠杆<span className="tr-hint">上限 {risk?.max_leverage ?? '-'}x；保证金约 {num(value / lev, 2)}{isLive ? '；实盘不改交易所杠杆，要和交易所现在的一致' : ''}</span></span>
                <div className="tr-lev">
                  <input type="range" min={1} max={LEV_MAX} value={lev} aria-label="杠杆" onChange={(e) => { setLev(Number(e.target.value)); touch() }} />
                  <span className={cls('tr-num tr-lev-n', risk && lev > risk.max_leverage && 'danger-text')}>{lev}x</span>
                </div>
              </div>
            )}
            <label className="check"><input type="checkbox" checked={reduce} onChange={(e) => { setReduce(e.target.checked); touch() }} />仅减仓：只平掉反向持仓，不会开新仓</label>
          </section>
        )}

        {pos && <div className="tr-muted tr-small">该账户已有{pos.side === 'long' ? '多' : '空'}仓 {fmtQty(pos.qty, lot)}，成本 {fmtPrice(pos.avg_price, digits)}{pos.leverage ? `，${pos.leverage}x` : ''}</div>}

        {placeErr?.kind === 'risk' && (
          <div className="tr-block" role="alert">
            <b>风控未通过</b>
            <span>{placeErr.order ? '这笔已记成被拒绝的委托，' : ''}后端拦下的原因：</span>
            <ul>{placeErr.blocks.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
        {placeErr?.kind === 'gate' && (
          <div className="tr-block" role="alert">
            <b>实盘闸门没过</b>
            <span>这笔没发到交易所，缺：</span>
            <ul>{placeErr.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
        {placeErr?.kind === 'upstream' && <div className="tr-block" role="alert"><b>交易所没回</b><span>{placeErr.message}</span></div>}
        {(placeErr?.kind === 'other' || placeErr?.kind === 'not_user') && <div className="tr-block" role="alert"><b>没下成</b><span>{placeErr.message}</span></div>}
        {!placeErr && hints.length > 0 && (
          <div className="tr-hints">
            <div><b>预检查</b>：提交后后端会按同样的规则拦下，以后端结果为准</div>
            <ul>{hints.map((h) => <li key={h}>{h}</li>)}</ul>
          </div>
        )}
      </div>
    </Drawer>
  )
}
