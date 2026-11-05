// 提醒抽屉（SPEC-monitor-3）：新建和编辑共用。条件按标的品种过滤，当前值由后端现算（/alerts/preview），保存失败抽屉不关、底部显示原因。
import { useMemo, useState } from 'react'
import {
  errorText, useCreateTradeAlert, usePatchTradeAlert, useRemoveTradeAlert, useTradeAlertPreview,
  useTradeInstrument, useTradeInstrumentSearch, useTradeWatchlists,
  type TradeAlert, type TradeAlertCond, type TradeAlertNotify, type TradeInstrument,
} from '../../core/data'
import { Button, Checkbox, Drawer, Field, IconClose, IconSearch, Input, Select, Switch, Textarea, cls } from '../../core/ui'
import { KIND_SHORT, MARKETS, digitsFor, guessInstrument } from './model'
import { useImConnectors } from './useImConnectors'
import {
  ALERT_COND, ALERT_CONDS, NOTIFIES, NOTIFY_LABEL, condFits, draftBody, draftErrors, draftOf, fillValue, fmtAlertValue, valueOk, withSymbol,
  type AlertDraft,
} from './monitorModel'

const SYMBOL_RE = /^[A-Z][A-Z0-9_]{0,15}:[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/

const CONN_STATUS: Record<string, string> = { connecting: '连接中', error: '异常', paused: '已暂停', disconnected: '已断开' }

export function AlertDrawer({ alert, symbol, onClose }: { alert: TradeAlert | null; symbol: string; onClose: () => void }) {
  const ims = useImConnectors()
  const [init] = useState<AlertDraft>(() => draftOf(alert, symbol, ims[0]?.id ?? ''))
  const [d, setD] = useState<AlertDraft>(init)
  const [tried, setTried] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const create = useCreateTradeAlert()
  const patch = usePatchTradeAlert()
  const remove = useRemoveTradeAlert()
  const busy = create.isPending || patch.isPending || remove.isPending
  const instQ = useTradeInstrument(d.symbol)
  const inst = instQ.data ?? guessInstrument(d.symbol)
  const preview = useTradeAlertPreview(d.symbol, d.cond)
  const cur = preview.data
  const digits = digitsFor(instQ.data ?? undefined, cur?.price || cur?.value || 0)
  const conds = ALERT_CONDS.filter((c) => condFits(c, inst))
  // IM 连接器列表是异步来的：新建时还没选就默认第一个
  const imId = d.im_connector || (alert ? '' : ims[0]?.id ?? '')
  const draft = { ...d, im_connector: imId }
  const errors = draftErrors(draft, inst)
  const dirty = JSON.stringify(d) !== JSON.stringify(init)
  const set = <K extends keyof AlertDraft>(k: K, v: AlertDraft[K]) => setD((x) => ({ ...x, [k]: v }))
  const toggleNotify = (n: TradeAlertNotify) => setD((x) => ({ ...x, notify: x.notify.includes(n) ? x.notify.filter((y) => y !== n) : [...x.notify, n] }))
  const imConn = ims.find((c) => c.id === imId)

  const save = () => {
    setTried(true)
    setErr('')
    if (errors.length) return
    const body = draftBody(draft)
    const done = { onSuccess: onClose, onError: (e: unknown) => setErr(errorText(e)) }
    if (alert) patch.mutate({ id: alert.id, ...body }, done)
    else create.mutate(body, done)
  }
  const del = () => {
    if (!alert) return
    remove.mutate(alert.id, { onSuccess: onClose, onError: (e: unknown) => setErr(errorText(e)) })
  }
  const curText = cur?.status === 'ok' && cur.value !== null ? fmtAlertValue(d.cond, cur.value, digits) : '-'
  const curHint = !cur ? '' : cur.status === 'ok' ? '' : cur.error || PREVIEW_STATUS[cur.status] || ''

  return (
    <Drawer open onClose={onClose} dirty={dirty} kicker={alert ? '编辑提醒' : '新建提醒'} aria-label={alert ? '编辑提醒' : '新建提醒'} className="mo-drawer"
      footer={(requestClose) => (
        <>
          {alert && (confirmDel
            ? <><span className="danger-text">确认删除？</span><Button variant="danger" disabled={busy} onClick={del}>删除</Button><Button onClick={() => setConfirmDel(false)}>算了</Button></>
            : <Button onClick={() => setConfirmDel(true)}>删除</Button>)}
          <span className="spacer" />
          {(tried && errors[0]) || err ? <span className="field-err" role="alert">{err || errors[0]}</span> : null}
          <Button variant="outline" onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy || errors.length > 0} onClick={save}>保存</Button>
        </>
      )}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save() }}>
        <Field label="标的" wrap={false} hint="搜名称或代码；标的表里还没有的可以直接写 交易场所:代码">
          <SymbolField value={d.symbol} inst={inst} price={cur?.price} digits={digits}
            onChange={(s, i) => setD((x) => withSymbol(x, s, i))} />
        </Field>
        <div className="field-row">
          <Field label="条件" hint="按品种过滤">
            <Select aria-label="条件" value={d.cond} options={conds.map((c) => ({ value: c, label: ALERT_COND[c].label }))}
              onValueChange={(v) => setD((x) => ({ ...x, cond: v as TradeAlertCond, value: '' }))} />
          </Field>
          <Field label="阈值" required hint={ALERT_COND[d.cond].unit} error={d.value.trim() && !valueOk(d) ? '阈值要是数字' : undefined}>
            <Input aria-label="阈值" inputMode="decimal" placeholder={ALERT_COND[d.cond].unit} value={d.value}
              invalid={d.value.trim() !== '' && !valueOk(d)} onChange={(e) => set('value', e.target.value)} />
          </Field>
        </div>
        <div className="mo-cur">
          <span className="muted">当前值</span>
          <span className="mo-cur-v" data-testid="mo-cur">{curText}</span>
          {curHint && <span className="faint">{curHint}</span>}
          {d.cond === 'pct_below' && <span className="faint">跌幅按正数填，例如 4 表示跌 4%</span>}
          {d.cond === 'limit_near' && <span className="faint">离涨停或跌停的距离，占昨收的百分比</span>}
          {(d.cond === 'price_above' || d.cond === 'price_below') && <span className="faint">价格在阈值{d.cond === 'price_above' ? '上方' : '下方'}时就算满足</span>}
          <span className="spacer" />
          <Button size="sm" disabled={cur?.status !== 'ok' || cur.value === null}
            onClick={() => { if (cur?.value != null) set('value', fillValue(d.cond, cur.value, digits)) }}>填入当前值</Button>
        </div>

        <section className="mo-group">
          <div className="mo-group-title">通知方式</div>
          <div className="mo-checks">
            {NOTIFIES.map((n) => <Checkbox key={n} checked={d.notify.includes(n)} onCheckedChange={() => toggleNotify(n)}>{NOTIFY_LABEL[n]}</Checkbox>)}
          </div>
          {d.notify.includes('im') && (ims.length ? (
            <Field label="推送到" hint={imConn && imConn.status !== 'connected' ? `这个连接器现在${CONN_STATUS[imConn.status] ?? imConn.status}，提醒推不出去` : undefined}>
              <Select aria-label="推送到" value={imId} onValueChange={(v) => set('im_connector', v)}
                options={[{ value: '', label: '选一个 IM 连接器' }, ...ims.map((c) => ({ value: c.id, label: c.status === 'connected' ? c.name : `${c.name}（${CONN_STATUS[c.status] ?? c.status}）` }))]} />
            </Field>
          ) : <div className="mk-empty">还没有可用的 IM 连接器，到 设置 &gt; 连接器 里接一个</div>)}
          {d.notify.includes('im') && <span className="faint mo-note">工作台还没有给插件发 IM 的接口，触发时先只记在触发记录上并发应用内通知</span>}
          {!d.notify.length && <span className="field-err">至少选一种通知方式</span>}
        </section>

        <section className="mo-group">
          <div className="mo-group-title">触发方式</div>
          <div className="mk-seg mo-seg-full">
            <button type="button" className={cls(!d.repeat && 'on')} onClick={() => set('repeat', false)}>单次：触发后停止</button>
            <button type="button" className={cls(d.repeat && 'on')} onClick={() => set('repeat', true)}>重复：满足就提醒</button>
          </div>
          {d.repeat && (
            <Field label="冷却" hint="两次提醒至少间隔多少分钟">
              <Input aria-label="冷却" inputMode="numeric" value={String(d.cooldown_min)} onChange={(e) => set('cooldown_min', Number(e.target.value.replace(/\D/g, '')) || 0)} />
            </Field>
          )}
          <Switch checked={d.enabled} onCheckedChange={(on) => set('enabled', on)}>
            <span>启用<span className="faint mo-sw-hint">停用后保留规则，不再检查</span></span>
          </Switch>
        </section>

        <Field label="备注" hint="触发时一起显示，写打算怎么处理">
          <Textarea aria-label="备注" rows={3} maxLength={500} value={d.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
      </form>
    </Drawer>
  )
}

