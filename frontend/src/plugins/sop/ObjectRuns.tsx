// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情里的「SOP 执行」（SOP-06，SPEC-sop-13）：经 core/plugin 的对象区块登记，任务模块只负责摆。
// 列出关联到这条任务的执行（在这里发起的、Agent 处理这条任务时发起的），每行写来源（手动、Agent：名字…），子流程收在父执行里不单列；
// 「执行 SOP」选流程后打开发起执行抽屉，按开始节点的输入字段从任务预填，发起后关联到这条任务、留在任务详情。
// 点一行去 SOP 运行页（同一个 RunView），「返回」回到 returnTo（任务页带 ?t= 重新打开这条任务），并带上 ?tab=sop&sop_run=<id> 回到 SOP 标签、定位刚才那次。
// 宿主按 focus（地址上的 sop_run）传进来要定位的执行：那一行高亮并滚到可见处
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  errorText, sopRunShow, useEventsLive, useObjectTypes, useSopFlows, useSopObjectRuns, type SopFlow, type SopRunBrief,
} from '../../core/data'
import type { ObjectSectionProps } from '../../core/plugin'
import { ErrorState, LoadingState, SearchSelect, cls } from '../../core/ui'
import { isEnded, timeAgo } from './model'
import { RunPill } from './parts'
import { StartDrawer } from './StartDrawer'
import { useSourceText } from './source'
import { backToRun, focusRow, objectRunProgress, taskPrefill, topRuns } from './taskModel'
import './sop.css'

const SOP_PATH = '/sop'
/** 事件流断开时轮询；有没结束的执行时快一些 */
const POLL_MS = 30_000
const ACTIVE_POLL_MS = 5_000

export default function ObjectRuns({ object, returnTo, focus }: ObjectSectionProps) {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const live = useEventsLive()
  const flows = useSopFlows()
  // 事件流断开时轮询，有没结束的执行时快一些
  const runs = useSopObjectRuns(object.id, {
    refetchInterval: (q) => (live ? false : q.state.data?.some((r) => !isEnded(r)) ? ACTIVE_POLL_MS : POLL_MS),
  })
  const types = useObjectTypes()
  const [start, setStart] = useState<SopFlow | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const rows = useMemo(() => topRuns(runs.data ?? []), [runs.data])
  const lit = focusRow(runs.data ?? [], rows, focus)
  // 定位的那一行出现后滚过去一次
  const listRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!lit || scrolled.current === lit) return
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-run]') ?? []).find((x) => x.dataset.run === lit)
    if (!el) return
    scrolled.current = lit
    el.scrollIntoView?.({ block: 'center' })
  }, [lit])
  const sourceOf = useSourceText()

  const statusLabel = (k: string) => types.data?.find((t) => t.id === object.type_id)?.statuses.find((s) => s.key === k)?.label
  const openRun = (id: string) => navigate(`${SOP_PATH}/runs/${encodeURIComponent(id)}`, { state: { back: backToRun(returnTo ?? pathname + search, id) } })
  const flowList = flows.data ?? []

  return (
    <section className="sop-obj" aria-label="SOP 执行" data-section="sop-runs">
      <div className="sop-obj-head">
        <span className="sop-obj-title">SOP 执行</span>
        <span className="sop-obj-hint">在这里发起的、Agent 处理这条任务时发起的</span>
        <span className="spacer" />
        <SearchSelect value="" placeholder="执行 SOP" searchPlaceholder="搜流程名" align="end" active={false} aria-label="执行 SOP"
          disabled={!flows.data} emptyText="还没有标准流程，先去 SOP 流程库新建"
          options={flowList.map((f) => ({ value: f.id, label: f.name, keywords: f.desc, hint: `${f.steps.length} 步` }))}
          onChange={(id) => { const f = flowList.find((x) => x.id === id); if (f) setStart(f) }} />
      </div>
      {flows.isError && <ErrorState compact error={`流程没加载出来：${errorText(flows.error)}`} onRetry={() => void flows.refetch()} />}
      {runs.isPending && <LoadingState />}
      {runs.isError && <ErrorState compact error={`SOP 执行没加载出来：${errorText(runs.error)}`} onRetry={() => void runs.refetch()} />}
      {runs.isSuccess && !rows.length && <div className="sop-obj-empty">还没有执行过 SOP</div>}
      {rows.length > 0 && (
        <div className="sop-obj-list" ref={listRef}>
          {rows.map((r) => <Row key={r.id} r={r} now={now} source={sourceOf(r)} lit={r.id === lit} onOpen={openRun} />)}
        </div>
      )}
      {start && (
        <StartDrawer key={start.id} flow={start} initial={taskPrefill(start, object, statusLabel)}
          object={{ id: object.id, ref: object.ref, title: object.title }}
          onClose={() => setStart(null)} onStarted={() => setStart(null)} />
      )}
    </section>
  )
}

function Row({ r, now, source, lit, onOpen }: { r: SopRunBrief; now: number; source: string; lit: boolean; onOpen: (id: string) => void }) {
  return (
    <button type="button" className={cls('sop-obj-run', lit && 'lit')} aria-current={lit || undefined} data-run={r.id} data-status={sopRunShow(r)} onClick={() => onOpen(r.id)} title="打开这次执行，逐步查看">
      <span className="sop-obj-name">
        <span className="ellipsis" title={r.title}>{r.flow_name}</span>
        <span className="sop-obj-progress ellipsis">{[source, objectRunProgress(r)].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="sop-steps-bar sop-obj-bar" aria-hidden="true">
        {r.steps.map((x) => <span key={x.key} className={`seg-${x.status}`} />)}
      </span>
      <RunPill status={sopRunShow(r)} />
      <span className="sop-obj-at" title={r.started_at}>{timeAgo(r.started_at, now)}开始</span>
    </button>
  )
}
