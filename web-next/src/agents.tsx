import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PageTitle } from './topbar'
import {
  ABILITIES, AGENT_COLORS, AVATAR_ICONS, TRIGGER_KIND,
  type AbilityMode, type Agent, type AgentAvatarConf, type AgentRun, type ChatMsg, type KnowledgeBase, type Skill, type ToolCall, type TriggerKind,
} from './agentdata'
import type { Contact, Message } from './data'
import { useEnumView } from './enumdata'
import type { Task } from './taskdata'
import { isOpenTask } from './taskdata'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// Agent 管理：列表 + 配置页。配置页只管 Agent 本身（头像、模型、指令、技能、工具、MCP、知识库、触发方式），
// 右边的调试对话只用来试配置，不留记录；正式的会话、执行记录、产出结果在「会话」菜单里

const abilityOf = (k: string) => ABILITIES.find((a) => a.key === k)!
/** 连接器提供的工具：connMode 是连接器那边给的上限，Agent 只能设得一样严或更严 */
export interface ConnToolChoice { key: string; connId: string; conn: string; connOk: boolean; name: string; desc: string; write: boolean; connMode: AbilityMode }
const RANK: Record<AbilityMode, number> = { off: 0, confirm: 1, auto: 2 }

/** 可选模型来自「设置 / 模型服务商」里勾选启用的模型；ok 为 false 的显示但不能选 */
export interface ModelChoice { key: string; label: string; note: string; ok: boolean }
const MODE_LABEL: Record<AbilityMode, string> = { off: '关闭', confirm: '需确认', auto: '自动' }

const ICON_PATH: Record<string, ReactNode> = {
  robot: <><rect x="3" y="5" width="10" height="8" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2.5V5M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></>,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  doc: <><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M6 8h4.5M6 10.5h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  chart: <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  flow: <><rect x="1.8" y="2.5" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9.8" y="9.9" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.2 4.3h2a1.6 1.6 0 0 1 1.6 1.6v4" fill="none" stroke="currentColor" strokeWidth="1.4" /></>,
  search: <><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m2.5 4.5 5.5 4 5.5-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></>,
  calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  shield: <path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  spark: <path d="M8 2 9.4 6.6 14 8 9.4 9.4 8 14 6.6 9.4 2 8 6.6 6.6Z" fill="currentColor" />,
}

/** Agent 头像：上传的图片 / 内置图标 / 文字（自定义文字，默认名字第一个字），底色是 Agent 的颜色 */
export function AgentAvatar({ agent, size = 32 }: { agent: Pick<Agent, 'name' | 'color'> & { avatar?: AgentAvatarConf }; size?: number }) {
  const av = agent.avatar
  if (av?.kind === 'image' && av.value) return <img className="agent-avatar agent-avatar-img" src={av.value} alt="" style={{ width: size, height: size }} />
  return (
    <span className="agent-avatar" style={{ width: size, height: size, background: agent.color, fontSize: size * 0.42 }}>
      {av?.kind === 'icon' && ICON_PATH[av.value]
        ? <svg viewBox="0 0 16 16" width={size * 0.56} height={size * 0.56}>{ICON_PATH[av.value]}</svg>
        : (av?.kind === 'text' && av.value) || (agent.name || 'A').slice(0, 1)}
    </span>
  )
}

/** 头像设置：文字、图标、上传图片三种，加底色 */
function AvatarEditor({ agent, onChange }: { agent: Agent; onChange: (p: Partial<Agent>) => void }) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])
  const upload = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) { setErr('只能用图片'); return }
    // 原型里存成 data URL；太大的图会让数据很重，限制在 1MB 以内
    if (f.size > 1024 * 1024) { setErr('图片不能超过 1MB'); return }
    const r = new FileReader()
    r.onload = () => { onChange({ avatar: { kind: 'image', value: String(r.result) } }); setErr('') }
    r.readAsDataURL(f)
  }
  const av = agent.avatar
  return (
    <div className="menu-wrap avatar-edit" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen(!open)} title="设置头像">
        <AgentAvatar agent={agent} size={56} />
        <span className="avatar-btn-tip">更换</span>
      </button>
      {open && (
        <div className="menu avatar-menu">
          <div className="menu-label">文字</div>
          <div className="avatar-text-row">
            <input maxLength={2} value={av.kind === 'text' ? av.value : ''} placeholder={(agent.name || 'A').slice(0, 1)} onChange={(e) => onChange({ avatar: { kind: 'text', value: e.target.value } })} />
            <span className="list-sub">一到两个字；留空用名字的第一个字</span>
          </div>
          <div className="menu-label">图标</div>
          <div className="avatar-icons">
            {AVATAR_ICONS.map((ic) => (
              <button key={ic} className={cls('avatar-icon', av.kind === 'icon' && av.value === ic && 'on')} onClick={() => onChange({ avatar: { kind: 'icon', value: ic } })} title={ic}>
                <AgentAvatar agent={{ ...agent, avatar: { kind: 'icon', value: ic } }} size={30} />
              </button>
            ))}
          </div>
          <div className="menu-label">底色</div>
          <div className="agent-colors">
            {AGENT_COLORS.map((c) => <button key={c} className={cls('color-dot', agent.color === c && 'on')} style={{ background: c }} onClick={() => onChange({ color: c })} />)}
          </div>
          <div className="menu-label">图片</div>
          <div className="avatar-upload">
            <label className="act">
              上传图片
              <input type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            {av.kind === 'image' && <button className="act act-quiet" onClick={() => onChange({ avatar: { kind: 'text', value: '' } })}>移除图片</button>}
            <span className="list-sub">PNG、JPG，1MB 以内，建议正方形</span>
          </div>
          {err && <div className="field-err">{err}</div>}
        </div>
      )}
    </div>
  )
}

