// 消息和 Agent 会话互相追溯（0008）：列表行上的「已发起会话」「已拆分 N 条任务」小标，抽屉里的「交给 Agent」一节（只列发起过的）。
// 拆分任务、发起会话、转项目资料三个动作放在抽屉底部发送按钮那一行（ReplyBarActions）。
import type { ImMessage, ImSessionIntent } from '../../core/data'
import { rowLinks } from './groupModel'

/** 行上的小标：发起过会话的跳到最近一个；拆出过任务的，一条时打开那条任务，多条时去会话里看 */
export function LinkTags({ msgs, onOpenSession, onOpenTask }: {
  msgs: readonly ImMessage[]
  onOpenSession: (id: string) => void
  onOpenTask: (id: string) => void
}) {
  const { sessions, tasks } = rowLinks(msgs)
  if (!sessions.length && !tasks.length) return null
  const stop = { onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation() }
  return (
    <>
      {tasks.length > 0 && (
        <button type="button" className="im-state im-state-task" {...stop}
          title={tasks.map((t) => `${t.ref} ${t.title}`).join('\n')}
          onClick={(e) => { e.stopPropagation(); if (tasks.length === 1 || !sessions.length) onOpenTask(tasks[0].id); else onOpenSession(sessions[0].session_id) }}>
          已拆分 {tasks.length} 条任务
        </button>
      )}
      {sessions.length > 0 && !tasks.length && (
        <button type="button" className="im-state im-state-task" {...stop} title={`打开${sessions.length > 1 ? `最近的一个（共 ${sessions.length} 个）` : '这个会话'}`}
          onClick={(e) => { e.stopPropagation(); onOpenSession(sessions[0].session_id) }}>
          已发起会话
        </button>
      )}
    </>
  )
}

/** 抽屉底部发送按钮那一行的三个动作：拆分任务、发起会话、转项目资料 */
export function ReplyBarActions({ many, onStart, onToMaterial }: {
  many: boolean
  onStart: (intent: ImSessionIntent) => void
  onToMaterial: () => void
}) {
  const what = many ? '这组消息' : '这条消息'
  return (
    <span className="im-reply-acts" role="group" aria-label="交给 Agent 或转资料">
      <button type="button" className="im-act" onClick={() => onStart('split')} title={`让 Agent 把${what}里的事拆成任务，先给清单让你确认再建`}>拆分任务</button>
      <button type="button" className="im-act" onClick={() => onStart('chat')} title={`带上${what}的原文、发信人、群和归属项目，和 Agent 开一个会话`}>发起会话</button>
      <button type="button" className="im-act" onClick={onToMaterial} title={`把${what}按时间拼成一段对话记录，存成项目资料里的一条笔记`}>转项目资料</button>
    </span>
  )
}

/** 抽屉里「交给 Agent」一节：发起过的会话、拆出来的任务；都没有时不显示（动作在发送按钮那一行） */
export function AgentSection({ msgs, onOpenSession, onOpenTask }: {
  msgs: readonly ImMessage[]
  onOpenSession: (id: string) => void
  onOpenTask: (id: string) => void
}) {
  const { sessions, tasks } = rowLinks(msgs)
  if (!sessions.length && !tasks.length) return null
  return (
    <>
      <div className="im-section">交给 Agent</div>
      {sessions.length > 0 && (
        <div className="im-act-row im-links">
          <span className="im-muted">已发起会话 {sessions.length} 个</span>
          {sessions.slice(0, 3).map((s, i) => (
            <button key={s.session_id} type="button" className="link-btn" onClick={() => onOpenSession(s.session_id)}>
              {i === 0 ? '打开最近的' : `第 ${i + 1} 个`}{s.intent === 'split' ? '（拆分任务）' : ''}
            </button>
          ))}
        </div>
      )}
      {tasks.length > 0 && (
        <div className="im-act-row im-links">
          <span className="im-muted">已拆分 {tasks.length} 条任务</span>
          {tasks.map((t) => <button key={t.id} type="button" className="link-btn" title={t.title} onClick={() => onOpenTask(t.id)}>{t.ref || t.title}</button>)}
        </div>
      )}
    </>
  )
}
