// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 策略编辑页（SPEC-strategy-3、4、5）：基本信息、条件规则或代码、风控和参数；右栏快速回测和最近一次回测。
// 改动自动保存：本地草稿立刻生效，停 500ms 后整份 PATCH；同一时间只有一个保存在路上，期间的改动等它回来再存。
// 保存失败时底部换成红字和「重试」，改动留在界面上（SPEC-strategy-3.30）。
// 「部署」先把没存的存掉，再跳到交易「策略运行」打开部署抽屉（SPEC-strategy-3.2，只能部署到模拟盘）；右栏多「运行记录」（SPEC-strategy-5.10）。
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, useRemoveTradeStrategy, useStartTradeBacktest, usePatchTradeStrategy, useTradeBacktest, useTradeInstrumentSearch, useTradeOrders, useTradeRuns,
  type TradeBacktestBrief, type TradeCompare, type TradeIndicator, type TradeOperand, type TradeRule, type TradeRuleGroup, type TradeStrategy,
  tradeStrategyApi,
} from '../../core/data'
import { Button, PageTitle, cls } from '../../core/ui'
import { KIND_SHORT, MARKETS, guessInstrument } from './model'
import {
  CODE_KIND_LABEL, COMPARE, DIR_LABEL, INDICATORS, IND_DEFAULT, MODE_LABEL, STRATEGY_INTERVALS, blockerOf, codeKindOf, currencyOf, inputOf,
  instName, intervalLabel, latestOf, newRuleId, pctRaw, quickDefaults, quickParams, sig, spanText, timeAgo, tone, withParam, type QuickCfg,
} from './strategyModel'
import { NumInput, PlusIcon, Signed, Spark, StatusCell, XIcon } from './StrategyParts'
import { StrategyRunsPanel } from './StrategyRuns'

const SAVE_DELAY = 500

type SaveState = { state: 'idle' | 'saving' | 'error'; error?: string }

