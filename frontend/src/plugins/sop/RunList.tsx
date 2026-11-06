// 执行记录和待我处理（SPEC-sop-3、SPEC-sop-4）：同一个页面，只差过滤条件、标题、说明和有没有状态分段按钮。
// 按开始日期分段，每段先显示 30 条，点一次多 100 条，改筛选或搜索后回到 30 条。照原型 sop.tsx RunList
// 「失败」分段能多选批量重跑（rerun.ts、RerunDialog）：每行一个勾选框，表头勾选框和底部「全选当前筛选结果」最多选 200 条；
// 底部批量条照 IM 消息页的样子，重跑后清掉勾选，结果一行提示留在工具栏下面
// 失败的行另有一个「重试」按钮（各视图都有）：单条重跑，流程发起后改过就按最新流程重新发起，否则在原执行里重试。
// 重跑成功后结果先写进缓存（core/data 的 applyRerun）：重试的变执行中，重新发起的原执行变「已重跑」，都立即离开「失败」和「待我处理」。
// 「已重跑」（sopRunShow）只在「全部」里出现，灰色，行右边「新执行」打开重跑出来的那条
// 待我处理（TSK-0486）：执行由 Page 合并「没走完和待我处理」的那份给，不受最近 500 条限制；执行下面另一组「停在等人阶段的任务」，
// 同今日「待我处理」的阶段那几条（没有等人步骤算到它头上的），点了去任务的流水线标签。按流程筛选时这组不出现，搜索按编号和标题
import { useMemo, useRef, useState } from 'react'
import {
  SOP_BATCH_MAX, errorText, sopRunShow, useRerunSopRuns, type SopFlow, type SopRerunAction, type SopRerunResult, type SopRunBrief, type SopRunStatus,
  type WorkObject,
} from '../../core/data'
import { Button, EmptyState, IconSearch, ListSegHead, ListSegMore, PageTitle, Pill, SearchSelect, cls } from '../../core/ui'
import { DAY_SEGS, baseRuns, daySegOf, flowOptions, sortRuns, timeAgo, type DaySeg } from './model'
import { stageWaitLook } from './pipelineModel'
import { RunHead, RunRow } from './parts'
import { RerunDialog } from './RerunDialog'
import { defaultRerun, rerunNote, staleRuns } from './rerun'
import { useSourceText } from './source'

const PAGE = 30
const STATUS_SEG: [('' | SopRunStatus), string][] = [['', '全部'], ['running', '执行中'], ['waiting', '待我处理'], ['failed', '失败'], ['done', '已完成']]