const PREVIEW_STATUS: Record<string, string> = {
  no_source: '这个市场的行情源还没接', loading: '行情加载中', stale: '行情已停，显示的是缓存', error: '取不到行情',
  unsupported: '条件不适用于这个标的', unavailable: '行情源给不了这项数据',
}

/** 标的选择：搜标的表；为空时列当前自选里的；输入完整的 交易场所:代码 也能直接用。下单抽屉也用它（样式在 markets.css、monitor.css） */
export function SymbolField({ value, inst, price, digits, onChange }: {
  value: string
  inst: TradeInstrument
  price?: number
  digits: number
  onChange: (symbol: string, inst: TradeInstrument | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const search = useTradeInstrumentSearch(q)
  const wq = useTradeWatchlists()
  const kw = q.trim()
  const watchSyms = useMemo(() => [...new Set((wq.data ?? []).flatMap((w) => w.symbols))], [wq.data])
  const results: TradeInstrument[] = kw ? search.data ?? [] : watchSyms.slice(0, 30).map((s) => guessInstrument(s))
  const raw = SYMBOL_RE.test(kw) && !results.some((r) => r.symbol === kw) ? kw : ''
  const pick = (s: string, i?: TradeInstrument) => {
    onChange(s, i ?? guessInstrument(s))
    setOpen(false)
    setQ('')
  }
  if (!open) {
    return (
      <button type="button" className="mo-sym" onClick={() => setOpen(true)} aria-label="换标的">
        <span className="mk-dot" style={{ background: MARKETS[inst.market].color }} />
        <span className="mo-sym-name ellipsis">{inst.name}</span>
        <span className="mk-code ellipsis">{value}</span>
        {inst.kind !== 'spot' && <span className="mk-kind">{KIND_SHORT[inst.kind] ?? inst.kind}</span>}
        <span className="spacer" />
        {price ? <span className="mo-sym-px">{price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span> : null}
        <span className="faint">换</span>
      </button>
    )
  }
  return (
    <div className="mk-search-wrap">
      <div className="search search-sm">
        <IconSearch size={13} />
        <input autoFocus aria-label="搜标的" placeholder="搜名称或代码，如 BTC、BINANCE:ETHUSDT" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); if (q) setQ(''); else setOpen(false) }
            if (e.key === 'Enter') { e.preventDefault(); if (raw) pick(raw) }
          }} />
        <button type="button" className="search-clear" onClick={() => { setQ(''); setOpen(false) }} title="收起" aria-label="收起"><IconClose size={10} /></button>
      </div>
      <div className="mk-results">
        {!kw && <div className="mk-results-empty">{watchSyms.length ? '自选里的标的，也可以输入搜索' : '输入名称或代码搜索'}</div>}
        {kw && search.isLoading && <div className="mk-results-empty">搜索中</div>}
        {kw && !search.isLoading && !results.length && !raw && <div className="mk-results-empty">没有匹配的标的（标的表每天从行情源同步一次）</div>}
        {raw && (
          <button type="button" className="mk-result" onClick={() => pick(raw)}>
            <span className="mk-result-text"><span className="ellipsis">使用 {raw}</span><span className="mk-code">标的表里还没有，按代码直接用</span></span>
          </button>
        )}
        {results.map((i) => (
          <button type="button" key={i.symbol} className={cls('mk-result', i.symbol === value && 'on')} onClick={() => pick(i.symbol, kw ? i : undefined)}>
            <span className="mk-dot" style={{ background: MARKETS[i.market].color }} />
            <span className="mk-result-text"><span className="ellipsis">{i.name}</span><span className="mk-code ellipsis">{i.symbol}{i.venue ? ` · ${i.venue}` : ''}</span></span>
            {i.kind !== 'spot' && <span className="mk-kind">{KIND_SHORT[i.kind] ?? i.kind}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
