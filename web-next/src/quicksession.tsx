import { useEffect, useRef, useState } from 'react'
import type { Agent } from './agentdata'
import { AgentAvatar } from './agents'
import { SearchSelect } from './searchselect'
import { cls } from './ui'

// 快速新建会话：在任何页面按 ⌘J 或点侧栏按钮，挑个 Agent、可选挂到项目、写下第一句话，回车就开聊
// 第一句话会在会话里自动发出去，Agent 照常回复

export function QuickSession({ agents, projects, defaultAgent, defaultProject, onCreate, onClose }: {
  agents: Agent[]
  projects: { id: string; name: string }[]
  /** 上次用的 Agent */
  defaultAgent?: string
  /** 当前停在哪个项目里，就默认挂到它 */
  defaultProject?: string
  onCreate: (agentId: string, projectId: string | undefined, text: string) => void
  onClose: () => void
}) {
  const usable = agents.filter((a) => a.enabled)
  const [agent, setAgent] = useState(() => (usable.some((a) => a.id === defaultAgent) ? defaultAgent! : usable[0]?.id ?? ''))
  const [project, setProject] = useState(defaultProject ?? '')
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    // 下拉开着时 Esc 先关下拉，不关整个弹窗
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.ss-menu')) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const submit = () => { if (agent) onCreate(agent, project || undefined, text.trim()) }
  // 输入框里上下方向键不抢，用 Tab 之外的 ⌥↑↓ 切 Agent
  const cycle = (d: 1 | -1) => {
    const i = usable.findIndex((a) => a.id === agent)
    setAgent(usable[(i + d + usable.length) % usable.length]?.id ?? agent)
  }
  const cur = usable.find((a) => a.id === agent)
  // Agent 多时只露几个 chip（当前选中的一定在里面），其余在「更多」里搜
  const CHIPS = 7
  const chips = usable.length <= CHIPS + 1 ? usable : [...usable.slice(0, CHIPS).filter((a) => a.id !== agent), ...(cur ? [cur] : [])].slice(-CHIPS).sort((a, b) => usable.indexOf(a) - usable.indexOf(b))
  const rest = usable.filter((a) => !chips.includes(a))

  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-label="快速新建会话">
        <div className="qs-head">
          <b>新建会话</b>
          <span className="list-sub">{cur ? cur.desc : '没有可用的 Agent'}</span>
        </div>
        {usable.length ? (
          <>
            <div className="qs-agents">
              {chips.map((a) => (
                <button key={a.id} className={cls('qs-agent', a.id === agent && 'on')} onClick={() => { setAgent(a.id); ref.current?.focus() }} title={a.desc}>
                  <AgentAvatar agent={a} size={22} /><span className="ellipsis">{a.name}</span>
                </button>
              ))}
              {rest.length > 0 && (
                <SearchSelect value="" placeholder={`更多 Agent（${rest.length}）`} searchPlaceholder="搜 Agent" className="qs-more"
                  options={rest.map((a) => ({ value: a.id, label: a.name, hint: a.desc, icon: <AgentAvatar agent={a} size={16} /> }))}
                  onChange={(v) => { if (v) setAgent(v); ref.current?.focus() }} />
              )}
            </div>
            <textarea ref={ref} className="qs-input" rows={3} value={text} placeholder={`问 ${cur?.name ?? 'Agent'} 点什么；留空就只开一个空会话`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
                if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); cycle(e.key === 'ArrowDown' ? 1 : -1) }
              }} />
            <div className="qs-foot">
              <label className="qs-proj">
                <span className="list-sub">关联项目</span>
                <SearchSelect value={project} noneLabel="不关联" searchPlaceholder="搜项目" missingLabel={() => '已删除的项目'}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => { setProject(v); ref.current?.focus() }} />
              </label>
              <span className="spacer" />
              <span className="qs-keys"><kbd>Enter</kbd> 开始 <kbd>Shift Enter</kbd> 换行 <kbd>Option ↑↓</kbd> 换 Agent</span>
              <button className="btn btn-primary" disabled={!agent} onClick={submit}>{text.trim() ? '发送' : '开空会话'}</button>
            </div>
          </>
        ) : <div className="mount-empty">所有 Agent 都停用了，先到「设置 / Agent」里启用一个</div>}
      </div>
    </div>
  )
}