export function RunList({ runs, flows, view, flow, onFlow, onOpen, now, stageTasks, onOpenTask }: {
  runs: readonly SopRunBrief[]
  flows: readonly SopFlow[]
  view: 'runs' | 'waiting'
  /** 流程筛选放在地址里（?flow=），从流程详情「在执行记录里看全部」进来时预选 */
  flow: string
  onFlow: (id: string) => void
  onOpen: (id: string) => void
  now: number
  /** 待我处理才给：停在等人阶段、没有等人步骤算到它头上的任务（pipelineModel.stageWaitTasks） */
  stageTasks?: readonly WorkObject[]
  onOpenTask?: (id: string) => void
}) {
  const sourceOf = useSourceText()
  const [st, setSt] = useState<'' | SopRunStatus>('')
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<DaySeg | 'stage'>>(() => new Set())
  const [more, setMore] = useState<Partial<Record<DaySeg, number>>>({})
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const [rerunOpen, setRerunOpen] = useState(false)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const waiting = view === 'waiting'
  const status = waiting ? '' : st
  // 只有「失败」分段能多选重跑
  const picking = status === 'failed'

  const options = useMemo(() => flowOptions(flows, runs), [flows, runs])
  const base = baseRuns(runs, { flow, q, waitingOnly: waiting })
  // 按显示状态筛：已重跑的失败执行不在「失败」里
  const rows = sortRuns(base.filter((r) => !status || sopRunShow(r) === status))
  const segOf = daySegOf(new Date(now))
  const segs = DAY_SEGS.map((s) => ({ ...s, xs: rows.filter((r) => segOf(r.started_at) === s.key) })).filter((s) => s.xs.length)
  const filtered = !!(status || flow || q.trim())
  const kw = q.trim().toLowerCase()
  const tasks = waiting && !flow ? (stageTasks ?? []).filter((t) => !kw || `${t.ref} ${t.title}`.toLowerCase().includes(kw)) : []
  // 勾选只认当前筛选结果里的；全选按列表顺序取前 200 条（含折叠、没显示出来的）
  const ordered = segs.flatMap((s) => s.xs)
  const picked = picking ? ordered.filter((r) => sel.has(r.id)) : []
  const allN = Math.min(ordered.length, SOP_BATCH_MAX)
  const allPicked = picked.length > 0 && picked.length >= allN
  const pickAll = () => setSel(new Set(ordered.slice(0, SOP_BATCH_MAX).map((r) => r.id)))
  const togglePick = (id: string) => setSel((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const onRerunDone = (action: SopRerunAction, r: SopRerunResult) => {
    setRerunOpen(false)
    setSel(new Set())
    setNote(rerunNote(action, r))
  }

  // 有失败、已重跑的行时每行右边留一格放「重试」「新执行」，列才对得齐
  const hasFailed = rows.some((r) => sopRunShow(r) === 'failed' || sopRunShow(r) === 'relaunched')
  const rowOf = (r: SopRunBrief) => {
    const row = <RunRow r={r} onOpen={onOpen} now={now} source={sourceOf(r)} />
    if (!picking && !hasFailed) return <RunRow key={r.id} r={r} onOpen={onOpen} now={now} source={sourceOf(r)} />
    const shown = sopRunShow(r)
    return (
      <div key={r.id} className={cls('sop-run-pick', !picking && 'sop-run-nopick', sel.has(r.id) && 'picked')}>
        {picking && <input type="checkbox" className="sop-pick" checked={sel.has(r.id)} aria-label={`选中 ${r.title}`} onChange={() => togglePick(r.id)} />}
        {row}
        {hasFailed && (
          <span className="sop-run-act">
            {shown === 'failed' && <RetryButton r={r} flows={flows} onDone={(a, res) => setNote(rerunNote(a, res))} onError={(text) => setNote({ text, bad: true })} />}
            {shown === 'relaunched' && (
              <button type="button" className="btn btn-sm btn-ghost" title="这条失败的执行已按最新流程重跑，打开重跑出来的新执行"
                aria-label={`看 ${r.title} 重跑出来的新执行`} onClick={() => onOpen(r.relaunched_to!)}>新执行</button>
            )}
          </span>
        )}
      </div>
    )
  }

  const toggle = (k: DaySeg | 'stage') => setClosed((s) => {
    const n = new Set(s)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    return n
  })

  return (
    <div className="sop-page">
      <PageTitle parent="SOP" count={rows.length + tasks.length}
        desc={waiting ? '这些执行停下来等你：检查输出、确认输入，或处理失败的步骤' : '每一步都留着输入和输出，点进去可以逐步查看'}>
        {waiting ? '待我处理' : '执行记录'}
      </PageTitle>
      <div className="sop-toolbar">
        {!waiting && (
          <div className="sop-seg" role="group" aria-label="按状态筛选">
            {STATUS_SEG.map(([k, l]) => (
              <button key={k} type="button" className={cls(st === k && 'on')} aria-pressed={st === k} onClick={() => { setSt(k); setMore({}); setSel(new Set()) }}>
                {l}<span className="seg-n">{k ? base.filter((r) => sopRunShow(r) === k).length : base.length}</span>
              </button>
            ))}
          </div>
        )}
        <SearchSelect value={flow} onChange={(v) => { onFlow(v); setMore({}) }} noneLabel="全部流程" searchPlaceholder="搜流程" options={options}
          missingLabel={() => '已删除的流程'} />
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input placeholder="搜索执行标题、流程名" aria-label="搜索执行" value={q} onChange={(e) => { setQ(e.target.value); setMore({}) }} />
        </div>
      </div>
      {note && (
        <div className={cls('sop-rerun-note', note.bad && 'bad')} role="status">
          <span>{note.text}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNote(null)}>知道了</button>
        </div>
      )}
      {!rows.length && !tasks.length ? (
        <EmptyState
          title={filtered ? '没有匹配的执行记录' : waiting ? '没有等你处理的执行' : '没有执行记录'}
          desc={filtered ? '换个筛选条件试试' : waiting ? '检查点都处理完了' : '从流程库里选一个标准流程开始执行'} />
      ) : (
        <div className="sop-run-table">
          {picking || hasFailed ? (
            <div className={cls('sop-run-pick sop-run-pick-th', !picking && 'sop-run-nopick')}>
              {picking && (
                <input type="checkbox" className="sop-pick" checked={allPicked} aria-label={`全选当前筛选结果（最多 ${SOP_BATCH_MAX} 条）`}
                  ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked }}
                  onChange={() => (allPicked ? setSel(new Set()) : pickAll())} />
              )}
              <RunHead />
              {hasFailed && <span className="sop-run-act" aria-hidden="true" />}
            </div>
          ) : <RunHead />}
          {segs.map((s) => {
            const open = !closed.has(s.key)
            const n = PAGE + (more[s.key] ?? 0)
            return (
              <div key={s.key} role="group" aria-label={s.label}>
                <ListSegHead label={s.label} n={s.xs.length} open={open} onToggle={() => toggle(s.key)} />
                {open && s.xs.slice(0, n).map(rowOf)}
                {open && <ListSegMore n={s.xs.length - n} text={`再显示 ${Math.min(100, s.xs.length - n)} 条`}
                  onMore={() => setMore((m) => ({ ...m, [s.key]: (m[s.key] ?? 0) + 100 }))} />}
              </div>
            )
          })}
          {tasks.length > 0 && (
            <div role="group" aria-label="停在等人阶段的任务">
              <ListSegHead label="停在等人阶段的任务" n={tasks.length} open={!closed.has('stage')} onToggle={() => toggle('stage')} />
              {!closed.has('stage') && tasks.map((t) => {
                const row = <StageRow key={t.id} t={t} now={now} onOpen={(id) => onOpenTask?.(id)} />
                return picking || hasFailed ? (
                  <div key={t.id} className={cls('sop-run-pick', !picking && 'sop-run-nopick')}>
                    {row}
                    {hasFailed && <span className="sop-run-act" aria-hidden="true" />}
                  </div>
                ) : row
              })}
            </div>
          )}
        </div>
      )}
      {picked.length > 0 && (
        <div className="sop-bulk" role="toolbar" aria-label="批量重跑">
          <span className="sop-bulk-n">已选 {picked.length} 条</span>
          {picked.length < allN && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={pickAll}>全选当前筛选结果 {allN} 条</button>
          )}
          {ordered.length > SOP_BATCH_MAX && picked.length >= SOP_BATCH_MAX && (
            <span className="sop-bulk-hint" role="note">当前筛选结果有 {ordered.length} 条，一次最多重跑 {SOP_BATCH_MAX} 条，已选列表里的前 {SOP_BATCH_MAX} 条</span>
          )}
          <span className="spacer" />
          <Button variant="primary" size="sm" onClick={() => setRerunOpen(true)}>批量重跑</Button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel(new Set())}>取消选择</button>
        </div>
      )}
      {rerunOpen && (
        <RerunDialog runs={picked.slice(0, SOP_BATCH_MAX)} flows={flows} onCancel={() => setRerunOpen(false)} onDone={onRerunDone} />
      )}
    </div>
  )
}

