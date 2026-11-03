// IM 消息页：合并的一组消息的抽屉（SPEC-messages-4）和「发起会话 / 拆分任务」弹窗（SPEC-messages-5）。
// 正式产品见 frontend/src/plugins/im/GroupDrawer.tsx、StartSessionDialog.tsx。
import { useState, type ReactNode } from 'react'
import type { Agent } from './agentdata'
import type { Message } from './data'
import { countLabel, isOpenMsg, sessionPrompt, type MsgRow, type SessionIntent } from './msggroup'
import { MaterialSection, type MaterialHit } from './msgmaterial'
import { SearchSelect } from './searchselect'
import { Avatar, cls, timeAgo } from './ui'

const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const KIND_TITLE: Record<MsgRow['kind'], string> = { single: '消息', dm: '私聊', burst: '连发的消息', dup: '重复的消息' }

/** 一组消息：按时间正序看整段，每条能处理、能打开详情；上面整组处理；下面交给 Agent */
export function GroupDrawer({ row, who, statusLabel, links, onClose, onAct, onOpenMessage, onStart, onOpenSession, notes, onToMaterial, onOpenMaterial, contactId, onOpenContact, onSaveContact, triage }: {
  /** 「分诊建议」一节（SPEC-messages-4.10），放在发信人下面 */
  triage?: ReactNode
  /** 维护联系人（SPEC-messages-4.9）：一组是同一个发信人；认上的给「查看联系人」，没认上的给「存为联系人」 */
  contactId?: string; onOpenContact: (id: string) => void; onSaveContact: () => void
  /** 转项目资料（SPEC-messages-4.8）：这组转成的笔记；整组转；转过的去项目资料页 */
  notes: MaterialHit[]; onToMaterial: () => void; onOpenMaterial: (projectId: string, materialId: string) => void
  row: MsgRow
  who: (m: Message) => string
  statusLabel: (k: string) => string
  links: { sessions: string[]; tasks: number }
  onClose: () => void
  onAct: (id: string, kind: 'done' | 'ignore' | 'reopen') => void
  onOpenMessage: (id: string) => void
  onStart: (intent: SessionIntent) => void
  onOpenSession: (id: string) => void
}) {
  const all = row.all
  const last = all[all.length - 1]
  const open = all.filter(isOpenMsg)
  return (
    <aside className="drawer" aria-label="一组消息">
      <div className="drawer-head">
        <span className="drawer-kicker">{last.conversation || '私聊'} · {KIND_TITLE[row.kind]}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body">
        <div className={cls('msg-strip', open.length ? 'ms-pending' : `ms-${last.status}`)}>
          <span className="ms-dot" />
          <b>{all.length} 条</b>
          <span className="ms-sub">{open.length ? `${open.length} 条还没处理` : '都处理过了'}{row.kind === 'dup' ? ' · 内容相同' : ''}</span>
          <span className="spacer" />
          {open.length > 0 && (
            <>
              <button className="ms-act ms-primary" onClick={() => open.forEach((m) => onAct(m.id, 'done'))}>全部标为{statusLabel('done')}</button>
              <button className="ms-act" onClick={() => open.forEach((m) => onAct(m.id, 'ignore'))}>全部忽略</button>
            </>
          )}
        </div>
        <div className="sender">
          <Avatar name={who(last)} size={40} />
          <div className="sender-text">
            <div className="sender-name">{row.kind === 'dm' ? `和 ${who(last)} 的私聊` : who(last)}</div>
            <div className="muted">{countLabel({ ...row, items: all }) || '1 条'} · 最近 {timeAgo(last.at)}</div>
          </div>
          <div className="spacer" />
          {contactId
            ? <button className="btn btn-ghost" onClick={() => onOpenContact(contactId)}>查看联系人</button>
            : <button className="btn btn-ghost" onClick={onSaveContact}>存为联系人</button>}
        </div>
        {triage}
        <div className="msg-group-thread">
          {all.map((m) => (
            <div key={m.id} className={cls('msg-group-item', !isOpenMsg(m) && 'msg-closed')}>
              <div className="act-row">
                <span className="muted">{fmt(m.at)}</span>
                {m.status !== 'pending' && <span className="state">{statusLabel(m.status)}</span>}
                {!m.read && <span className="state">未读</span>}
                <span className="spacer" />
                {isOpenMsg(m) ? (
                  <>
                    <button className="act act-primary" onClick={() => onAct(m.id, 'done')}>{statusLabel('done')}</button>
                    <button className="act act-quiet" onClick={() => onAct(m.id, 'ignore')}>忽略</button>
                  </>
                ) : <button className="act" onClick={() => onAct(m.id, 'reopen')}>重新打开</button>}
                <button className="act" onClick={() => onOpenMessage(m.id)} title="打开这一条：转任务、附件、归项目、认人">详情</button>
              </div>
              <div className="bubble bubble-in">{m.text || '（没有正文）'}</div>
            </div>
          ))}
        </div>
        <AgentSection links={links} onOpenSession={onOpenSession} />
        <MaterialSection notes={notes} onOpen={onOpenMaterial} />
      </div>
      <div className="drawer-foot">
        <span className="spacer" />
        <ReplyBarActions many onStart={onStart} onToMaterial={onToMaterial} />
      </div>
    </aside>
  )
}