export function StrategyEditor({ strategy, backtests, now, onOpenBacktest, onDeleted }: {
  strategy: TradeStrategy
  backtests: TradeBacktestBrief[]
  now: number
  onOpenBacktest: (id: string) => void
  onDeleted: () => void
}) {
  const [st, setSt] = useState(strategy)
  const [qc, setQc] = useState<QuickCfg>(() => quickDefaults(strategy))
  const [confirmDel, setConfirmDel] = useState(false)
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [nameTouched, setNameTouched] = useState(false)
  const patch = usePatchTradeStrategy()
  const remove = useRemoveTradeStrategy()
  const start = useStartTradeBacktest()
  const navigate = useNavigate()
  // 删除的影响：这个策略没停的部署会停止、它们的挂单会撤销（后端删策略时一起做，SPEC-strategy-3.20）
  const runs = useTradeRuns(strategy.id)
  const activeOrders = useTradeOrders({ status: 'active' }, confirmDel)

  // 自动保存的排队：timer 等停手，inflight 是路上那一次，next 是它回来之后要存的
  const q = useRef<{ timer?: ReturnType<typeof setTimeout>; inflight: Promise<void> | null; next: TradeStrategy | null }>({ inflight: null, next: null })
  /** 把没存的存掉；回 false 表示没存上（原因在底部） */
  const flush = async (): Promise<boolean> => {
    const box = q.current
    if (box.timer) {
      clearTimeout(box.timer)
      box.timer = undefined
    }
    while (box.inflight) await box.inflight
    const draft = box.next
    if (!draft) return true
    box.next = null
    setSave({ state: 'saving' })
    let ok = true
    box.inflight = patch.mutateAsync({ id: draft.id, body: inputOf(draft) }).then(
      () => undefined,
      (e: unknown) => {
        ok = false
        // 没存上的留着，「重试」或下一次改动时再存
        if (!box.next) box.next = draft
        setSave({ state: 'error', error: errorText(e) })
      },
    )
    await box.inflight
    box.inflight = null
    if (!ok) return false
    if (box.next && !box.timer) return flush()
    if (!box.next) setSave({ state: 'idle' })
    return true
  }
  const schedule = (next: TradeStrategy) => {
    const box = q.current
    box.next = next
    if (box.timer) clearTimeout(box.timer)
    box.timer = setTimeout(() => {
      box.timer = undefined
      void flush()
    }, SAVE_DELAY)
  }
  // 离开编辑页时把没存的立刻存掉
  useEffect(() => () => {
    const box = q.current
    if (box.timer) clearTimeout(box.timer)
    if (box.next) void tradeStrategyApi.patchStrategy(box.next.id, inputOf(box.next)).catch(() => undefined)
  }, [])

  const set = (p: Partial<TradeStrategy>) => {
    const next = { ...st, ...p, updated_at: new Date().toISOString() }
    setSt(next)
    schedule(next)
  }

  const blocker = blockerOf(st)
  const nameErr = nameTouched && !st.name.trim()
  const lastBt = latestOf(st.id, backtests)
  const deploy = async () => {
    if (!(await flush())) return
    void navigate(`/trading/runs?${new URLSearchParams({ deploy: st.id })}`)
  }
  const liveRuns = (runs.data?.data ?? []).filter((r) => r.status !== 'stopped')
  const liveRunIds = new Set(liveRuns.map((r) => r.id))
  const runOrders = (activeOrders.data?.data ?? []).filter((o) => o.run_id && liveRunIds.has(o.run_id)).length
  const delImpact = [
    ...(liveRuns.length ? [`${liveRuns.length} 个运行中、暂停或异常挂起的部署会停止`] : []),
    ...(runOrders ? [`${runOrders} 笔挂单会撤销`] : []),
    '已有的回测记录保留',
  ].join('，')
  const run = async () => {
    if (blocker || !(await flush())) return
    start.mutate({ strategy_id: st.id, bars: qc.bars, capital: qc.capital, fee_bp: qc.fee_bp, slippage_ticks: qc.slippage_ticks, params: quickParams(st, qc) })
  }

  return (
    <div className="sg-page sg-edit">
      <PageTitle parent="策略" desc={st.desc || undefined} actions={<>
        <Button variant="outline" title="部署到模拟盘账户上跑" onClick={() => void deploy()}>部署</Button>
        <Button variant="primary" disabled={!!blocker || start.isPending} title={blocker || undefined} onClick={() => void run()}>开始回测</Button>
      </>}>{st.name || '未命名策略'}</PageTitle>

      <div className="sg-grid">
        <div className="sg-col">
          <BasicInfo st={st} set={set} nameErr={nameErr} onNameBlur={() => setNameTouched(true)} />

          <section className="sg-sec" aria-label="策略逻辑">
            <div className="sg-sec-head">
              <span className="sg-sec-title">策略逻辑</span>
              <span className="spacer" />
              <div className="sg-seg sg-seg-sm" role="group" aria-label="模式">
                {(['rules', 'code'] as const).map((m) => <button key={m} type="button" className={cls(st.mode === m && 'on')} aria-pressed={st.mode === m} onClick={() => set({ mode: m })}>{MODE_LABEL[m]}</button>)}
              </div>
            </div>
            {st.mode === 'rules' ? (
              <>
                <GroupEditor title="入场条件" hint={st.direction === 'both' ? '满足时做多，有空单先平' : st.direction === 'short' ? '满足时开空' : '满足时开多'} group={st.entry} onChange={(entry) => set({ entry })} />
                <GroupEditor title="出场条件" hint={st.direction === 'both' ? '满足时做空，有多单先平' : '满足时平仓'} group={st.exit} onChange={(exit) => set({ exit })} />
              </>
            ) : (
              <CodeEditor st={st} set={set} />
            )}
          </section>

          <section className="sg-sec" aria-label="风控与仓位">
            <div className="sg-sec-title">风控与仓位</div>
            <div className="sg-risk">
              <label className="field"><span className="field-label">止损 %<span className="sg-hint">0 不设</span></span><NumInput label="止损 %" min={0} value={st.stop_loss} onChange={(v) => set({ stop_loss: Math.max(0, Math.min(100, v)) })} /></label>
              <label className="field"><span className="field-label">止盈 %<span className="sg-hint">0 不设</span></span><NumInput label="止盈 %" min={0} value={st.take_profit} onChange={(v) => set({ take_profit: Math.max(0, Math.min(100, v)) })} /></label>
              <label className="field"><span className="field-label">每次开仓占账户 %</span><NumInput label="每次开仓占账户 %" min={1} value={st.position_pct} onChange={(v) => set({ position_pct: Math.max(0, Math.min(100, v)) })} /></label>
            </div>
          </section>

          <ParamsTable st={st} setParams={(params) => set({ params })} setParam={(k, v) => set(withParam(st, k, v))} />
        </div>

        <div className="sg-col sg-side">
          <QuickPanel st={st} qc={qc} setQc={setQc} blocker={blocker} busy={start.isPending} error={start.error ? errorText(start.error) : ''} onRun={() => void run()} />
          <LastPanel st={st} bt={lastBt} now={now} onOpen={onOpenBacktest} />
          <StrategyRunsPanel st={st} onOpenAll={() => void navigate('/strategy/runs')} onDeploy={() => void deploy()} />
        </div>
      </div>

      <div className="sg-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">删除后不能恢复：{delImpact}{remove.error ? `；删除失败：${errorText(remove.error)}` : ''}</span>
            <span className="spacer" />
            <Button onClick={() => setConfirmDel(false)}>取消</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => {
              const box = q.current
              if (box.timer) clearTimeout(box.timer)
              box.next = null
              remove.mutate(st.id, { onSuccess: onDeleted })
            }}>删除</Button>
          </>
        ) : (
          <>
            <Button variant="danger-ghost" onClick={() => setConfirmDel(true)}>删除策略</Button>
            <span className="spacer" />
            {save.state === 'error' ? (
              <span className="sg-save-err" role="alert">保存失败，{save.error}<button type="button" className="sg-link" onClick={() => {
                q.current.next = q.current.next ?? st
                void flush()
              }}>重试</button></span>
            ) : (
              <span className="sg-muted">{save.state === 'saving' ? '保存中…' : `改动自动保存 · ${timeAgo(st.updated_at, now)}更新`}</span>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function BasicInfo({ st, set, nameErr, onNameBlur }: { st: TradeStrategy; set: (p: Partial<TradeStrategy>) => void; nameErr: boolean; onNameBlur: () => void }) {
  const [tagInput, setTagInput] = useState('')
  const addTag = () => {
    const t = tagInput.trim()
    if (t && !st.tags.includes(t)) set({ tags: [...st.tags, t] })
    setTagInput('')
  }
  const currencies = new Set(st.symbols.map((s) => currencyOf([s])))
  return (
    <section className="sg-sec" aria-label="基本信息">
      <div className="sg-sec-title">基本信息</div>
      <label className="field">
        <span className="field-label">名称<em className="sg-req">*</em></span>
        <input className={cls('sg-input', nameErr && 'bad')} value={st.name} placeholder="比如：双均线趋势" aria-invalid={nameErr} onBlur={onNameBlur} onChange={(e) => set({ name: e.target.value })} />
        {nameErr && <span className="field-err">名称不能为空，其余改动照常保存</span>}
      </label>
      <label className="field">
        <span className="field-label">说明</span>
        <textarea className="sg-input" rows={2} value={st.desc} placeholder="什么行情下用、怎么进出场" onChange={(e) => set({ desc: e.target.value })} />
      </label>
      <div className="field">
        <span className="field-label">标签<span className="sg-hint">用于在策略库里搜</span></span>
        <div className="sg-tag-input">
          {st.tags.map((t) => <span key={t} className="tag">{t}<button type="button" title="移除" aria-label={`移除标签 ${t}`} onClick={() => set({ tags: st.tags.filter((x) => x !== t) })}><XIcon /></button></span>)}
          <input value={tagInput} aria-label="加标签" placeholder={st.tags.length ? '' : '输入后回车添加'} onChange={(e) => setTagInput(e.target.value)} onBlur={addTag}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
              if (e.key === 'Backspace' && !tagInput && st.tags.length) set({ tags: st.tags.slice(0, -1) })
            }} />
        </div>
      </div>
      <SymbolPicker value={st.symbols} onChange={(symbols) => set({ symbols })} />
      {currencies.size > 1 && <div className="field-hint-line">选了不同币种的标的，回测按各自币种直接相加，不做汇率换算</div>}
      <div className="field">
        <span className="field-label">K 线周期</span>
        <div className="sg-seg sg-seg-wrap" role="group" aria-label="K 线周期">
          {STRATEGY_INTERVALS.map((k) => <button key={k} type="button" className={cls(st.interval === k && 'on')} aria-pressed={st.interval === k} onClick={() => set({ interval: k })}>{intervalLabel(k)}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="field-label">方向</span>
        <div className="sg-seg sg-seg-wrap" role="group" aria-label="方向">
          {(Object.keys(DIR_LABEL) as TradeStrategy['direction'][]).map((k) => <button key={k} type="button" className={cls(st.direction === k && 'on')} aria-pressed={st.direction === k} onClick={() => set({ direction: k })}>{DIR_LABEL[k]}</button>)}
        </div>
      </div>
    </section>
  )
}

/** 选标的：按名称、代码搜后端的标的表（行情源每天同步），最多 8 个候选 */
function SymbolPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const found = useTradeInstrumentSearch(q)
  const opts = (found.data ?? []).filter((i) => !value.includes(i.symbol)).slice(0, 8)
  const add = (s: string) => {
    onChange([...value, s])
    setQ('')
  }
  const kw = q.trim()
  return (
    <div className="field">
      <span className="field-label">标的<em className="sg-req">*</em><span className="sg-hint">可多选，回测时资金平均分配</span></span>
      <div className="sg-pick">
        <div className="sg-tag-input">
          {value.map((s) => {
            const k = guessInstrument(s).kind
            return (
              <span key={s} className="tag" title={s}>{instName(s)}{KIND_SHORT[k] && <span className="faint"> {KIND_SHORT[k]}</span>}
                <button type="button" title="移除" aria-label={`移除 ${instName(s)}`} onClick={() => onChange(value.filter((x) => x !== s))}><XIcon /></button>
              </span>
            )
          })}
          <input value={q} aria-label="搜标的" placeholder={value.length ? '继续添加' : '搜名称、代码，如 BTC'} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
            onChange={(e) => {
              setQ(e.target.value)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && opts[0]) {
                e.preventDefault()
                add(opts[0].symbol)
              }
              if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1))
              if (e.key === 'Escape') setOpen(false)
            }} />
        </div>
        {open && (
          <div className="sg-pick-menu" role="listbox" aria-label="候选标的">
            {!kw ? <div className="sg-pick-empty">输入名称或代码搜索；现在只有 Binance、OKX 的数币能回测</div>
              : found.isPending ? <div className="sg-pick-empty">搜索中</div>
                : found.isError ? <div className="sg-pick-empty">标的没搜到：{errorText(found.error)}</div>
                  : opts.length ? opts.map((i) => (
                    <button key={i.symbol} type="button" role="option" aria-selected={false} className="sg-pick-opt" onMouseDown={(e) => { e.preventDefault(); add(i.symbol) }}>
                      <span className="ellipsis">{i.name}</span>
                      <span className="sg-mono faint ellipsis">{i.symbol}</span>
                      <span className="tag">{MARKETS[i.market].label} · {i.kind === 'spot' ? '现货' : KIND_SHORT[i.kind] ?? i.kind}</span>
                    </button>
                  )) : <div className="sg-pick-empty">没有匹配的标的</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function OperandEditor({ o, onChange, allowNum, label }: { o: TradeOperand; onChange: (o: TradeOperand) => void; allowNum?: boolean; label: string }) {
  const sel = o.kind === 'num' ? '__num' : o.ind
  return (
    <span className="sg-opnd">
      <select className="sg-select" value={sel} aria-label={label} onChange={(e) => {
        const v = e.target.value
        if (v === '__num') onChange({ kind: 'num', value: o.kind === 'num' ? o.value : 0 })
        else onChange({ kind: 'ind', ind: v as TradeIndicator, params: [...IND_DEFAULT[v as TradeIndicator]] })
      }}>
        {allowNum && <option value="__num">数值</option>}
        {(Object.keys(INDICATORS) as TradeIndicator[]).map((k) => <option key={k} value={k}>{INDICATORS[k].label}</option>)}
      </select>
      {o.kind === 'num' ? (
        <NumInput className="sg-numin sg-numin-wide" label={`${label}数值`} value={o.value} onChange={(value) => onChange({ kind: 'num', value })} />
      ) : INDICATORS[o.ind].params.map((p, i) => (
        <NumInput key={i} className="sg-numin" title={p} label={`${label}${p}`} placeholder={p} value={o.params[i] ?? IND_DEFAULT[o.ind][i]}
          onChange={(v) => {
            const ps = [...o.params]
            ps[i] = v
            onChange({ ...o, params: ps })
          }} />
      ))}
    </span>
  )
}

function GroupEditor({ title, hint, group, onChange }: { title: string; hint: string; group: TradeRuleGroup; onChange: (g: TradeRuleGroup) => void }) {
  const setRule = (id: string, r: TradeRule) => onChange({ ...group, rules: group.rules.map((x) => (x.id === id ? r : x)) })
  const addRule = () => onChange({ ...group, rules: [...group.rules, { id: newRuleId(), left: { kind: 'ind', ind: 'price', params: [] }, op: 'cross_up', right: { kind: 'ind', ind: 'ma', params: [20] } }] })
  return (
    <div className="sg-group" role="group" aria-label={title}>
      <div className="sg-sec-head">
        <span className="sg-group-title">{title}</span>
        <span className="sg-hint">{hint}</span>
        <span className="spacer" />
        {group.rules.length > 1 && (
          <div className="sg-seg sg-seg-sm" role="group" aria-label={`${title}的逻辑`}>
            <button type="button" className={cls(group.logic === 'all' && 'on')} aria-pressed={group.logic === 'all'} onClick={() => onChange({ ...group, logic: 'all' })}>全部满足</button>
            <button type="button" className={cls(group.logic === 'any' && 'on')} aria-pressed={group.logic === 'any'} onClick={() => onChange({ ...group, logic: 'any' })}>任一满足</button>
          </div>
        )}
      </div>
      {group.rules.length === 0 && <div className="sg-empty-box">还没有条件{title === '入场条件' ? '，不会开仓' : '，只靠止损止盈离场'}</div>}
      {group.rules.map((r, i) => (
        <div key={r.id} className="sg-rule">
          <span className="sg-rule-join">{i === 0 ? '当' : group.logic === 'all' ? '并且' : '或者'}</span>
          <OperandEditor label="左边" o={r.left} onChange={(left) => setRule(r.id, { ...r, left })} />
          <select className="sg-select sg-op" value={r.op} aria-label="比较" onChange={(e) => setRule(r.id, { ...r, op: e.target.value as TradeCompare })}>
            {(Object.keys(COMPARE) as TradeCompare[]).map((k) => <option key={k} value={k}>{COMPARE[k]}</option>)}
          </select>
          <OperandEditor label="右边" o={r.right} allowNum onChange={(right) => setRule(r.id, { ...r, right })} />
          <button type="button" className="icon-btn sg-rule-del" title="删除这条" aria-label="删除这条条件" onClick={() => onChange({ ...group, rules: group.rules.filter((x) => x.id !== r.id) })}><XIcon /></button>
        </div>
      ))}
      <div className="sg-act-row"><button type="button" className="sg-act sg-act-quiet" onClick={addRule}><PlusIcon />加一条条件</button></div>
    </div>
  )
}

export function CodeLines({ code }: { code: string }) {
  const lines = code.split('\n')
  return (
    <div className="sg-code sg-code-ro">
      <div className="sg-gutter">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
      <pre className="sg-code-pre">{code || ' '}</pre>
    </div>
  )
}

function CodeEditor({ st, set }: { st: TradeStrategy; set: (p: Partial<TradeStrategy>) => void }) {
  const gut = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const lines = st.code.split('\n').length
  const found = [...new Set([...st.code.matchAll(/params\.([A-Za-z_]\w*)/g)].map((m) => m[1]))]
  const missing = found.filter((k) => !(k in st.params))
  const kind = codeKindOf(st)
  return (
    <>
      <div className="sg-code">
        <div className="sg-gutter" ref={gut}>{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
        <textarea ref={ta} value={st.code} spellCheck={false} wrap="off" aria-label="策略代码" placeholder="# def on_bar(ctx, bar): ..."
          onScroll={(e) => { if (gut.current) gut.current.scrollTop = e.currentTarget.scrollTop }}
          onChange={(e) => set({ code: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Tab') return
            e.preventDefault()
            const el = e.currentTarget
            const a = el.selectionStart
            const b = el.selectionEnd
            set({ code: `${st.code.slice(0, a)}    ${st.code.slice(b)}` })
            requestAnimationFrame(() => { if (ta.current) ta.current.selectionStart = ta.current.selectionEnd = a + 4 })
          }} />
      </div>
      <div className="sg-code-foot">
        <span className="sg-muted">不执行源码，回测按「{CODE_KIND_LABEL[kind]}」内置近似模拟。代码里用 params.名字 引用右侧参数</span>
        <span className="spacer" />
        {missing.length > 0 && <button type="button" className="sg-act" onClick={() => set({ params: { ...st.params, ...Object.fromEntries(missing.map((k) => [k, 0])) } })}>从代码补全参数 {missing.length} 个</button>}
      </div>
    </>
  )
}

function ParamsTable({ st, setParams, setParam }: { st: TradeStrategy; setParams: (p: Record<string, number>) => void; setParam: (k: string, v: number) => void }) {
  const entries = Object.entries(st.params)
  const rename = (from: string, to: string) => {
    const k = to.trim()
    if (!k || k === from || k in st.params) return false
    setParams(Object.fromEntries(entries.map(([x, v]) => [x === from ? k : x, v])))
    return true
  }
  const add = () => {
    let n = entries.length + 1
    while (`p${n}` in st.params) n++
    setParams({ ...st.params, [`p${n}`]: 0 })
  }
  return (
    <section className="sg-sec" aria-label="可调参数">
      <div className="sg-sec-title">可调参数<span className="sg-hint">{st.mode === 'rules' ? '规则里的周期或数值等于某个参数值时跟着它走，回测时可以覆盖、扫参' : '回测时可以覆盖、扫参'}</span></div>
      {entries.length === 0 ? <div className="sg-empty-box">没有参数</div> : (
        <div className="sg-params">
          {entries.map(([k, v]) => (
            <div key={k} className="sg-param-row">
              <input className="sg-mono-input" defaultValue={k} title="参数名，失焦后生效" aria-label={`参数名 ${k}`}
                onBlur={(e) => { if (!rename(k, e.target.value)) e.target.value = k }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
              <NumInput className="sg-mono-input sg-num" label={`参数 ${k} 的值`} value={v} onChange={(x) => setParam(k, x)} />
              <button type="button" className="icon-btn" title="删除参数" aria-label={`删除参数 ${k}`} onClick={() => setParams(Object.fromEntries(entries.filter(([x]) => x !== k)))}><XIcon /></button>
            </div>
          ))}
        </div>
      )}
      <div className="sg-act-row"><button type="button" className="sg-act sg-act-quiet" onClick={add}><PlusIcon />添加参数</button></div>
    </section>
  )
}

function QuickPanel({ st, qc, setQc, blocker, busy, error, onRun }: {
  st: TradeStrategy; qc: QuickCfg; setQc: (q: QuickCfg) => void; blocker: string; busy: boolean; error: string; onRun: () => void
}) {
  const keys = Object.keys(st.params)
  const params = quickParams(st, qc)
  const overridden = keys.filter((k) => k in qc.over && qc.over[k] !== st.params[k])
  return (
    <section className="sg-sec" aria-label="快速回测">
      <div className="sg-sec-title">快速回测<span className="sg-hint">{st.symbols.length} 个标的 · {intervalLabel(st.interval)}</span></div>
      <div className="field">
        <span className="field-label">区间：最近 {qc.bars} 根<span className="sg-hint">{spanText(qc.bars, st.interval)}</span></span>
        <div className="sg-seg sg-seg-full" role="group" aria-label="区间">
          {[200, 500, 1000, 2000].map((n) => <button key={n} type="button" className={cls(qc.bars === n && 'on')} aria-pressed={qc.bars === n} onClick={() => setQc({ ...qc, bars: n })}>{n}</button>)}
        </div>
      </div>
      <div className="sg-field-row">
        <label className="field"><span className="field-label">初始资金<span className="sg-hint">{currencyOf(st.symbols)}</span></span><NumInput label="初始资金" min={1} value={qc.capital} onChange={(v) => setQc({ ...qc, capital: Math.max(1, v) })} /></label>
        <label className="field"><span className="field-label">K 线根数</span><NumInput label="K 线根数" min={50} value={qc.bars} onChange={(v) => setQc({ ...qc, bars: Math.max(50, Math.min(5000, Math.round(v))) })} /></label>
      </div>
      <div className="sg-field-row">
        <label className="field"><span className="field-label">手续费<span className="sg-hint">万分之</span></span><NumInput label="手续费" min={0} value={qc.fee_bp} onChange={(v) => setQc({ ...qc, fee_bp: Math.max(0, v) })} /></label>
        <label className="field"><span className="field-label">滑点<span className="sg-hint">跳</span></span><NumInput label="滑点" min={0} value={qc.slippage_ticks} onChange={(v) => setQc({ ...qc, slippage_ticks: Math.max(0, v) })} /></label>
      </div>
      {keys.length > 0 && (
        <div className="field">
          <span className="field-label">参数覆盖<span className="sg-hint">只影响这次回测，不改策略</span>
            {overridden.length > 0 && <button type="button" className="sg-link sg-reset" onClick={() => setQc({ ...qc, over: {} })}>恢复默认</button>}
          </span>
          <div className="sg-over">
            {keys.map((k) => (
              <label key={k} className={cls('sg-over-item', overridden.includes(k) && 'on')}>
                <span className="sg-mono ellipsis" title={k}>{k}</span>
                <NumInput className="sg-mono-input sg-num" label={`覆盖 ${k}`} value={params[k]} onChange={(v) => setQc({ ...qc, over: { ...qc.over, [k]: v } })} />
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="sg-act-row">
        <button type="button" className="sg-act sg-act-primary" disabled={!!blocker || busy} onClick={onRun}>开始回测</button>
        {blocker && <span className="sg-warn sg-small">{blocker}</span>}
      </div>
      {error && <div className="sg-alert" role="alert"><span>没发起成功：{error}</span></div>}
    </section>
  )
}

function LastPanel({ st, bt, now, onOpen }: { st: TradeStrategy; bt?: TradeBacktestBrief; now: number; onOpen: (id: string) => void }) {
  // 小资金曲线要完整结果，只给已完成的那一条取
  const full = useTradeBacktest(bt?.id ?? '', bt?.status === 'done')
  if (!bt) {
    return (
      <section className="sg-sec" aria-label="最近一次回测">
        <div className="sg-sec-title">最近一次回测</div>
        <div className="sg-empty-box">还没回测过，调好参数点「开始回测」</div>
      </section>
    )
  }
  const s = bt.stats
  const equity = full.data?.id === bt.id ? full.data.result?.equity : undefined
  return (
    <section className="sg-sec" aria-label="最近一次回测">
      <div className="sg-sec-head">
        <span className="sg-sec-title">最近一次回测</span>
        <span className="spacer" />
        <StatusCell b={bt} />
      </div>
      <div className="sg-muted">{bt.name} · {timeAgo(bt.created_at, now)}</div>
      {bt.status === 'failed' && <div className="sg-alert"><span>{bt.error || '回测失败'}</span></div>}
      {bt.status === 'queued' && <div className="sg-empty-box">排队中，前面的回测跑完就轮到它</div>}
      {s && bt.status === 'done' && (
        <>
          <div className="sg-mini">
            <div><span className="sg-stat-label">总收益</span><Signed x={s.total_return} /></div>
            <div><span className="sg-stat-label">最大回撤</span><span className="sg-num">{pctRaw(s.max_dd)}</span></div>
            <div><span className="sg-stat-label">夏普</span><span className="sg-num">{s.sharpe.toFixed(2)}</span></div>
            <div><span className="sg-stat-label">交易</span><span className="sg-num">{s.trades} 笔</span></div>
          </div>
          {equity && <Spark values={equity.map((e) => e.v)} color={tone(s.total_return) ?? 'var(--accent)'} />}
        </>
      )}
      {sig(bt.strategy_snapshot) !== sig(st) && <div className="field-hint-line">策略在这次回测之后改过，结果可能对不上</div>}
      <div className="sg-act-row"><button type="button" className="sg-act" onClick={() => onOpen(bt.id)}>查看报告</button></div>
    </section>
  )
}
