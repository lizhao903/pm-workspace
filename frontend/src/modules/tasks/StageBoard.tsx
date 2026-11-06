// 阶段看板（AUTO-05，SPEC-tasks-11）：任务按阶段（props.stage）分列，可按提出人筛选；卡片显示阶段、提出人和状态。
// 只管展示和本地筛选，数据由 Page 从接口层取好传进来；改阶段走 PUT /api/objects/{id}/stage（useSetStage）。
import { useState } from 'react'
import { useSetStage, type ArtifactObjectSummary, type ObjectStatus, type WorkObject } from '../../core/data'
import {
  Avatar, Button, Checkbox, EmptyState, ErrorState, IconClose, IconSearch, LoadingState, PageTitle, Pill, SearchSelect, cls,
} from '../../core/ui'
import { matchQuery } from './model'
import {
  ATTENTION_STAGES, NO_REQUESTER, NO_STAGE, STAGES, matchRequester, requesterOf, requesterOptions, stageColumns, stageOf,
} from './stageModel'
import { OutputsBadge } from './OutputsBadge'
import { OUTPUTS_FILTERS, matchOutputs, type KindInfo, type OutputsFilter } from './outputSummary'
import './stageboard.css'

export function StageBoard({
  tasks, loading, error, onRetry, statuses, selected, onOpen, search, onSearch, q, outputs, kinds = [], onOpenOutputs,
}: {
  tasks: WorkObject[]
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  statuses: ObjectStatus[]
  selected: string | null
  onOpen: (t: WorkObject) => void
  search: string
  onSearch: (v: string) => void
  /** 防抖后的搜索词 */
  q: string
  /** 每条任务的产出汇总（TSK-0497）；undefined 是还没取到 */
  outputs?: ReadonlyMap<string, ArtifactObjectSummary>
  kinds?: readonly KindInfo[]
  /** 点卡片上的产出标记：打开抽屉的产出物面板 */
  onOpenOutputs?: (t: WorkObject) => void
}) {
  const [who, setWho] = useState('')
  const [withNone, setWithNone] = useState(false)
  const [out, setOut] = useState<OutputsFilter>('')
  const setStage = useSetStage()

  const terminal = (k: string) => !!statuses.find((s) => s.key === k)?.terminal
  // 没设阶段又已经结束（已完成、已取消）的老任务不进看板：它们没走过流程，放进「未设阶段」只会把这一列撑满
  const base = tasks.filter((t) => matchRequester(t, who) && matchQuery(t, q) && matchOutputs(t.id, out, outputs) && (STAGES.some((s) => s.key === stageOf(t)) || !terminal(t.status)))
  const noneN = base.filter((t) => !STAGES.some((s) => s.key === stageOf(t))).length
  const cols = stageColumns(base, withNone)
  const shown = cols.reduce((n, c) => n + c.rows.length, 0)
  const statusOf = (k: string) => statuses.find((s) => s.key === k)
  const showCounts = !loading && !error

  const card = (t: WorkObject) => {
    const r = requesterOf(t)
    const st = statusOf(t.status)
    const cur = stageOf(t)
    return (
      <div key={t.id} role="button" tabIndex={0} aria-label={`${t.ref} ${t.title}`}
        className={cls('stage-card', selected === t.id && 'sel', ATTENTION_STAGES.has(cur) && 'attn')}
        onClick={() => onOpen(t)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(t) } }}>
        <span className="stage-card-title"><span className="task-ref">{t.ref}</span><span className="clamp2">{t.title}</span></span>
        <span className="stage-card-who" title={r?.channel && !r.contact_id ? `${r.name}（${r.channel}，还没认到联系人）` : r?.name}>
          {r ? <><Avatar name={r.name} size={18} /><span className="ellipsis">{r.name}</span></> : <span className="run-muted">没有提出人</span>}
        </span>
        <OutputsBadge summary={outputs?.get(t.id)} kinds={kinds} className="stage-card-out"
          onOpen={onOpenOutputs ? () => onOpenOutputs(t) : undefined} />
        <span className="stage-card-foot">
          <Pill label={st?.label ?? t.status} color={st?.color} />
          {/* 改阶段：点下拉不打开抽屉 */}
          <span className="chip chip-select stage-pick" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <select value={STAGES.some((s) => s.key === cur) ? cur : NO_STAGE} aria-label={`改阶段：${t.ref}`}
              disabled={setStage.isPending && setStage.variables?.id === t.id}
              onChange={(e) => setStage.mutate({ id: t.id, stage: e.target.value })}>
              <option value={NO_STAGE}>未设阶段</option>
              {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </span>
        </span>
        {setStage.isError && setStage.variables?.id === t.id && <span className="danger-text stage-card-err">改阶段失败：{setStage.error.message}</span>}
      </div>
    )
  }

  let body
  if (error) body = <ErrorState error={error} onRetry={onRetry} />
  else if (loading) body = <LoadingState />
  else if (tasks.length === 0) body = <EmptyState title="这里还没有任务" desc="IM 消息转来的任务会从「已接收」开始往右走" />
  else if (base.length === 0) {
    body = <EmptyState title="没有匹配的任务" action={<Button variant="outline" onClick={() => { setWho(''); setOut(''); onSearch('') }}>清掉筛选条件</Button>} />
  } else if (shown === 0) {
    body = (
      <EmptyState title="还没有任务进入流程" desc={`这 ${noneN} 条任务都没设阶段`}
        action={<Button variant="outline" onClick={() => setWithNone(true)}>显示未设阶段的任务</Button>} />
    )
  } else {
    body = (
      <div className="stage-board" role="list" aria-label="阶段看板">
        {cols.map((c) => (
          <section key={c.stage.key || 'none'} role="listitem" aria-label={`${c.stage.label} ${c.rows.length} 条`}
            className={cls('stage-col', ATTENTION_STAGES.has(c.stage.key) && 'attn', c.stage.key === NO_STAGE && 'none')}>
            <header className="stage-col-head"><span>{c.stage.label}</span><span className="seg-n">{c.rows.length}</span></header>
            <div className="stage-col-body">
              {c.rows.length ? c.rows.map(card) : <span className="stage-col-empty">没有</span>}
            </div>
          </section>
        ))}
      </div>
    )
  }

  const opts = requesterOptions(tasks)
  return (
    <div className="tasks-page">
      <PageTitle parent="任务" count={showCounts ? shown : undefined} desc="按阶段分列，看每个人提的事走到了哪一步；阶段由自动交付流程推进，也可以在卡片上手动改">
        阶段看板
      </PageTitle>
      <div className="toolbar">
        <SearchSelect value={who} onChange={setWho} noneLabel="全部提出人" placeholder="全部提出人" searchPlaceholder="搜提出人"
          aria-label="提出人"
          options={[...opts.map((o) => ({ value: o.value, label: o.label, hint: String(o.n) })), { value: NO_REQUESTER, label: '没有提出人' }]}
          missingLabel={() => '没有这位提出人的任务'} />
        <div className={cls('chip chip-select', out && 'chip-on')}>
          <select value={out} aria-label="产出" disabled={!outputs} onChange={(e) => setOut(e.target.value as OutputsFilter)}>
            {OUTPUTS_FILTERS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        <Checkbox checked={withNone} onCheckedChange={setWithNone}>
          显示未设阶段{showCounts ? `（${noneN}）` : ''}
        </Checkbox>
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input type="search" placeholder="搜索标题、描述、编号、负责人" aria-label="搜索任务" value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); onSearch('') } }} />
          {search && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => onSearch('')}><IconClose size={10} /></button>}
        </div>
      </div>
      {body}
    </div>
  )
}