/** 抽屉底部发送按钮那一行的三个动作（SPEC-messages-2.40）：拆分任务、发起会话、转项目资料 */
export function ReplyBarActions({ many, onStart, onToMaterial }: { many: boolean; onStart: (intent: SessionIntent) => void; onToMaterial: () => void }) {
  const what = many ? '这组消息' : '这条消息'
  return (
    <span className="reply-acts">
      <button className="act" onClick={() => onStart('split')} title={`让 Agent 把${what}里的事拆成任务，先给清单让你确认再建`}>拆分任务</button>
      <button className="act" onClick={() => onStart('chat')} title={`带上${what}的原文、发信人、群和归属项目，和 Agent 开一个会话`}>发起会话</button>
      <button className="act" onClick={onToMaterial} title={`把${what}按时间拼成一段对话记录，存成项目资料里的一条笔记`}>转项目资料</button>
    </span>
  )
}

/** 抽屉里「交给 Agent」一节（SPEC-messages-2.36、4.4）：只列发起过的会话、拆出的任务，没有时不显示 */
export function AgentSection({ links, onOpenSession }: {
  links: { sessions: string[]; tasks: number }; onOpenSession: (id: string) => void
}) {
  if (!links.sessions.length) return null
  return (
    <>
      <div className="section-label">交给 Agent</div>
      {links.sessions.length > 0 && (
        <div className="act-row">
          <span className="muted">已发起会话 {links.sessions.length} 个</span>
          <button className="link-btn" onClick={() => onOpenSession(links.sessions[0])}>打开最近的</button>
          {links.tasks > 0 && <span className="muted">已拆分 {links.tasks} 条任务</span>}
        </div>
      )}
    </>
  )
}

/** 发起会话、拆分任务：选 Agent（默认上次用的、带 IM 触发的、像管任务的），看一眼第一句话（能改），确定后建会话并跳过去 */
export function StartSessionDialog({ messages, intent: intent0, agents, who, chLabel, project, workdir, onCancel, onStart }: {
  messages: Message[]; intent: SessionIntent; agents: Agent[]; who: (m: Message) => string; chLabel: string
  /** 消息归属的项目名、项目关联的本地目录 */
  project?: string; workdir?: string
  onCancel: () => void
  onStart: (agentId: string, intent: SessionIntent, prompt: string, workdir: string) => void
}) {
  const usable = agents.filter((a) => a.enabled)
  const [intent, setIntent] = useState(intent0)
  // 默认：带 IM 触发的 → 像管任务、消息的 → 第一个；拆分任务时先在「写任务」没关的里挑（SPEC-messages-5.2）
  const pick = (xs: Agent[]) => xs.find((a) => a.triggers.some((t) => t.kind === 'im')) ?? xs.find((a) => /任务|拆|消息|IM|助理|助手/i.test(`${a.name} ${a.desc}`)) ?? xs[0]
  const [picked, setAgentId] = useState('')
  const agentId = picked || ((intent === 'split' && pick(usable.filter((a) => a.abilities.write_tasks !== 'off'))) || pick(usable))?.id || ''
  const [edited, setEdited] = useState<string | null>(null)
  const [dir, setDir] = useState(workdir ?? '')
  const agent = usable.find((a) => a.id === agentId)
  const prompt = edited ?? sessionPrompt(messages, intent, { who, chLabel, project, grant: agent?.abilities.write_tasks })
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs msg-start" role="dialog" aria-label={intent === 'split' ? '拆分任务' : '发起会话'}>
        <div className="qs-head"><b>{intent === 'split' ? '拆分任务' : '发起会话'}</b></div>
        <div className="seg msg-start-intent">
          {([['split', '拆分任务'], ['chat', '只是发起会话']] as const).map(([k, label]) => (
            <button key={k} className={cls(intent === k && 'on')} onClick={() => { setIntent(k); setEdited(null) }}>{label}</button>
          ))}
        </div>
        <label className="msg-start-field"><span className="list-sub">交给哪个 Agent</span>
          {usable.length
            ? <SearchSelect value={agentId} onChange={(v) => { if (v) setAgentId(v) }} searchPlaceholder="搜 Agent" aria-label="Agent"
                options={usable.map((a) => ({ value: a.id, label: a.name, hint: a.desc }))} />
            : <span className="muted">还没有能用的 Agent，先到「设置 / Agent」里建一个</span>}
        </label>
        {intent === 'split' && agent && (
          <div className={cls('list-sub', agent.abilities.write_tasks === 'off' && 'danger-text')}>{agent.name}：{agent.abilities.write_tasks === 'off'
            ? '它没开「写任务」权限，拆出清单也建不了任务；到「设置 / Agent」里把写任务开成需确认'
            : agent.abilities.write_tasks === 'auto' ? '它建任务不用确认；第一句话里已经让它列完清单先停下，等你回复再建' : '它建任务前会先出确认卡片，你在会话里逐条确认'}</div>
        )}
        <div className="list-sub">
          {messages.length > 1 ? `带上这 ${messages.length} 条消息` : '带上这条消息'}
          {project ? `；拆出来的任务建在项目「${project}」下，记上来源消息` : '；消息没归项目，拆出来的任务不挂项目，记上来源消息'}
        </div>
        <label className="msg-start-field"><span className="list-sub">工作目录{workdir ? '（项目关联的本地目录）' : '（可选）'}</span>
          <input className="input mono-input" value={dir} placeholder="本机绝对路径；留空不设" onChange={(e) => setDir(e.target.value)} />
        </label>
        <label className="msg-start-field"><span className="list-sub">第一句话（打开会话后自动发出，能改）{edited !== null && <button className="link-btn" onClick={() => setEdited(null)}>恢复默认</button>}</span>
          <textarea className="input" rows={9} value={prompt} onChange={(e) => setEdited(e.target.value)} />
        </label>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onCancel}>取消</button>
          <button className="act act-primary" disabled={!agent || !prompt.trim()} onClick={() => agent && onStart(agent.id, intent, prompt.trim(), dir.trim())}>
            {intent === 'split' ? '开始拆分' : '发起会话'}
          </button>
        </div>
      </div>
    </div>
  )
}