export const RUN_STATUS: Record<AgentRun['status'], { label: string; color: string }> = {
  done: { label: '已完成', color: '#2f7d43' },
  waiting: { label: '等你确认', color: '#b0570b' },
  rejected: { label: '已拒绝', color: '#a19d92' },
  failed: { label: '失败', color: '#c0352b' },
}
export const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>

/* ---------- 工具调用卡片：对话和运行记录共用 ---------- */

export function CallCard({ call, onConfirm, onReject }: { call: ToolCall; onConfirm?: () => void; onReject?: () => void }) {
  const [open, setOpen] = useState(call.state === 'pending')
  const a = abilityOf(call.tool)
  return (
    <div className={cls('call-card', `call-${call.state}`)}>
      <button className="call-head" onClick={() => setOpen(!open)}>
        <span className={cls('call-dot', a.write && 'write')} />
        <span className="call-name">{a.label}</span>
        <span className="call-state">{{ done: '已执行', pending: '等你确认', confirmed: '已确认执行', rejected: '已拒绝' }[call.state]}</span>
        <svg className={cls('call-chev', open && 'open')} viewBox="0 0 16 16" width="10" height="10"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="call-body">
          <div className="call-k">输入</div>
          <pre className="io-json">{JSON.stringify(call.input, null, 2)}</pre>
          {call.output !== undefined && <><div className="call-k">输出</div><pre className="io-json">{JSON.stringify(call.output, null, 2)}</pre></>}
          {call.state === 'pending' && onConfirm && (
            <div className="act-row">
              <button className="act act-primary" onClick={onConfirm}>确认执行</button>
              <button className="act act-quiet" onClick={onReject}>拒绝</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- 列表 ---------- */

export function AgentsPage({ agents, runs, models, onOpen, onNew, onToggle }: {
  agents: Agent[]; runs: AgentRun[]; models: ModelChoice[]
  onOpen: (id: string) => void; onNew: () => void; onToggle: (id: string, on: boolean) => void
}) {
  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={agents.length} desc="工作助手：各有指令、模型和工具，写操作默认要你确认才执行" actions={
        <button className="btn btn-primary" onClick={onNew}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          新建 Agent
        </button>
      }>Agent</PageTitle>
      {/* 等确认的操作标在对应 Agent 的卡片上，点进去默认打开运行记录 */}
      <div className="agent-grid">
        {agents.map((a) => {
          const mine = runs.filter((r) => r.agent_id === a.id)
          const on = ABILITIES.filter((x) => a.abilities[x.key] && a.abilities[x.key] !== 'off')
          const wait = mine.filter((r) => r.status === 'waiting').length
          return (
            <div key={a.id} className={cls('agent-card', !a.enabled && 'off')} onClick={() => onOpen(a.id)}>
              <div className="agent-card-head">
                <AgentAvatar agent={a} size={38} />
                <div className="agent-card-title">
                  <span className="agent-name ellipsis">{a.name || '未命名'}</span>
                  <span className={cls('agent-model', models.find((m) => m.key === a.model)?.ok === false && 'danger-text')}>
                    {models.find((m) => m.key === a.model)?.label ?? a.model}{models.find((m) => m.key === a.model)?.ok === false && ' · 不可用'}
                  </span>
                </div>
                <label className="switch-line" onClick={(e) => e.stopPropagation()} title={a.enabled ? '停用后不再被触发' : '启用'}>
                  <input type="checkbox" checked={a.enabled} onChange={(e) => onToggle(a.id, e.target.checked)} />
                  <span className="switch" />
                </label>
              </div>
              <div className="agent-desc">{a.desc || '还没有说明'}</div>
              <div className="agent-abilities">
                {on.slice(0, 5).map((x) => <span key={x.key} className={cls('ability-tag', a.abilities[x.key] === 'confirm' && 'confirm')}>{x.label}</span>)}
                {on.length > 5 && <span className="ability-tag">+{on.length - 5}</span>}
              </div>
              <div className="agent-foot">
                <span>{a.triggers.map((t) => (t.kind === 'manual' ? '手动' : t.detail || TRIGGER_KIND[t.kind])).join(' · ')}</span>
                <span className="spacer" />
                {wait > 0 && <span className="state state-snooze">{wait} 条等确认</span>}
                <span>{mine[0] ? `${timeAgo(mine[0].at)}运行` : '还没运行过'}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- 调试对话：本地规则模拟 ---------- */

export interface Ctx { tasks: Task[]; messages: Message[]; contacts: Contact[]; sops: { id: string; name: string }[] }

function reply(agent: Agent, text: string, ctx: Ctx): { text: string; calls: ToolCall[] } {
  const can = (k: string) => agent.abilities[k] && agent.abilities[k] !== 'off'
  const mode = (k: string): ToolCall['state'] => (agent.abilities[k] === 'auto' ? 'done' : 'pending')
  const calls: ToolCall[] = []
  const lines: string[] = []
  const denied: string[] = []

  const who = ctx.contacts.find((c) => text.includes(c.name))
  if (who) {
    if (can('read_contacts')) {
      calls.push({ tool: 'read_contacts', input: { name: who.name }, output: { name: who.name, company: who.company, title: who.title, group: who.group }, state: 'done' })
      lines.push(`${who.name}是${who.company || '未填公司'}的${who.title || '联系人'}。`)
    } else denied.push('查联系人')
  }
  const mk = /(?:建|新建|创建|记)(?:一个|一条)?任务[：:，,]?(.*)$/.exec(text)
  if (!mk && /任务|待办|todo|进度/.test(text)) {
    if (can('read_tasks')) {
      const open = ctx.tasks.filter((t) => isOpenTask(t.status))
      const top = [...open].sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 3)
      calls.push({ tool: 'read_tasks', input: { status: ['todo', 'doing', 'review'] }, output: { total: open.length, top: top.map((t) => `${t.ref} ${t.priority} ${t.title}`) }, state: 'done' })
      lines.push(`现在有 ${open.length} 条没完成的任务，最急的是：${top.map((t) => `${t.ref}「${t.title}」`).join('、')}。`)
    } else denied.push('查任务')
  }
  if (/消息|IM|未读|谁找/.test(text)) {
    if (can('read_messages')) {
      const pending = ctx.messages.filter((m) => m.status === 'pending')
      calls.push({ tool: 'read_messages', input: { status: 'pending' }, output: { total: pending.length, from: [...new Set(pending.map((m) => m.sender_name))].slice(0, 5) }, state: 'done' })
      lines.push(`有 ${pending.length} 条消息待处理，来自 ${[...new Set(pending.map((m) => m.sender_name))].slice(0, 4).join('、')} 等。`)
    } else denied.push('读 IM 消息')
  }
  if (mk) {
    if (can('write_tasks')) {
      const title = (mk[1] || text).replace(/^[，,：:\s]+/, '').slice(0, 40) || '新任务'
      calls.push({ tool: 'write_tasks', input: { title, priority: /紧急|马上|今天/.test(text) ? 'P1' : 'P2', assignee: '我' }, state: mode('write_tasks') })
      lines.push(agent.abilities.write_tasks === 'auto' ? `已建任务「${title}」。` : `我准备建一条任务「${title}」，确认后执行。`)
    } else denied.push('新建任务')
  }
  if (/回复|回一下|答复/.test(text) && who) {
    if (can('reply_message')) {
      const ch = Object.keys(who.im)[0] ?? 'wechat'
      calls.push({ tool: 'reply_message', input: { channel: ch, to: who.name, text: '收到，我确认后今天给你答复。' }, state: mode('reply_message') })
      lines.push('起草了一条回复，发之前请你确认。')
    } else denied.push('回复 IM 消息')
  }
  if (/SOP|流程|执行/.test(text)) {
    if (can('run_sop')) {
      const sop = ctx.sops.find((s) => text.includes(s.name.slice(0, 2))) ?? ctx.sops[0]
      if (sop) {
        calls.push({ tool: 'run_sop', input: { sop: sop.name, input: { 说明: text } }, state: mode('run_sop') })
        lines.push(`看起来适合用「${sop.name}」，确认后发起执行，流程里的人工检查点会照常停下。`)
      }
    } else denied.push('发起 SOP')
  }
  if (/周报|总结|汇总/.test(text)) {
    if (can('write_content')) {
      calls.push({ tool: 'write_content', input: { category: 'note', title: `周报草稿 ${new Date().toLocaleDateString('zh-CN')}` }, state: mode('write_content') })
      lines.push('周报草稿写好了，存进「文档 > 笔记」前请你确认。')
    } else denied.push('写文档')
  }

  if (denied.length) lines.push(`这件事要用到「${denied.join('、')}」，这个 Agent 没开这项权限，可以在左边「工具与权限」里打开。`)
  if (!lines.length) lines.push(`我是${agent.name || '这个 Agent'}。${agent.desc || ''}可以问我任务、消息、联系人，或者让我建任务、起草回复。`)
  return { text: lines.join('\n'), calls }
}

/** 对话面板：消息由外面管（会话要存下来，调试不存），工具调用按权限执行或等确认 */
export function ChatPane({ agent, msgs, onMsgs, ctx, onExecute, head, examples, placeholderNote, autoSend }: {
  /** 刚建的空会话自动发出去的第一句话（快速新建会话用） */
  autoSend?: string
  agent: Agent
  msgs: ChatMsg[]
  onMsgs: (f: (m: ChatMsg[]) => ChatMsg[]) => void
  ctx: Ctx
  onExecute: (call: ToolCall) => unknown
  head?: ReactNode
  examples?: string[]
  placeholderNote?: string
}) {
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const nextId = () => Math.max(0, ...msgs.map((m) => m.id)) + 1
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, thinking])

  const send = (t = text) => {
    if (!t.trim() || thinking) return
    const uid = nextId()
    onMsgs((m) => [...m, { id: uid, role: 'user', text: t.trim(), at: new Date().toISOString() }])
    setText('')
    setThinking(true)
    window.setTimeout(() => {
      const r = reply(agent, t, ctx)
      // 自动档的写操作直接执行，拿回真实输出
      const calls = r.calls.map((c) => (c.state === 'done' && abilityOf(c.tool).write ? { ...c, output: onExecute(c) } : c))
      onMsgs((m) => [...m, { id: uid + 1, role: 'agent', text: r.text, calls, at: new Date().toISOString() }])
      setThinking(false)
    }, 800)
  }
  // 只发一次：StrictMode 下 effect 会跑两遍，ref 挡住第二遍；已经有消息了也不发
  const autoSent = useRef(false)
  useEffect(() => {
    if (autoSend && !autoSent.current && msgs.length === 0) { autoSent.current = true; send(autoSend) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 执行放在 setState 外：更新函数在开发模式下会被调两次
  const settle = (mid: number, ci: number, ok: boolean) => {
    const call = msgs.find((x) => x.id === mid)?.calls?.[ci]
    if (!call || call.state !== 'pending') return
    const output = ok ? onExecute(call) : undefined
    onMsgs((m) => m.map((x) => (x.id !== mid ? x : {
      ...x, calls: x.calls!.map((c, i) => (i !== ci ? c : ok ? { ...c, state: 'confirmed' as const, output } : { ...c, state: 'rejected' as const })),
    })))
  }

  return (
    <div className="chat-pane">
      {head}
      <div className="ai-msgs" ref={listRef}>
        {!msgs.length && examples && (
          <div className="ai-examples">
            <div className="ai-examples-title">试着问它</div>
            {examples.map((e) => <button key={e} className="ai-example" onClick={() => send(e)}>{e}</button>)}
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={cls('ai-msg', m.role === 'user' ? 'ai-user' : 'ai-ai')}>
            {m.role === 'agent' && <AgentAvatar agent={agent} size={24} />}
            <div className="ai-bubble">
              {m.calls && m.calls.length > 0 && (
                <div className="call-list">{m.calls.map((c, i) => <CallCard key={i} call={c} onConfirm={() => settle(m.id, i, true)} onReject={() => settle(m.id, i, false)} />)}</div>
              )}
              <div className="pre-line">{m.text}</div>
            </div>
          </div>
        ))}
        {thinking && <div className="ai-msg ai-ai"><AgentAvatar agent={agent} size={24} /><div className="ai-bubble ai-typing"><span /><span /><span /></div></div>}
      </div>
      <div className="ai-input">
        <div className="ai-box">
          <textarea rows={2} value={text} placeholder={`和${agent.name || '这个 Agent'}对话…`} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
          <div className="ai-box-foot">
            <span className="field-hint-line">{placeholderNote ?? '⌘Enter 发送；写操作按权限停下来等你确认'}</span>
            <button className="act act-primary" disabled={!text.trim() || thinking || !agent.enabled} title={!agent.enabled ? 'Agent 已停用' : undefined} onClick={() => send()}>发送</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export const CHAT_EXAMPLES = ['我现在有哪些任务最急？', '梁晚晴找我了吗，帮我回复一下', '建一条任务：周五前整理演示环境', '这周的周报帮我汇总一下']

/** 配置页右边的调试：用当前（没保存的）配置对话，不存会话 */
function DebugChat({ agent, ctx, onExecute }: { agent: Agent; ctx: Ctx; onExecute: (call: ToolCall) => unknown }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  return (
    <aside className="agent-debug">
      <ChatPane agent={{ ...agent, enabled: true }} msgs={msgs} onMsgs={setMsgs} ctx={ctx} onExecute={onExecute} examples={CHAT_EXAMPLES}
        placeholderNote="调试对话不保存；产出照常落到数据上"
        head={(
          <div className="ai-head">
            <AgentAvatar agent={agent} size={22} />
            <span className="ai-title">调试</span>
            <span className="list-sub">用当前配置试一试，不留会话记录</span>
            <span className="spacer" />
            {msgs.length > 0 && <button className="act act-quiet" onClick={() => setMsgs([])}>清空</button>}
          </div>
        )} />
    </aside>
  )
}

/* ---------- 配置页 ---------- */

/** 「挂载」下拉：列出还没挂的项，选一个挂上 */
function MountPicker<T extends { id: string }>({ label, items, render, onPick, empty }: {
  label: string
  items: T[]
  render: (t: T) => ReactNode
  onPick: (id: string) => void
  empty: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="act" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="11" height="11"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        {label}
      </button>
      {open && (
        <div className="menu mount-menu">
          {items.length ? items.map((t) => (
            <button key={t.id} className="menu-item mount-item" onClick={() => { onPick(t.id); setOpen(false) }}>{render(t)}</button>
          )) : <div className="io-empty">{empty}</div>}
        </div>
      )}
    </div>
  )
}

export interface MountableConn { id: string; name: string; kind: string; ok: boolean; tools: ConnToolChoice[] }

export function AgentEditor({ agent, creating, ctx, folders, models, conns, kbs, skills, onBack, onSave, onDelete, onExecute, onCreateKb, onGoConnectors, delPlan }: {
  models: ModelChoice[]
  /** 可挂载的 MCP / 连接器（已经获取过工具清单的） */
  conns: MountableConn[]
  kbs: KnowledgeBase[]
  skills: Skill[]
  agent: Agent
  creating: boolean
  ctx: Ctx
  folders: string[]
  onBack: () => void
  onSave: (a: Agent) => void
  onDelete: () => void
  onExecute: (call: ToolCall) => unknown
  onCreateKb: (kb: KnowledgeBase) => void
  onGoConnectors: () => void
  /** 删除前算出的影响；block 有值时不能删 */
  delPlan?: { block?: string; impact: string[] }
}) {
  const [d, setD] = useState(agent)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [saved, setSaved] = useState(false)
  const [openConn, setOpenConn] = useState<string | null>(null)
  const [newKb, setNewKb] = useState<{ name: string; sources: string[] } | null>(null)
  const dirty = creating || JSON.stringify(d) !== JSON.stringify(agent)
  const groups = [...new Set(ABILITIES.map((a) => a.group))]
  const setMode = (k: string, m: AbilityMode) => setD({ ...d, abilities: { ...d.abilities, [k]: m } })
  const toggle = (key: 'skills' | 'mcps' | 'kbs', id: string) => setD({ ...d, [key]: d[key].includes(id) ? d[key].filter((x) => x !== id) : [...d[key], id] })
  // 卸下连接器时，它的工具权限一起清掉，免得以后重新挂上时带着旧权限
  const unmountConn = (id: string) => setD({ ...d, mcps: d.mcps.filter((x) => x !== id), abilities: Object.fromEntries(Object.entries(d.abilities).filter(([k]) => !k.startsWith(`conn:${id}:`))) })
  const mountConn = (id: string) => {
    const c = conns.find((x) => x.id === id)
    // 挂上时只读工具默认开、写工具默认关，写的要自己打开
    const defaults: Record<string, AbilityMode> = Object.fromEntries((c?.tools ?? []).map((t) => [t.key, t.write ? 'off' : 'auto']))
    setD({ ...d, mcps: [...d.mcps, id], abilities: { ...defaults, ...d.abilities } })
    setOpenConn(id)
  }
  const save = () => {
    setTried(true)
    if (!d.name.trim()) return
    onSave({ ...d, name: d.name.trim() })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }
  const autoWrites = ABILITIES.filter((a) => a.write && d.abilities[a.key] === 'auto')
  const mountedSkills = skills.filter((x) => d.skills.includes(x.id))
  const mountedConns = conns.filter((x) => d.mcps.includes(x.id))
  const mountedKbs = kbs.filter((x) => d.kbs.includes(x.id))
  const catEnum = useEnumView('content_category')
  const sourceLabel = (k: string) => (k.startsWith('dir:') ? `本地目录 · ${k.slice(4)}` : catEnum.label(k))
  const createKb = () => {
    if (!newKb?.name.trim() || !newKb.sources.length) return
    const kb: KnowledgeBase = { id: newId('kb'), name: newKb.name.trim(), desc: '', sources: newKb.sources, docs: 0, updated_at: new Date().toISOString() }
    onCreateKb(kb)
    setD({ ...d, kbs: [...d.kbs, kb.id] })
    setNewKb(null)
  }
  const x = (onClick: () => void, title: string) => (
    <button className="icon-btn icon-btn-sm" title={title} onClick={onClick}>
      <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </button>
  )

  return (
    <div className="agent-editor">
      <PageTitle parent="Agent" desc={d.desc} actions={<>
        {!creating && (confirmDel ? (
          <>
            <span className="danger-text">{delPlan?.block ? `不能删除：${delPlan.block}` : delPlan?.impact.length ? `删除后${delPlan.impact.join('；')}` : '删除后会话和执行记录保留'}</span>
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>{delPlan?.block ? '知道了' : '取消'}</button>
            {!delPlan?.block && <button className="btn btn-danger" onClick={onDelete}>删除</button>}
          </>
        ) : <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>)}
        <button className="btn btn-primary" disabled={!dirty} onClick={save}>{creating ? '创建' : saved ? '已保存' : dirty ? '保存' : '已保存'}</button>
      </>}>{creating ? '新建 Agent' : d.name || '未命名'}</PageTitle>
      <div className="agent-main">
        <div className="editor-head">
          <button className="btn btn-ghost" onClick={onBack}>
            <svg viewBox="0 0 16 16" width="13" height="13"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Agent
          </button>
          <span className="list-sub">会话、执行记录和产出结果在左侧「会话」菜单里看</span>
        </div>

        <div className="editor-body form agent-form">
          <div className="agent-ident">
            <AvatarEditor agent={d} onChange={(p) => setD({ ...d, ...p })} />
            <div className="agent-ident-fields">
              <input className={cls('editor-title', tried && !d.name.trim() && 'bad')} value={d.name} placeholder="Agent 名称，比如：消息分诊助手" onChange={(e) => setD({ ...d, name: e.target.value })} />
              <input className="agent-desc-input" value={d.desc} placeholder="一句话说明它负责什么" onChange={(e) => setD({ ...d, desc: e.target.value })} />
            </div>
          </div>

          <section className="hook-sec">
            <div className="field-group-title">模型</div>
            <div className="model-list">
              {models.filter((m) => m.ok || m.key === d.model).map((m) => (
                <label key={m.key} className={cls('model-opt', d.model === m.key && 'on', !m.ok && 'bad')}>
                  <input type="radio" checked={d.model === m.key} disabled={!m.ok} onChange={() => setD({ ...d, model: m.key })} />
                  <span><b>{m.label}</b><span className={cls('list-sub', !m.ok && 'danger-text')}>{m.note}</span></span>
                </label>
              ))}
            </div>
          </section>

          <section className="hook-sec">
            <div className="field-group-title">指令<span className="field-hint">告诉它是谁、负责什么、按什么规矩做事</span></div>
            <textarea className="json-area agent-prompt" rows={7} value={d.instructions} placeholder={'比如：\n你是产品经理的消息分诊助手。先确认发消息的人是谁，再判断要不要跟进……'} onChange={(e) => setD({ ...d, instructions: e.target.value })} />
          </section>

          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">技能<span className="field-hint">一段可复用的做事方法，挂上后 Agent 遇到对应的事就按它做</span></div>
              <MountPicker label="挂载技能" items={skills.filter((k) => !d.skills.includes(k.id))} empty="技能都挂上了"
                onPick={(id) => toggle('skills', id)}
                render={(k) => <span className="mount-text"><b>{k.name}</b><span className="list-sub">{k.desc}</span></span>} />
            </div>
            {mountedSkills.length ? (
              <div className="mount-list">
                {mountedSkills.map((k) => (
                  <div key={k.id} className="mount-card">
                    <span className="mount-icon skill-icon"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2 9.4 6.6 14 8 9.4 9.4 8 14 6.6 9.4 2 8 6.6 6.6Z" fill="currentColor" /></svg></span>
                    <span className="mount-text">
                      <span><b>{k.name}</b><span className="tag mount-src">{k.source}</span></span>
                      <span className="list-sub">{k.instructions}</span>
                      <span className="mount-uses">用到：{k.uses.join('、')}</span>
                    </span>
                    {x(() => toggle('skills', k.id), '卸下')}
                  </div>
                ))}
              </div>
            ) : <div className="mount-empty">还没挂技能</div>}
          </section>

          <section className="hook-sec">
            <div className="field-group-title">内置工具与权限<span className="field-hint">写操作建议「需确认」：Agent 只提出要做什么，你点确认才执行</span></div>
            <div className="ability-table">
              {groups.map((g) => (
                <div key={g} className="ability-group">
                  <div className="ability-group-name">{g}</div>
                  {ABILITIES.filter((a) => a.group === g).map((a) => {
                    const m = d.abilities[a.key] ?? 'off'
                    return (
                      <div key={a.key} className="ability-row">
                        <span className="ability-text">
                          <span>{a.label}{a.write && <span className="write-tag">写</span>}</span>
                          {a.desc && <span className="list-sub">{a.desc}</span>}
                        </span>
                        <div className="seg seg-sm">
                          {((a.write ? ['off', 'confirm', 'auto'] : ['off', 'auto']) as AbilityMode[]).map((v) => (
                            <button key={v} className={cls(m === v && 'on', v === 'auto' && a.write && m === v && 'risky')} onClick={() => setMode(a.key, v)}>{MODE_LABEL[v]}</button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            {autoWrites.length > 0 && <div className="banner banner-warn">{autoWrites.map((a) => `「${a.label}」`).join('')}设为自动：Agent 会直接执行，不再等你确认。</div>}
          </section>

          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">MCP 与连接器<span className="field-hint">挂上后可以用它的工具；权限不能比连接器那边更松</span></div>
              <MountPicker label="挂载" items={conns.filter((c) => !d.mcps.includes(c.id))} empty="没有更多可挂的。去「设置 / 连接器」接入并获取工具清单"
                onPick={mountConn}
                render={(c) => <span className="mount-text"><b>{c.name}</b><span className={cls('list-sub', !c.ok && 'danger-text')}>{c.kind} · {c.tools.length} 个可用工具{!c.ok && ' · 连接异常'}</span></span>} />
            </div>
            {mountedConns.length ? (
              <div className="mount-list">
                {mountedConns.map((c) => {
                  const on = c.tools.filter((t) => (d.abilities[t.key] ?? 'off') !== 'off').length
                  const open = openConn === c.id
                  return (
                    <div key={c.id} className={cls('mount-card mount-conn', open && 'open')}>
                      <div className="mount-conn-head">
                        <span className="mount-icon conn-icon"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M6 3v3M10 3v3M4.5 6h7v2.5a3.5 3.5 0 0 1-7 0ZM8 12v2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></span>
                        <button className="mount-text mount-toggle" onClick={() => setOpenConn(open ? null : c.id)}>
                          <span><b>{c.name}</b><span className="tag mount-src">{c.kind}</span></span>
                          <span className={cls('list-sub', !c.ok && 'danger-text')}>{c.ok ? `开了 ${on} / ${c.tools.length} 个工具` : '连接异常，调用会失败'}</span>
                        </button>
                        <button className="act act-quiet" onClick={() => setOpenConn(open ? null : c.id)}>{open ? '收起' : '工具权限'}</button>
                        {x(() => unmountConn(c.id), '卸下')}
                      </div>
                      {open && (
                        <div className="ability-table mount-tools">
                          {c.tools.map((t) => {
                            const m = d.abilities[t.key] ?? 'off'
                            const opts = ((t.write ? ['off', 'confirm', 'auto'] : ['off', 'auto']) as AbilityMode[]).filter((v) => RANK[v] <= RANK[t.connMode])
                            return (
                              <div key={t.key} className="ability-row">
                                <span className="ability-text">
                                  <span><code className="tool-fn">{t.name}</code>{t.write && <span className="write-tag">写</span>}</span>
                                  <span className="list-sub">{t.desc}{t.write && t.connMode === 'confirm' && ' · 连接器要求确认'}</span>
                                </span>
                                <div className="seg seg-sm">
                                  {opts.map((v) => <button key={v} className={cls(m === v && 'on', v === 'auto' && t.write && m === v && 'risky')} onClick={() => setMode(t.key, v)}>{MODE_LABEL[v]}</button>)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : <div className="mount-empty">还没挂 MCP 或连接器。<button className="link-btn" onClick={onGoConnectors}>去接入</button></div>}
          </section>

          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">知识库<span className="field-hint">回答和写作时会先在这些资料里找依据</span></div>
              <span className="spacer" />
              <button className="act act-quiet" onClick={() => setNewKb(newKb ? null : { name: '', sources: [] })}>新建知识库</button>
              <MountPicker label="挂载知识库" items={kbs.filter((k) => !d.kbs.includes(k.id))} empty="知识库都挂上了"
                onPick={(id) => toggle('kbs', id)}
                render={(k) => <span className="mount-text"><b>{k.name}</b><span className="list-sub">{k.sources.map(sourceLabel).join('、')} · {k.docs} 篇</span></span>} />
            </div>
            {newKb && (
              <div className="kb-new">
                <input value={newKb.name} placeholder="知识库名称，比如：竞品资料" onChange={(e) => setNewKb({ ...newKb, name: e.target.value })} />
                <div className="dep-list">
                  {[...catEnum.optionsWith().map((c) => c.key), ...folders.map((f) => `dir:${f}`)].map((k) => (
                    <label key={k} className={cls('dep-chip', newKb.sources.includes(k) && 'on')}>
                      <input type="checkbox" checked={newKb.sources.includes(k)} onChange={() => setNewKb({ ...newKb, sources: newKb.sources.includes(k) ? newKb.sources.filter((y) => y !== k) : [...newKb.sources, k] })} />{sourceLabel(k)}
                    </label>
                  ))}
                </div>
                <div className="act-row">
                  <button className="act act-primary" disabled={!newKb.name.trim() || !newKb.sources.length} onClick={createKb}>建好并挂上</button>
                  <button className="act act-quiet" onClick={() => setNewKb(null)}>取消</button>
                  {!folders.length && <span className="list-sub">在「文档」里选了本地目录后，本地目录也能当来源</span>}
                </div>
              </div>
            )}
            {mountedKbs.length ? (
              <div className="mount-list">
                {mountedKbs.map((k) => (
                  <div key={k.id} className="mount-card">
                    <span className="mount-icon kb-icon"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>
                    <span className="mount-text">
                      <b>{k.name}</b>
                      <span className="list-sub">{k.sources.map(sourceLabel).join('、')} · {k.docs} 篇 · {timeAgo(k.updated_at)}更新</span>
                    </span>
                    {x(() => toggle('kbs', k.id), '卸下')}
                  </div>
                ))}
              </div>
            ) : !newKb && <div className="mount-empty">还没挂知识库</div>}
          </section>

          <section className="hook-sec">
            <div className="field-group-title">触发方式</div>
            <div className="trigger-list">
              {d.triggers.map((t, i) => (
                <div key={i} className="field-line">
                  <select value={t.kind} onChange={(e) => setD({ ...d, triggers: d.triggers.map((y, j) => (j === i ? { ...y, kind: e.target.value as TriggerKind } : y)) })}>
                    {(Object.keys(TRIGGER_KIND) as TriggerKind[]).map((k) => <option key={k} value={k}>{TRIGGER_KIND[k]}</option>)}
                  </select>
                  {t.kind !== 'manual' && (
                    <input value={t.detail} placeholder={{ im: '哪些渠道、群还是私聊', schedule: '比如：每周五 16:00', task: '比如：标签含「Agent」的任务', manual: '' }[t.kind]}
                      onChange={(e) => setD({ ...d, triggers: d.triggers.map((y, j) => (j === i ? { ...y, detail: e.target.value } : y)) })} />
                  )}
                  {t.kind === 'manual' && <span className="list-sub agent-trigger-note">在「会话」里直接找它</span>}
                  <button className="act act-quiet" disabled={d.triggers.length < 2} onClick={() => setD({ ...d, triggers: d.triggers.filter((_, j) => j !== i) })}>删除</button>
                </div>
              ))}
              <button className="act act-quiet case-add" onClick={() => setD({ ...d, triggers: [...d.triggers, { kind: 'schedule', detail: '' }] })}>加一个触发方式</button>
            </div>
          </section>
        </div>
      </div>
      <DebugChat agent={d} ctx={ctx} onExecute={onExecute} />
    </div>
  )
}
