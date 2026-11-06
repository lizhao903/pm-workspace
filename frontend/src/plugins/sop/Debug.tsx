// 调试（TSK-0491，SPEC-sop-17）：真实取数把流程走一遍，写操作不执行只显示将做什么，不建执行、不改数据。
// 编排页顶上「调试」打开调试条：IM 触发的流程按会话列最近 N 条真实消息（可勾几条逐条调试），别的触发方式填输入；
// 结果留在编排页（到下次调试或离开），画布节点角标、节点面板「调试」页、字段候选都读它。
// 流程详情：「模拟 IM 触发」看一条消息会让哪些 IM 流程发起、哪些为什么不发起；「最近未发起」列自动触发没发起的原因。
import { useMemo, useState } from 'react'
import {
  errorText, useConversations, useImRecentMessages, useSopDebug, useSopIMExplain, useSopSkips,
  type ImMessage, type SopDebug, type SopDebugStatus, type SopDebugStep, type SopDraft, type SopIMExplain, type SopIMVerdict, type SopSkipReason,
} from '../../core/data'
import { Button, Checkbox, IconButton, IconClose, Input, Pill, Select, cls } from '../../core/ui'
import { timeAgo } from './model'
import { DataView } from './RunView'

type Look = { label: string; color: string }

export const DEBUG_LOOK: Record<SopDebugStatus, Look> = {
  done: { label: '真实执行', color: 'var(--ok)' },
  simulated: { label: '模拟', color: 'var(--accent)' },
  skipped_model: { label: '跳过调模型', color: 'var(--muted)' },
  failed: { label: '失败', color: 'var(--danger)' },
  bypassed: { label: '分支没走', color: 'var(--faint)' },
  not_reached: { label: '没走到', color: 'var(--faint)' },
}

export const EFFECT_LABEL: Record<string, string> = {
  compute: '只按输入算', read: '只读取数', model: '调模型', write: '写操作', wait: '等外部事件', human: '等人',
}

/** 一次调试：哪条消息（手填输入时为空）和结果或错误 */
export type DebugRun = { key: string; label: string; res?: SopDebug; error?: string }

const LIMITS = [5, 10, 20]
const short = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const showVal = (v: unknown) => (v === undefined || v === null ? '取不到（空）' : typeof v === 'string' ? (v === '' ? '（空串）' : v) : JSON.stringify(v))

