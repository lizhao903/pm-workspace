// 从消息发起会话、拆分任务（0008）：选一个 Agent（默认挑上次用的、带 IM 触发的、像管任务的），看一眼要发的第一句话（能改），
// 拆分任务时默认先挑「写任务」没关的；确定后建一个挂这个 Agent 的会话（来源指回这组消息，内核 0047），记到消息上，打开会话页自动发出第一句话。
// 拆分任务时，会话里 Agent 用 create_object 建的任务自动挂到消息归属的项目、props.source_ref 指回消息；
// Agent 建任务的授权是「需确认」时每条都先出确认卡片（会话里已有的机制）。这里按授权提示一句。
// 工作目录：消息归属的项目有关联本地目录时用它，能改、能清空。
import { useMemo, useState } from 'react'
import {
  errorText, useAgentGrants, useAgents, useImStartSession, useProjects, type AgentGrantMode, type ImMessage, type ImSessionIntent,
} from '../../core/data'
import { ConfirmDialog, Field, Input, SearchSelect, Textarea, cls } from '../../core/ui'
import { AgentAvatar } from '../../core/ui/AgentAvatar'
import { LAST_AGENT_KEY, pickAgent, projectOf, relatedDir, sessionPrompt, sessionTitle, sourceRef } from './sessionModel'

const readLast = () => { try { return localStorage.getItem(LAST_AGENT_KEY) } catch { return null } }
const saveLast = (id: string) => { try { localStorage.setItem(LAST_AGENT_KEY, id) } catch { /* 本机存不了就下次重新挑 */ } }

const GRANT_NOTE: Record<AgentGrantMode, string> = {
  confirm: '它建任务前会先出确认卡片，你在会话里逐条确认',
  auto: '它建任务不用确认；第一句话里已经让它列完清单先停下，等你回复再建',
  off: '它没开「写任务」权限，拆出清单也建不了任务；到「设置 / Agent」里把写任务开成需确认',
}

export function StartSessionDialog({ messages, intent: intent0, chLabel, onCancel, onStarted }: {
  /** 这条消息，或合并显示的一组 */
  messages: readonly ImMessage[]
  intent: ImSessionIntent
  chLabel: string
  onCancel: () => void
  /** 建好了：去会话页 */
  onStarted: (sessionId: string) => void
}) {
  const agents = useAgents()
  const projects = useProjects()
  const start = useImStartSession()
  const list = useMemo(() => agents.data ?? [], [agents.data])
  const [picked, setPicked] = useState('')
  const [intent, setIntent] = useState(intent0)
  // 各 Agent「写任务」的实际档位：拆分任务时默认先挑能建任务的；取回来之前不看它
  const ids = useMemo(() => list.filter((a) => a.enabled).map((a) => a.id), [list])
  const grants = useAgentGrants(ids)
  const writable = intent === 'split' ? (a: { id: string }) => { const g = grants[a.id]?.effective.write_tasks; return g === undefined || g !== 'off' } : undefined
  const agent = list.find((a) => a.id === picked && a.enabled) ?? pickAgent(list, readLast(), writable)
  const grant = agent ? grants[agent.id]?.effective.write_tasks : undefined
  const project = projectOf(messages)
  // 项目的本地目录（workdir）优先；没设时用项目第一个关联目录（Acme、Globex 这类只登记了关联目录的项目）
  const projObj = project ? (projects.data?.data ?? []).find((p) => p.id === project.id) : undefined
  const projectDir = projObj ? projObj.workdir || relatedDir(projObj.props) : ''
  const [workdir, setWorkdir] = useState<string | null>(null)
  const dir = (workdir ?? projectDir).trim()
  // 第一句话按意图和授权现拼；用户改过就用他改的
  const auto = sessionPrompt(messages, intent, { chLabel, grant })
  const [edited, setEdited] = useState<string | null>(null)
  const prompt = edited ?? auto

  const submit = () => {
    if (!agent || start.isPending || !prompt.trim()) return
    saveLast(agent.id)
    start.mutate({
      agent_id: agent.id, title: sessionTitle(messages, intent), workdir: dir || undefined, source_ref: sourceRef(messages, chLabel),
      prompt: prompt.trim(), message_ids: messages.map((m) => m.id), intent,
    }, { onSuccess: (r) => onStarted(r.session.id) })
  }

  const usable = list.filter((a) => a.enabled)
  let agentField
  if (agents.isPending) agentField = <span className="im-muted">正在读 Agent</span>
  else if (agents.isError) agentField = <span className="im-err">Agent 没取到：{errorText(agents.error)}</span>
  else if (!usable.length) agentField = <span className="im-muted">{list.length ? '所有 Agent 都停用了' : '还没有 Agent'}，先到「设置 / Agent」里建一个或启用一个</span>
  else {
    agentField = (
      <SearchSelect variant="field" value={agent?.id ?? ''} searchPlaceholder="搜 Agent" aria-label="Agent"
        options={usable.map((a) => ({ value: a.id, label: a.name || '未命名', hint: a.desc || undefined, icon: <AgentAvatar agent={a} size={16} /> }))}
        onChange={(v) => { if (v) setPicked(v) }} />
    )
  }

  return (
    <ConfirmDialog open title={intent === 'split' ? '拆分任务' : '发起会话'} busy={start.isPending}
      confirmLabel={start.isPending ? '正在建会话…' : intent === 'split' ? '开始拆分' : '发起会话'}
      onConfirm={submit} onCancel={onCancel}>
      <div className="im-start">
        <div className="im-seg im-start-intent" role="group" aria-label="要它做什么">
          {([['split', '拆分任务'], ['chat', '只是发起会话']] as const).map(([k, label]) => (
            <button key={k} type="button" className={cls(intent === k && 'on')} aria-pressed={intent === k}
              onClick={() => { setIntent(k); setEdited(null) }}>{label}</button>
          ))}
        </div>
        <Field label="交给哪个 Agent" wrap={false}>{agentField}</Field>
        {agent && intent === 'split' && grant && <div className={cls('im-muted', grant === 'off' && 'im-start-warn')} role={grant === 'off' ? 'alert' : undefined}>{agent.name}：{GRANT_NOTE[grant]}</div>}
        <div className="im-muted">
          {messages.length > 1 ? `带上这 ${messages.length} 条消息` : '带上这条消息'}
          {project ? `；拆出来的任务建在项目「${project.name || project.id}」下，记上来源消息` : '；消息没归项目，拆出来的任务不挂项目，记上来源消息'}
        </div>
        <Field label="工作目录" hint={projectDir ? (projObj?.workdir ? '用的是项目的本地目录，Agent 写的文件落在这里' : '用的是项目的关联目录，Agent 写的文件落在这里') : '可选，Agent 写的文件落在这里'}>
          <Input className="mono-input" value={workdir ?? projectDir} placeholder="本机绝对路径；留空不设" aria-label="工作目录"
            onChange={(e) => setWorkdir(e.target.value)} />
        </Field>
        <Field label="第一句话" wrap={false} hint={edited !== null ? <button type="button" className="link-btn" onClick={() => setEdited(null)}>恢复默认</button> : '打开会话后自动发出，能改'}>
          <Textarea rows={9} value={prompt} aria-label="第一句话" onChange={(e) => setEdited(e.target.value)} />
        </Field>
        {start.isError && <div className="im-err" role="alert">没建成：{errorText(start.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}
