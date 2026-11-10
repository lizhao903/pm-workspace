// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 阶段看板（AUTO-05，SPEC-tasks-11）：任务按阶段分列，按提出人筛选；卡片显示阶段、提出人和状态。
// 阶段和状态是两套：状态是负责人的工作状态，阶段是提出人在看板上看到的流程进度（docs/auto-delivery-flow.md 第 3 节），
// 由自动交付流程推进，也可以在卡片上手动改。正式产品里阶段在 props.stage、提出人在 props.requester。
import { useMemo, useState } from 'react'
import { PageTitle } from './topbar'
import { isOpenTask, type Task, type TaskArtifact, type TaskRequester } from './taskdata'
import { Avatar, cls } from './ui'
import { SearchSelect } from './searchselect'
import { TaskStatusPill } from './tasks'
import { OUTPUTS_FILTERS, OutputsBadge, matchOutputs, summarize, type OutputsFilter } from './taskoutputs'
import './taskstage.css'
import { AiOwner } from './aiowner'

export const STAGES: readonly { key: string; label: string }[] = [
  { key: 'received', label: '已接收' },
  { key: 'confirm_project', label: '待确认项目' },
  { key: 'designing', label: '设计中' },
  { key: 'clarifying', label: '待澄清' },
  { key: 'reviewing', label: '评审中' },
  { key: 'need_human', label: '需人工' },
  { key: 'developing', label: '开发中' },
  { key: 'testing', label: '测试中' },
  { key: 'accepting', label: '待验收' },
  { key: 'releasing', label: '待发布' },
  { key: 'released', label: '已上线' },
]
/** 要人处理的阶段：列头和卡片标醒目色 */
const ATTENTION = new Set(['confirm_project', 'clarifying', 'need_human', 'accepting'])
const known = (s?: string) => !!s && STAGES.some((x) => x.key === s)
export const stageLabel = (s?: string) => (s ? STAGES.find((x) => x.key === s)?.label ?? s : '未设阶段')

/** 提出人筛选的值：联系人 c:<id>，认不上的发送者 s:<渠道>:<编号>，没有提出人 - */
const whoKey = (r?: TaskRequester) => (!r ? '-' : r.contact_id ? `c:${r.contact_id}` : r.channel && r.sender_id ? `s:${r.channel}:${r.sender_id}` : `n:${r.name}`)

