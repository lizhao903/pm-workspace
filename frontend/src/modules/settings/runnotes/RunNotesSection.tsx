// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「快捷说明」（SPEC-settings-32，用户 2026-11-19 提）：「交给执行」弹窗附加说明上面那排芯片的增删改、排顺序。
// 后端整组接口 GET / PUT /api/run-quick-notes（存在 agent_settings.run_quick_notes），没设过时是内置的一组；
// 一页编辑完整组保存，全删了保存就是不要快捷说明。前端先挡空的、重复的、超长的，400 时显示后端的 message。
import { useState, type ReactNode } from 'react'
import { errorText, useRunQuickNotes, useSaveRunQuickNotes, type RunQuickNote } from '../../../core/data'
import { Button, EmptyState, ErrorState, Field, Input, LoadingState, PageTitle, Textarea } from '../../../core/ui'
import { NOTE_LABEL_MAX, NOTE_MAX, NOTE_TEXT_MAX, cleanNotes, noteIssues, sameNotes } from './notesModel'
import '../runprompts/runprompts.css'

const DESC = '「交给执行」弹窗里附加说明上面的快捷选项：点一个把文字追加进附加说明'

type Note = { ok: boolean; text: string }

export function RunNotesSection() {
  const q = useRunQuickNotes()
  const title = (count?: number) => <PageTitle parent="设置" count={count} desc={DESC}>快捷说明</PageTitle>
  if (q.isPending) return <div className="rp-page">{title()}<LoadingState /></div>
  if (q.isError) return <div className="rp-page">{title()}<ErrorState title="快捷说明没加载出来" error={errorText(q.error)} onRetry={() => void q.refetch()} /></div>
  return <NotesForm saved={q.data} title={title(q.data.length)} />
}

function NotesForm({ saved, title }: { saved: RunQuickNote[]; title: ReactNode }) {
  const save = useSaveRunQuickNotes()
  const [list, setList] = useState<RunQuickNote[]>(saved)
  const [base, setBase] = useState<RunQuickNote[]>(saved)
  const [touched, setTouched] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const issues = noteIssues(list)
  const bad = issues.some((x) => x.label || x.text)
  const changed = !sameNotes(list, base)
  const full = list.length >= NOTE_MAX

  const edit = (i: number, p: Partial<RunQuickNote>) => {
    setTouched(true)
    setNote(null)
    setList((l) => l.map((n, j) => (j === i ? { ...n, ...p } : n)))
  }
  const move = (i: number, d: -1 | 1) => {
    setNote(null)
    setList((l) => {
      const next = [...l]
      ;[next[i], next[i + d]] = [next[i + d], next[i]]
      return next
    })
  }
  const remove = (i: number) => {
    setNote(null)
    setList((l) => l.filter((_, j) => j !== i))
  }
  const submit = () => {
    setTouched(true)
    setNote(null)
    if (bad || !changed || save.isPending) return
    save.mutate(cleanNotes(list), {
      onSuccess: (v) => {
        setList(v)
        setBase(v)
        setTouched(false)
        setNote({ ok: true, text: v.length ? `已保存：${v.length} 条快捷说明` : '已保存：不用快捷说明' })
      },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  return (
    <form className="rp-page" aria-label="快捷说明" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      {title}
      <div className="rp-muted">
        交给执行（Claude Code、DeepSeek、工作台 Agent）的弹窗里，附加说明上面按这里的顺序排一排芯片，芯片上是名称；
        点一个把它的文字追加进附加说明（另起一行，已经有的不重复加），之后还能手改。只帮着填附加说明，不影响执行的权限和角色。
      </div>
      {list.length ? (
        <div className="rp-list">
          {list.map((n, i) => (
            <div key={i} className="rp-item" role="group" aria-label={`第 ${i + 1} 条`}>
              <div className="rp-row">
                <Field label="名称" error={touched ? issues[i].label || undefined : undefined} hint={`芯片上显示，最多 ${NOTE_LABEL_MAX} 字`}>
                  <Input aria-label="名称" value={n.label} placeholder="如：整理需求及原型" invalid={touched && !!issues[i].label}
                    onChange={(e) => edit(i, { label: e.target.value })} />
                </Field>
                <div className="rp-actions">
                  <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>上移</Button>
                  <Button size="sm" variant="ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)}>下移</Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => remove(i)}>删除</Button>
                </div>
              </div>
              <Field label="文字" error={touched ? issues[i].text || undefined : undefined} hint={`点了追加进附加说明的内容，最多 ${NOTE_TEXT_MAX} 字`}>
                <Textarea aria-label="文字" rows={2} autoGrow value={n.text} placeholder="如：整理需求及对应原型" invalid={touched && !!issues[i].text}
                  onChange={(e) => edit(i, { text: e.target.value })} />
              </Field>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="还没有快捷说明" desc="交给执行时只能手写附加说明。加一条试试" />
      )}
      <div className="rp-actions">
        <Button size="sm" disabled={full} title={full ? `最多 ${NOTE_MAX} 条` : undefined}
          onClick={() => { setNote(null); setTouched(true); setList((l) => [...l, { label: '', text: '' }]) }}>
          {full ? `最多 ${NOTE_MAX} 条` : '加一条'}
        </Button>
        <span className="spacer" />
        {changed && <Button size="sm" variant="ghost" onClick={() => { setList(base); setTouched(false); setNote(null) }}>撤销改动</Button>}
        <button type="submit" className="btn btn-outline btn-sm" disabled={!changed || bad || save.isPending}>{save.isPending ? '保存中…' : '保存'}</button>
      </div>
      {note && <div className={note.ok ? 'rp-ok' : 'rp-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
    </form>
  )
}
