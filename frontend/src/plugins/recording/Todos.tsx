// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 详情页「待你确认」区：AI 从纪要里识别出的项目/任务/目标候选（带置信度），确认后建任务/挂项目；
// 也可以忽略。确认弹层可改标题、项目、负责人、优先级、截止日期。低置信度候选和纪要里的 questions 放进
// 「需要你补充」，提醒用户补信息。
import { useState } from 'react'
import { Link } from 'react-router'
import {
  errorText, useConfirmTodo, useDictItems, useIgnoreTodo, useProjects, useStakeholders,
  type Recording, type RecordingQuestion, type RecordingTodo, type TodoConfirmInput,
} from '../../core/data'
import { Button, Drawer, Field, Input, SearchSelect, Select, Tag, prioText } from '../../core/ui'
import {
  confidencePct, confidenceTone, lowConfidenceTodos, pendingTodos, todoKindText, todoObjectPath,
} from './model'

/** 一条候选的置信度条 + 百分比 */
function Confidence({ value }: { value: number }) {
  return (
    <span className="rec-confidence" title={`置信度 ${confidencePct(value)}%`}>
      <span className="rec-confidence-bar" aria-hidden="true">
        <span style={{ width: `${confidencePct(value)}%`, background: confidenceTone(value) }} />
      </span>
      <span className="rec-confidence-pct">{confidencePct(value)}%</span>
    </span>
  )
}

/** 候选卡片上的项目/负责人/截止/理由 */
function todoMeta(t: RecordingTodo): string[] {
  const out: string[] = []
  if (t.project_title) out.push(`项目：${t.project_title}`)
  if (t.owner_name) out.push(`负责人：${t.owner_name}`)
  if (t.due_at) out.push(`截止：${t.due_at.slice(0, 10)}`)
  if (t.reason) out.push(t.reason)
  return out
}