export function StageBoard({ tasks, selected, onOpen, onStage, artifacts = [], onOpenOutputs }: {
  tasks: Task[]; selected: string | null; onOpen: (id: string) => void; onStage: (id: string, stage: string) => void
  /** 产出物（TSK-0497）：卡片上的产出标记、「产出」筛选；点标记打开抽屉的开发任务标签 */
  artifacts?: TaskArtifact[]; onOpenOutputs?: (id: string) => void
}) {
  const outputs = useMemo(() => summarize(artifacts), [artifacts])
  const [out, setOut] = useState<OutputsFilter>('')
  const [who, setWho] = useState('')
  const [withNone, setWithNone] = useState(false)
  // 只看 AI 负责的（TSK-0500，SPEC-tasks-11.17）
  const [ai, setAi] = useState(false)
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  // 没设阶段又已经结束的老任务不进看板：它们没走过流程，放进「未设阶段」只会把这一列撑满
  const base = tasks.filter((t) => (known(t.stage) || isOpenTask(t.status)) && (!who || whoKey(t.requester) === who) && matchOutputs(t.id, out, outputs) && (!ai || !!t.assignee_ai)
    && (!kw || [t.title, t.desc, t.ref, t.assignee].some((v) => v.toLowerCase().includes(kw))))
  const noneN = base.filter((t) => !known(t.stage)).length
  const cols = [
    ...(withNone ? [{ key: '', label: '未设阶段', rows: base.filter((t) => !known(t.stage)) }] : []),
    ...STAGES.map((s) => ({ ...s, rows: base.filter((t) => t.stage === s.key) })),
  ]
  const shown = cols.reduce((n, c) => n + c.rows.length, 0)
  const opts = new Map<string, { value: string; label: string; n: number }>()
  for (const t of tasks) {
    if (!t.requester) continue
    const k = whoKey(t.requester)
    const o = opts.get(k) ?? { value: k, label: t.requester.contact_id || !t.requester.channel ? t.requester.name : `${t.requester.name}（${t.requester.channel}）`, n: 0 }
    o.n += 1
    opts.set(k, o)
  }

  const card = (t: Task) => (
    <div key={t.id} className={cls('stage-card', selected === t.id && 'sel', ATTENTION.has(t.stage ?? '') && 'attn')} onClick={() => onOpen(t.id)}>
      <span className="stage-card-title"><span className="task-ref">{t.ref}</span><span className="clamp2">{t.title}</span></span>
      <span className="stage-card-who" title={t.requester?.channel && !t.requester.contact_id ? `${t.requester.name}（${t.requester.channel}，还没认到联系人）` : t.requester?.name}>
        {t.requester ? <><Avatar name={t.requester.name} size={18} /><span className="ellipsis">{t.requester.name}</span></> : <span className="run-muted">没有提出人</span>}
      </span>
      {t.assignee_ai && <AiOwner name={t.assignee} kind={t.assignee_ai} className="stage-card-ai" />}
      <OutputsBadge s={outputs.get(t.id)} onOpen={() => (onOpenOutputs ?? onOpen)(t.id)} />
      <span className="stage-card-foot">
        <TaskStatusPill s={t.status} />
        <span className="chip chip-select stage-pick" onClick={(e) => e.stopPropagation()}>
          <select value={known(t.stage) ? t.stage : ''} title="改阶段" onChange={(e) => onStage(t.id, e.target.value)}>
            <option value="">未设阶段</option>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </span>
      </span>
    </div>
  )

  return (
    <div className="page page-fill">
      <PageTitle parent="任务" count={shown} desc="按阶段分列，看每个人提的事走到了哪一步；阶段由自动交付流程推进，也可以在卡片上手动改">阶段看板</PageTitle>
      <div className="toolbar">
        <SearchSelect value={who} onChange={setWho} noneLabel="全部提出人" placeholder="全部提出人" searchPlaceholder="搜提出人"
          options={[...[...opts.values()].sort((a, b) => b.n - a.n).map((o) => ({ value: o.value, label: o.label, hint: String(o.n) })), { value: '-', label: '没有提出人' }]}
          missingLabel={() => '没有这位提出人的任务'} />
        <div className="chip chip-select">
          <select value={out} onChange={(e) => setOut(e.target.value as OutputsFilter)}>
            {OUTPUTS_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <label className="check"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />AI 负责的</label>
        <label className="check"><input type="checkbox" checked={withNone} onChange={(e) => setWithNone(e.target.checked)} />显示未设阶段（{noneN}）</label>
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索标题、编号、负责人" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {tasks.length === 0 ? (
        <div className="empty"><div className="empty-title">这里还没有任务</div><div className="list-sub">IM 消息转来的任务会从「已接收」开始往右走</div></div>
      ) : base.length === 0 ? (
        <div className="empty"><div className="empty-title">没有匹配的任务</div>
          <button className="btn btn-ghost" onClick={() => { setWho(''); setQ(''); setAi(false) }}>清掉筛选条件</button></div>
      ) : shown === 0 ? (
        <div className="empty"><div className="empty-title">还没有任务进入流程</div><div className="list-sub">这 {noneN} 条任务都没设阶段</div>
          <button className="btn btn-ghost" onClick={() => setWithNone(true)}>显示未设阶段的任务</button></div>
      ) : (
        <div className="stage-board">
          {cols.map((c) => (
            <section key={c.key || 'none'} className={cls('stage-col', ATTENTION.has(c.key) && 'attn', !c.key && 'none')}>
              <header className="stage-col-head"><span>{c.label}</span><span className="seg-n">{c.rows.length}</span></header>
              <div className="stage-col-body">{c.rows.length ? c.rows.map(card) : <span className="stage-col-empty">没有</span>}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