/** 停在等人阶段的任务一行：列同执行行（任务、阶段、等什么、更新时间、动作），点了去任务的流水线标签 */
function StageRow({ t, now, onOpen }: { t: WorkObject; now: number; onOpen: (id: string) => void }) {
  const look = stageWaitLook(t)
  return (
    <button type="button" className="sop-run-row" title={`${look.action}：打开任务的流水线`} onClick={() => onOpen(t.id)}>
      <span className="sop-run-name">
        <span className="ellipsis" title={`${t.ref} ${t.title}`}>{t.ref} {t.title}</span>
        <span className="sop-run-sub ellipsis">任务 · {look.label}</span>
      </span>
      <span><Pill label={look.stage} color={look.danger ? 'var(--danger)' : 'var(--warn)'} /></span>
      <span className="sop-run-muted">{look.action}</span>
      <span className="sop-run-muted">{timeAgo(t.updated_at, now)}</span>
      <span className="sop-run-muted" />
    </button>
  )
}

/**
 * 单条失败执行的「重试」：流程发起后改过就按最新流程重新发起（标「重跑」），否则在原执行里重试失败的步骤。
 * 点了到请求结束前禁用；isPending 要等下一次渲染才变，连点两下的第二下靠 ref 挡掉（后端另有幂等）
 */
function RetryButton({ r, flows, onDone, onError }: {
  r: SopRunBrief
  flows: readonly SopFlow[]
  onDone: (action: SopRerunAction, res: SopRerunResult) => void
  onError: (text: string) => void
}) {
  const rerun = useRerunSopRuns()
  const busy = useRef(false)
  const action = defaultRerun(staleRuns([r], flows).length)
  const label = action === 'retry' ? '重试' : '重跑'
  const title = action === 'retry'
    ? '在原执行里从失败的那一步接着跑，已完成的步骤不重做'
    : '流程发起后改过：用原来的输入按流程现在的定义新起一条执行，原执行标成「已重跑」移出失败'
  return (
    <button type="button" className="btn btn-sm btn-outline" title={title} aria-label={`${label} ${r.title}`} disabled={rerun.isPending}
      onClick={() => {
        if (busy.current) return
        busy.current = true
        // 成功后这一行立即离开「失败」、按钮跟着卸掉，mutate 的回调就不来了；用 Promise 接结果，提示写在列表上
        rerun.mutateAsync({ runIds: [r.id], action })
          .then((res) => onDone(action, res), (e: unknown) => onError(`${label}失败：${errorText(e)}`))
          .finally(() => { busy.current = false })
      }}>
      {rerun.isPending ? `${label}中…` : label}
    </button>
  )
}
