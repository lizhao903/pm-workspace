// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务抽屉的进展时间线（DEV-08a）：领取、进展、提交验收按时间顺序排，提交验收那条醒目显示；
// 进行中的任务抽屉打开期间按事件流刷新，事件流断开时每 10 秒轮询；底部可以手工追加一条进展。样式借原型 monitor.tsx 的 mo-timeline。
import { Fragment, useEffect, useId, useRef, useState, type Ref } from 'react'
import {
  PROGRESS_LIMIT, chronological, errorText, isInProgress, progressKindLabel, shortSession, useAppendProgress, useNotifyChange, useObject,
  useEventsLive, useObjectTypes, useProgress, type ObjectStatus, type Progress, type WorkObject,
} from '../../core/data'
import { Button, ErrorState, Pill, Tag, Tags, Textarea, cls } from '../../core/ui'
import { Markdown } from './Markdown'
import { timeAgo } from './model'
import './progress.css'

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ProgressTimeline({ task }: { task: WorkObject }) {
  const notify = useNotifyChange()
  const live = useObject(task.id)
  const status = live.data?.status ?? task.status
  const types = useObjectTypes()
  const statuses = types.data?.find((t) => t.id === task.type_id)?.statuses ?? []

  // 进行中才自动刷新
  const q = useProgress(task.id, status)
  const pushed = useEventsLive()
  const rows = q.data ?? []
  const inProgress = isInProgress(status, rows)

  // 最新一条进展切了状态而抽屉里的对象还是旧状态（别的会话改的），按对象改动刷新：对象、列表、计数一起跟上，轮询开关跟着变
  const newest = rows[0]
  useEffect(() => {
    if (newest?.status && newest.status !== status) void notify({ kind: 'object', id: task.id })
  }, [newest?.id, newest?.status, status, notify, task.id])

  const list = chronological(rows)
  const lastReview = [...list].reverse().find((p) => p.kind === 'review')
  const reviewRef = useRef<HTMLLIElement>(null)

  return (
    <section className="dev-slot prog" data-slot="progress" data-task={task.id} aria-label="进展">
      <div className="dev-slot-head">
        <span className="field-group-title">进展</span>
        {rows.length > 0 && <span className="prog-count">{rows.length} 条</span>}
        {inProgress && <span className="prog-live" title={pushed ? '有新进展即时刷新' : '事件流未连上，抽屉打开期间每 10 秒刷新一次'}>进行中，自动刷新</span>}
        <span className="spacer" />
        {lastReview && (
          <button type="button" className="prog-jump" onClick={() => reviewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
            看验收总结
          </button>
        )}
      </div>
      {q.isPending ? (
        <div className="dev-slot-empty">加载中</div>
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !list.length ? (
        <div className="dev-slot-empty">还没有进展。Claude Code 领取任务后会在这里记它每一步做了什么，也可以在下面手工记一条。</div>
      ) : (
        <>
          {rows.length >= PROGRESS_LIMIT && <div className="prog-trunc">只显示最近 {PROGRESS_LIMIT} 条</div>}
          <ol className="prog-timeline">
            {list.map((p, k) => {
              const day = p.created_at.slice(0, 10)
              const showDay = k === 0 || list[k - 1].created_at.slice(0, 10) !== day
              return (
                <Fragment key={p.id}>
                  {showDay && <li className="prog-day" aria-hidden="true">{new Date(p.created_at).toLocaleDateString('zh-CN')}</li>}
                  <ProgressItem p={p} statuses={statuses} ref={p.id === lastReview?.id ? reviewRef : undefined} />
                </Fragment>
              )
            })}
          </ol>
        </>
      )}
      <AppendNote taskId={task.id} />
    </section>
  )
}

function ProgressItem({ p, statuses, ref }: { p: Progress; statuses: ObjectStatus[]; ref?: Ref<HTMLLIElement> }) {
  const st = p.status ? statuses.find((s) => s.key === p.status) : undefined
  return (
    <li ref={ref} className={cls('prog-ev', `prog-${p.kind}`)} data-kind={p.kind}>
      <span className="prog-dot" aria-hidden="true" />
      <div className="prog-body">
        <div className="prog-meta">
          <span className="prog-kind">{progressKindLabel(p.kind)}</span>
          <span className="prog-actor">{p.actor_name || p.actor || '未知'}</span>
          {p.session_id && <span className="prog-sess" title={`会话 ${p.session_id}`}>{shortSession(p.session_id)}</span>}
          <time dateTime={p.created_at} title={new Date(p.created_at).toLocaleString('zh-CN')}>
            {fmtTime(p.created_at)} · {timeAgo(p.created_at)}
          </time>
          {p.status && <Pill label={`状态：${st?.label ?? p.status}`} color={st?.color} />}
        </div>
        <div className="prog-text"><Markdown source={p.text} empty="（没有正文）" /></div>
        {p.commits.length > 0 && (
          <div className="prog-refs" aria-label="提交">
            <span className="prog-refs-label">提交</span>
            <Tags>{p.commits.map((c) => <Tag key={c}><span className="prog-mono" title={c}>{c.slice(0, 10)}</span></Tag>)}</Tags>
          </div>
        )}
        {p.files.length > 0 && (
          <div className="prog-refs" aria-label="文件">
            <span className="prog-refs-label">文件</span>
            <Tags>{p.files.map((f) => <Tag key={f}><span className="prog-mono" title={f}>{f}</span></Tag>)}</Tags>
          </div>
        )}
      </div>
    </li>
  )
}

/** 手工记一条进展：kind=note，操作者由后端按界面来源记成 me */
function AppendNote({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const append = useAppendProgress(taskId)
  const id = useId()

  if (!open) {
    return <button type="button" className="prog-add" onClick={() => setOpen(true)}>+ 记一条进展</button>
  }
  const submit = async () => {
    if (!text.trim()) return
    setError('')
    try {
      await append.mutateAsync({ text })
      setText('')
      setOpen(false)
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <div className="prog-form">
      <label className="field-label" htmlFor={id}>记一条进展</label>
      <Textarea id={id} rows={3} autoFocus value={text} placeholder="支持 Markdown"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }} />
      <div className="prog-form-foot">
        {error && <span className="field-err" role="alert">没记上：{error}</span>}
        <span className="spacer" />
        <Button size="sm" onClick={() => { setOpen(false); setText(''); setError('') }}>取消</Button>
        <Button size="sm" variant="primary" disabled={!text.trim() || append.isPending} onClick={() => void submit()}>记下</Button>
      </div>
    </div>
  )
}