export function TodosSection({ r, threshold }: { r: Recording; threshold: number }) {
  const [confirming, setConfirming] = useState<RecordingTodo | null>(null)
  const [error, setError] = useState('')
  const ignore = useIgnoreTodo()
  const todos = Array.isArray(r.todos) ? r.todos : []
  const pending = pendingTodos(todos)
  const confirmed = todos.filter((t) => t.status === 'confirmed')
  const ignored = todos.filter((t) => t.status === 'ignored').length
  const low = lowConfidenceTodos(todos, threshold)
  const questions: RecordingQuestion[] = Array.isArray(r.minutes?.questions) ? r.minutes.questions : []

  const doIgnore = (t: RecordingTodo) => {
    setError('')
    ignore.mutate({ id: r.id, index: t.index }, {
      onError: (e) => setError(`忽略失败：${errorText(e)}`),
    })
  }

  return (
    <section className="rec-section">
      <div className="rec-section-title">
        <span>待你确认</span>
        <span className="rec-faint">
          {pending.length ? `${pending.length} 条候选，确认后建任务或挂项目` : 'AI 识别到项目/任务/目标后列在这里'}
          {confirmed.length ? ` · 已确认 ${confirmed.length}` : ''}
          {ignored ? ` · 已忽略 ${ignored}` : ''}
        </span>
      </div>

      {error && <div className="rec-err" role="alert">{error}</div>}

      {pending.length === 0 ? (
        <p className="rec-faint">没有待确认的候选。生成纪要后，识别到的项目、任务和目标会出现在这里。</p>
      ) : (
        <ul className="rec-todos" aria-label="待确认候选">
          {pending.map((t) => (
            <li key={t.index} className="rec-todo">
              <div className="rec-todo-head">
                <Tag>{todoKindText(t.kind)}</Tag>
                <b className="rec-todo-title">{t.title || '未命名候选'}</b>
                <Confidence value={t.confidence} />
              </div>
              {t.detail && <div className="rec-todo-detail">{t.detail}</div>}
              <div className="rec-todo-meta">{todoMeta(t).join(' · ')}</div>
              <div className="rec-todo-actions">
                <Button size="sm" variant="primary" onClick={() => { setError(''); setConfirming(t) }}>确认…</Button>
                <Button size="sm" onClick={() => doIgnore(t)} disabled={ignore.isPending}>忽略</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirmed.length > 0 && (
        <div className="rec-minutes-block">
          <div className="rec-minutes-subtitle">已确认</div>
          <ul className="rec-done-todos">
            {confirmed.map((t) => (
              <li key={t.index} className="rec-done-todo">
                <Tag>{todoKindText(t.kind)}</Tag>
                <span className="rec-done-title">{t.title}</span>
                {t.kind === 'project'
                  ? <span className="rec-faint">已挂到项目「{t.project_title || t.project_id}」</span>
                  : todoObjectPath(t)
                    ? <Link className="rec-todo-link" to={todoObjectPath(t)}>{t.object_ref || '查看任务'}</Link>
                    : <span className="rec-faint">已建任务</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(questions.length > 0 || low.length > 0) && (
        <div className="rec-minutes-block rec-supplement">
          <div className="rec-minutes-subtitle">需要你补充</div>
          <ul className="rec-points">
            {questions.map((q, i) => (
              <li key={`q${i}`}>
                <b>{q.question}</b>
                {q.why ? <span className="rec-faint">（{q.why}）</span> : null}
                <Confidence value={q.confidence} />
              </li>
            ))}
            {low.map((t) => (
              <li key={`t${t.index}`}>
                <span className="rec-faint">{todoKindText(t.kind)}：</span>{t.title}
                <Confidence value={t.confidence} />
                {t.reason ? <span className="rec-faint">（{t.reason}）</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Drawer open={!!confirming} onClose={() => setConfirming(null)}
        kicker={confirming ? `确认${todoKindText(confirming.kind)}` : ''} aria-label="确认候选">
        {confirming && (
          <ConfirmTodoForm key={confirming.index} r={r} todo={confirming}
            onDone={() => setConfirming(null)} onCancel={() => setConfirming(null)} />
        )}
      </Drawer>
    </section>
  )
}

/** 确认候选的表单：按 kind 决定要不要选项目、能不能改标题 */
function ConfirmTodoForm({ r, todo, onDone, onCancel }: {
  r: Recording
  todo: RecordingTodo
  onDone: () => void
  onCancel: () => void
}) {
  const confirm = useConfirmTodo()
  const projects = useProjects()
  const people = useStakeholders()
  const prios = useDictItems('priority')
  const [title, setTitle] = useState(todo.title)
  const [projectId, setProjectId] = useState(() => {
    if (todo.project_id) return todo.project_id
    if (todo.kind !== 'project') return r.project_id
    return ''
  })
  const [ownerId, setOwnerId] = useState(() => (people.data ?? []).find((s) => s.name === todo.owner_name)?.id ?? '')
  /** 打开表单时名册可能还没加载，提交时再按名字匹配一次 */
  const effectiveOwnerId = ownerId || (people.data ?? []).find((s) => s.name === todo.owner_name)?.id || ''
  const [priority, setPriority] = useState('')
  const [due, setDue] = useState(() => (todo.due_at ? todo.due_at.slice(0, 10) : ''))
  const [error, setError] = useState('')

  const projectOpts = (projects.data?.data ?? []).filter((p) => !p.deleted_at).map((p) => ({ value: p.id, label: p.title, hint: p.ref }))
  const peopleOpts = (people.data ?? []).filter((s) => !s.archived_at).map((s) => ({
    value: s.id, label: s.name, hint: s.ai_kind ? 'Agent' : (s.role || undefined),
  }))
  const prioOpts = [
    { value: '', label: '默认优先级' },
    ...(prios.data ?? []).filter((p) => !p.archived_at).map((p) => ({ value: p.key, label: prioText(p.key, p) })),
  ]

  const titleBad = todo.kind !== 'project' && !title.trim()
  const projectBad = todo.kind === 'project' && !projectId
  const busy = confirm.isPending

  const submit = () => {
    if (titleBad || projectBad || busy) return
    const body: TodoConfirmInput = {}
    if (todo.kind !== 'project') body.title = title.trim()
    if (projectId) body.project_id = projectId
    if (effectiveOwnerId) body.owner_id = effectiveOwnerId
    if (priority) body.priority = priority
    if (due) body.due_at = new Date(`${due}T00:00:00`).toISOString()
    setError('')
    confirm.mutate({ id: r.id, index: todo.index, body }, {
      onSuccess: onDone,
      onError: (e) => setError(`确认失败：${errorText(e)}`),
    })
  }

  return (
    <div className="rec-confirm">
      <p className="rec-confirm-hint">
        {todo.kind === 'project'
          ? '项目候选：确认后把这条录音挂到你选的项目上，不会新建项目。'
          : todo.kind === 'goal'
            ? '目标候选：确认后建一条任务，并在属性里标为工作目标（暂不新建目标类型）。'
            : '任务候选：确认后在任务里建一条任务；负责人按名字匹配名册，匹配不到就不指派。'}
      </p>
      {todo.detail && <p className="rec-confirm-detail">{todo.detail}</p>}
      <div className="rec-todo-meta">{todoMeta(todo).join(' · ')}</div>

      {todo.kind !== 'project' && (
        <Field label="任务标题" required error={titleBad ? '必填' : undefined}>
          <Input value={title} invalid={titleBad} placeholder="要做的事" autoFocus
            onChange={(e) => setTitle(e.target.value)} />
        </Field>
      )}

      <Field label={todo.kind === 'project' ? '挂到哪个项目' : '所属项目'} wrap={false} required={todo.kind === 'project'}
        error={projectBad ? '项目候选要选一个已有项目' : undefined}
        hint={todo.kind === 'project' && !todo.project_id ? 'AI 没能在项目里匹配到，手动选一个' : undefined}>
        <SearchSelect variant="field" aria-label="项目" value={projectId} noneLabel={todo.kind === 'project' ? '请选择项目' : '不属于项目'}
          placeholder={todo.kind === 'project' ? '请选择项目' : '不属于项目'} searchPlaceholder="搜项目"
          options={projectOpts} emptyText={projects.isPending ? '加载中' : '还没有项目'}
          missingLabel={() => todo.project_title || '已删除的项目'} onChange={setProjectId} />
      </Field>

      <div className="rec-form-row">
        <Field label="负责人" wrap={false} hint={todo.owner_name && !ownerId ? `AI 建议「${todo.owner_name}」，名册里没匹配到` : undefined}>
          <SearchSelect variant="field" aria-label="负责人" value={ownerId} noneLabel="未分配" placeholder="未分配"
            searchPlaceholder="搜干系人" options={peopleOpts} emptyText={people.isPending ? '加载中' : '名册里还没有人'}
            onChange={setOwnerId} />
        </Field>
        <Field label="优先级" wrap={false}>
          <Select aria-label="优先级" options={prioOpts} value={priority} onValueChange={setPriority} />
        </Field>
      </div>

      <Field label="截止日期">
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>

      {error && <div className="rec-err" role="alert">{error}</div>}

      <div className="rec-confirm-actions">
        <Button variant="primary" disabled={titleBad || projectBad || busy} onClick={submit}>
          {busy ? '确认中…' : '确认'}
        </Button>
        <Button disabled={busy} onClick={onCancel}>取消</Button>
      </div>
    </div>
  )
}