/** 选消息：按会话列最近 N 条，可勾几条；也可以直接填消息 id */
export function MessagePicker({ multi, picked, onPick }: { multi: boolean; picked: string[]; onPick: (ids: string[]) => void }) {
  const convs = useConversations().data ?? []
  const [conv, setConv] = useState('')
  const [limit, setLimit] = useState(10)
  const [manual, setManual] = useState('')
  const recent = useImRecentMessages(conv, limit)
  const list: ImMessage[] = recent.data ?? []
  const toggle = (id: string) => onPick(multi ? (picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) : [id])
  return (
    <div className="sop-dbg-picker">
      <div className="sop-dbg-row">
        <Select aria-label="会话" value={conv} onValueChange={setConv}
          options={[{ value: '', label: '选会话，列出最近的消息' }, ...convs.map((c) => ({ value: c.id, label: `${c.name || c.external_id}（${c.channel}）` }))]} />
        <Select aria-label="最近几条" value={String(limit)} onValueChange={(v) => setLimit(Number(v))}
          options={LIMITS.map((n) => ({ value: String(n), label: `最近 ${n} 条` }))} />
      </div>
      {conv && (recent.isPending ? <div className="sop-muted">加载中</div> : !list.length ? <div className="sop-muted">这个会话还没有消息</div> : (
        <div className="sop-dbg-msgs" role="list" aria-label="最近的消息">
          {multi && <button type="button" className="sop-dbg-all" onClick={() => onPick(picked.length === list.length ? [] : list.map((m) => m.id))}>
            {picked.length === list.length ? '全不选' : '全选'}</button>}
          {list.map((m) => (
            <label key={m.id} role="listitem" className={cls('sop-dbg-msg', picked.includes(m.id) && 'on')}>
              <input type={multi ? 'checkbox' : 'radio'} name="sop-dbg-msg" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
              <span className="sop-dbg-msg-who">{m.contact_name || m.sender_name || m.sender_id}</span>
              <span className="sop-dbg-msg-text ellipsis">{short(m.text, 80) || '（没有正文）'}</span>
              <span className="sop-muted">{timeAgo(m.at)}{m.status !== 'pending' ? ` · ${m.status === 'ignored' ? '已忽略' : m.status === 'done' ? '已处理' : m.status}` : ''}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="sop-dbg-row">
        <Input value={manual} placeholder="或直接填消息 id（msg_…）" aria-label="消息 id" onChange={(e) => setManual(e.target.value)} />
        <Button size="sm" disabled={!manual.trim()} onClick={() => { onPick(multi ? [...new Set([...picked, manual.trim()])] : [manual.trim()]); setManual('') }}>加上</Button>
      </div>
      {picked.length > 0 && <div className="sop-muted">已选 {picked.length} 条{picked.some((id) => !list.some((m) => m.id === id)) ? `：${picked.filter((id) => !list.some((m) => m.id === id)).join('、')}` : ''}</div>}
    </div>
  )
}

/** 编排页的调试条：选输入、跑、结果切换和结论 */
export function DebugBar({ draft, flowId, runs, active, onRuns, onActive, onClose }: {
  draft: SopDraft
  flowId?: string
  runs: DebugRun[]
  active: number
  onRuns: (r: DebugRun[]) => void
  onActive: (i: number) => void
  onClose: () => void
}) {
  const im = draft.trigger === 'im'
  const [picked, setPicked] = useState<string[]>([])
  const [input, setInput] = useState<Record<string, string>>({})
  const [skipModels, setSkipModels] = useState(false)
  const [busy, setBusy] = useState(false)
  const dbg = useSopDebug()
  const run = async () => {
    setBusy(true)
    const body = { flow_id: flowId, draft: { ...draft, id: draft.id ?? flowId }, skip_models: skipModels }
    const filled = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== ''))
    const jobs: { key: string; label: string; message_id?: string }[] = im && picked.length
      ? picked.map((id) => ({ key: id, label: id, message_id: id }))
      : [{ key: 'input', label: im ? '最近一条消息' : '手填输入' }]
    const out: DebugRun[] = []
    for (const j of jobs) {
      try {
        const res = await dbg.mutateAsync({ ...body, message_id: j.message_id, input: Object.keys(filled).length ? filled : undefined })
        out.push({ key: j.key, label: res.message ? short(res.message.text, 16) || j.label : j.label, res })
      } catch (e) {
        out.push({ key: j.key, label: j.label, error: errorText(e) })
      }
      onRuns([...out])
    }
    onActive(0)
    setBusy(false)
  }
  const cur = runs[active]
  return (
    <div className="sop-cv-ui sop-dbg-bar" role="region" aria-label="调试">
      <div className="sop-dbg-head">
        <b>调试</b>
        <span className="sop-muted">真实取数；写操作不执行，只显示将做什么；不建执行记录、不改数据</span>
        <span className="spacer" />
        <IconButton label="收起调试" size="sm" onClick={onClose}><IconClose /></IconButton>
      </div>
      {im ? <MessagePicker multi picked={picked} onPick={setPicked} /> : draft.fields.length > 0 && (
        <div className="sop-dbg-inputs">
          {draft.fields.map((f) => (
            <label key={f.key} className="sop-dbg-row">
              <span className="sop-dbg-label">{f.label || f.key}</span>
              <Input value={input[f.key] ?? ''} placeholder={f.default ? `默认 ${f.default}` : ''} onChange={(e) => setInput({ ...input, [f.key]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <div className="sop-dbg-row">
        <Checkbox checked={skipModels} onCheckedChange={setSkipModels}>跳过调模型（用占位输出）</Checkbox>
        <span className="spacer" />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? '调试中' : im && picked.length > 1 ? `逐条调试 ${picked.length} 条` : '开始调试'}
        </Button>
      </div>
      {im && !picked.length && <div className="sop-muted">没选消息时用这条流程最近一次执行（或最近一次没发起）的那条消息</div>}
      {runs.length > 1 && (
        <div className="sop-dbg-tabs" role="tablist" aria-label="调试结果">
          {runs.map((r, i) => (
            <button key={r.key + i} type="button" role="tab" aria-selected={i === active} className={cls('sop-chip', i === active && 'on')} onClick={() => onActive(i)}>
              <span className={cls('sop-dbg-dot', r.error ? 'failed' : r.res?.status)} />{r.label}
            </button>
          ))}
        </div>
      )}
      {cur && (cur.error ? <div className="field-err" role="alert">调试没跑起来：{cur.error}</div> : cur.res && <DebugSummary res={cur.res} />)}
    </div>
  )
}

function DebugSummary({ res }: { res: SopDebug }) {
  const msg = res.message
  return (
    <div className="sop-dbg-summary" role="status">
      {msg && (
        <div className="sop-dbg-message">
          <span className="sop-muted">消息 {res.message_id}{res.source === 'latest_run' ? '（最近一次执行的）' : res.source === 'latest_skip' ? '（最近一次没发起的）' : ''}</span>
          <span><b>{String(msg.sender ?? '')}</b>{msg.conversation ? ` · ${String(msg.conversation)}` : ''}{msg.relevance ? ` · ${String(msg.relevance)}` : ''}</span>
          <span className="sop-dbg-message-text">{String(msg.text ?? '') || '（没有正文）'}</span>
        </div>
      )}
      {res.input_error && <div className="sop-dbg-warn">{res.input_error}</div>}
      <div>{res.summary}</div>
      {res.notes.map((n, i) => <div key={i} className="sop-muted">{n}</div>)}
    </div>
  )
}

/** 画布节点上的调试角标：状态，分支走向，模拟的写操作 */
export function DebugBadge({ s }: { s: SopDebugStep }) {
  const look = DEBUG_LOOK[s.status]
  const line = s.error ? s.error : s.route_label ? `走「${s.route_label}」` : s.action ? s.action.text : ''
  return (
    <div className={cls('sop-cv-dbg', `dbg-${s.status}`)} title={[look.label, line, s.note].filter(Boolean).join('\n')}>
      <span className="sop-dbg-dot" style={{ background: look.color }} />{look.label}
      {line && <span className="ellipsis">{line}</span>}
    </div>
  )
}

/** 节点面板「调试」页：真实输入输出、条件逐条、将做什么、字段（含未声明） */
export function DebugStepView({ s, res }: { s: SopDebugStep; res: SopDebug }) {
  const look = DEBUG_LOOK[s.status]
  return (
    <div className="sop-np-body sop-dbg-step">
      <div className="sop-np-last-head">
        <Pill label={look.label} color={look.color} />
        <span className="sop-muted">{EFFECT_LABEL[s.effect] ?? s.effect}{s.ms ? ` · ${s.ms} ms` : ''}</span>
      </div>
      {s.note && <div className="sop-muted">{s.note}</div>}
      {s.error && <div className="field-err" role="alert">{s.error}</div>}
      {s.route_label && <div className="sop-insp-route">走「{s.route_label}」分支{s.route_reason ? `：${s.route_reason}` : ''}</div>}
      {s.cond && (
        <>
          <div className="sop-section-label">条件（{s.cond.logic === 'or' ? '满足任一条' : '全部满足'}）· 整体{s.cond.result ? '成立' : '不成立'}</div>
          <table className="sop-dbg-cond">
            <thead><tr><th>字段</th><th>条件</th><th>真实值</th><th>结果</th></tr></thead>
            <tbody>
              {s.cond.items.map((it, i) => (
                <tr key={i} className={it.ok ? 'ok' : 'no'}>
                  <td><code>{it.field}</code></td>
                  <td>{it.op_label}{['empty', 'not_empty'].includes(it.op) ? '' : ` ${it.value}`}</td>
                  <td className={cls(!it.found && 'faint')}>{short(showVal(it.actual), 80)}</td>
                  <td>{it.ok ? '成立' : '不成立'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {s.action && (
        <>
          <div className="sop-section-label">将做什么（没执行）</div>
          <div className="sop-dbg-action">{s.action.text}</div>
          {s.action.params.length > 0 && (
            <dl className="sop-io-fields">
              {s.action.params.map((p) => <div key={p.key} className="sop-io-field"><dt>{p.label}</dt><dd><span className="sop-io-text">{p.value}</span></dd></div>)}
            </dl>
          )}
        </>
      )}
      {s.fields.length > 0 && (
        <>
          <div className="sop-section-label">这一步返回的字段</div>
          <div className="sop-fields-groups">
            {s.fields.map((f) => (
              <div key={f.path} className={cls('sop-field-pick', !f.declared && 'undeclared')} title={f.label}>
                <code>{f.path}</code>
                {!f.declared && <span className="sop-field-undecl">未声明</span>}
                <span className="sop-field-desc ellipsis">{f.declared ? f.label : ''}</span>
                <span className="sop-field-sample ellipsis">{f.sample === undefined ? '没取到' : short(showVal(f.sample), 80)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="sop-section-label">输入</div>
      <div className="sop-insp-body">{s.input ? <DataView data={s.input} /> : <div className="sop-io-empty">没走到</div>}</div>
      <div className="sop-section-label">输出{s.status === 'simulated' || s.status === 'skipped_model' ? '（占位值，没真执行）' : ''}</div>
      <div className="sop-insp-body">{s.output ? <DataView data={s.output} /> : <div className="sop-io-empty">{s.error || '没有输出'}</div>}</div>
      {s.log && <div className="sop-muted">日志：{s.log}</div>}
      <div className="sop-muted">调试 {res.id} · {timeAgo(res.started_at)}</div>
    </div>
  )
}

/** 开始节点的调试页：这次的输入从哪来、补不齐的必填 */
export function DebugStartView({ res }: { res: SopDebug }) {
  return (
    <div className="sop-np-body sop-dbg-step">
      <DebugSummary res={res} />
      <div className="sop-section-label">交给第一步的输入</div>
      <div className="sop-insp-body"><DataView data={res.input} /></div>
    </div>
  )
}

/* ---------- 流程详情：模拟 IM 触发、最近未发起 ---------- */

const VERDICT_LOOK: Record<SopIMVerdict, Look> = {
  start: { label: '会发起', color: 'var(--ok)' },
  already: { label: '已发起过', color: 'var(--ok)' },
  filtered: { label: '过滤不符', color: 'var(--faint)' },
  missing: { label: '必填补不齐', color: 'var(--danger)' },
  stopped: { label: '被拦截', color: 'var(--warn)' },
  muted: { label: '收不到', color: 'var(--faint)' },
}

/** 模拟 IM 触发：选一条消息，看每条 IM 流程的判定。不真发起 */
export function IMExplainPanel({ flowId, initial, onClose }: { flowId?: string; initial?: string; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(initial ? [initial] : [])
  const m = useSopIMExplain()
  const [res, setRes] = useState<SopIMExplain | null>(null)
  const go = (id: string) => m.mutate({ message_id: id }, { onSuccess: setRes })
  return (
    <div className="sop-explain" role="region" aria-label="模拟 IM 触发">
      <div className="sop-dbg-head">
        <b>模拟 IM 触发</b>
        <span className="sop-muted">按真实口径判每条 IM 流程，不真发起、不改数据</span>
        <span className="spacer" />
        <IconButton label="关闭" size="sm" onClick={onClose}><IconClose /></IconButton>
      </div>
      <MessagePicker multi={false} picked={picked} onPick={setPicked} />
      <div className="sop-dbg-row">
        <span className="spacer" />
        <Button variant="primary" size="sm" disabled={!picked.length || m.isPending} onClick={() => go(picked[0])}>{m.isPending ? '判定中' : '模拟'}</Button>
      </div>
      {m.isError && <div className="field-err" role="alert">没模拟成：{errorText(m.error)}</div>}
      {res && (
        <div className="sop-explain-res">
          {res.message && (
            <div className="sop-dbg-message">
              <span><b>{String(res.message.sender ?? '')}</b>{res.message.conversation ? ` · ${String(res.message.conversation)}` : ''} · {String(res.message.relevance || '无关')}</span>
              <span className="sop-dbg-message-text">{String(res.message.text ?? '') || '（没有正文）'}</span>
            </div>
          )}
          <div className="sop-dbg-summary">{res.summary}</div>
          {res.notes.map((n, i) => <div key={i} className="sop-muted">{n}</div>)}
          <div className="sop-explain-flows" role="list">
            {res.flows.map((f) => {
              const look = VERDICT_LOOK[f.verdict]
              return (
                <div key={f.flow_id || f.name} role="listitem" className={cls('sop-explain-flow', f.flow_id === flowId && 'me')}>
                  <span className="sop-im-order">第 {f.order} 个</span>
                  <span className="sop-explain-name ellipsis">{f.name}{f.stop ? '（拦截后续）' : ''}</span>
                  <Pill label={look.label} color={look.color} />
                  <span className="sop-explain-reason">{f.reason}</span>
                  {f.checks.length > 0 && (
                    <span className="sop-explain-checks">
                      {f.checks.map((c) => <span key={c.key} className={c.ok ? 'ok' : 'no'}>{c.ok ? '符合' : '不符'}：{c.text}</span>)}
                    </span>
                  )}
                </div>
              )
            })}
            {!res.flows.length && <div className="sop-muted">现在没有触发方式是 IM 消息的流程</div>}
          </div>
        </div>
      )}
    </div>
  )
}

const REASON_LABEL: Record<SopSkipReason, string> = {
  filtered: '过滤不符', stopped: '被拦截', muted: '发信人被自动忽略', missing: '必填补不齐', start_failed: '发起出错',
}

/** 最近未发起：自动触发没发起的记录。默认不看「过滤不符」（多，且多半是预期的） */
export function SkipList({ flowId, onExplain }: { flowId: string; onExplain?: (messageId: string) => void }) {
  const [filter, setFilter] = useState('-filtered')
  const q = useSopSkips(flowId, filter)
  const reasons = q.data?.reasons ?? {}
  const total = useMemo(() => Object.values(reasons).reduce((n, x) => n + (x ?? 0), 0), [reasons])
  const opts = [
    { value: '-filtered', label: `过滤不符以外（${total - (reasons.filtered ?? 0)}）` },
    { value: '', label: `全部（${total}）` },
    ...(Object.keys(REASON_LABEL) as SopSkipReason[]).map((k) => ({ value: k, label: `${REASON_LABEL[k]}（${reasons[k] ?? 0}）` })),
  ]
  return (
    <div className="sop-skips">
      <div className="sop-dbg-row">
        <Select aria-label="按原因筛" value={filter} onValueChange={setFilter} options={opts} />
        <span className="sop-muted">保留 7 天；每条流程「过滤不符」最多 100 条、其余最多 200 条</span>
      </div>
      {q.isPending ? <div className="sop-muted">加载中</div> : q.isError ? <div className="sop-muted">没取到：{errorText(q.error)}</div>
        : !q.data?.items.length ? <div className="sop-io-empty">没有记录</div> : (
          <div className="sop-skip-list" role="list">
            {q.data.items.map((s) => (
              <div key={s.id} role="listitem" className="sop-skip-row">
                <span className="sop-muted">{timeAgo(s.at)}</span>
                <span className={cls('sop-skip-reason', `r-${s.reason}`)}>{REASON_LABEL[s.reason] ?? s.reason}</span>
                <span className="sop-skip-detail">{s.detail}</span>
                <span className="sop-muted mono">{s.source === 'schedule' ? '定时' : s.source_ref}</span>
                {s.source === 'im' && s.source_ref && onExplain && <Button size="sm" onClick={() => onExplain(s.source_ref)}>模拟</Button>}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
