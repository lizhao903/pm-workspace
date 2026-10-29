import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  errorText, setFirstMessage, useAgentProviders, useAgents, useAgentSessions, useCreateAgentSession, type Agent, type AgentProvider,
  type AgentSessionInput,
} from '../data'
import { Avatar, Button, cls, SearchSelect } from '../ui'
import { AgentAvatar } from '../ui/AgentAvatar'
import { trapTab } from '../ui/focus'
import { chipsOf, lastUsedOf, pickDefault, usableAgent, usableProvider } from './quickSessionModel'

// 快速新建会话（照原型 web-next/src/quicksession.tsx，SPEC-sessions-4）：任何页面按 Cmd/Ctrl+J 或点侧栏按钮，
// 挑一个 Agent、写下第一句话，回车就开聊（AG-01b8）。不选 Agent、按服务商和默认模型开的旧方式收在「更多」里。
// 原型里的「关联项目」不做：挂到项目上的会话不在会话页的全局列表里，建完跳过去会看不到。

const providerAvatarName = (p: AgentProvider) => /[A-Za-z][\w-]*/.exec(p.name)?.[0] ?? (p.name || p.kind)

type Mode = 'agent' | 'provider'
type Choice = { id: string; name: string; hint: string; avatar: ReactNode }

export function QuickSession({ agents, providers, loading, loadError, lastAgent, lastProvider, busy, error, onCreate, onClose }: {
  agents: readonly Agent[]
  providers: readonly AgentProvider[]
  loading: { agents: boolean; providers: boolean }
  /** 没取到的原因 */
  loadError?: { agents?: string; providers?: string }
  /** 最近一次会话用的 Agent、服务商 */
  lastAgent?: string
  lastProvider?: string
  busy: boolean
  error?: string
  onCreate: (input: AgentSessionInput, text: string) => void
  onClose: () => void
}) {
  const usableA = agents.filter(usableAgent)
  // 没选过时：Agent 读完了却一个能用的都没有，直接落到服务商，免得一打开就是「没有可用的 Agent」
  const [chosen, setMode] = useState<Mode | null>(null)
  const noAgent = !loading.agents && !loadError?.agents && usableA.length === 0
  const mode: Mode = chosen ?? (noAgent ? 'provider' : 'agent')
  const isAgent = mode === 'agent'
  const usableP = providers.filter(usableProvider)
  const choices: Choice[] = isAgent
    ? usableA.map((a) => ({ id: a.id, name: a.name || '未命名', hint: a.desc, avatar: <AgentAvatar agent={a} size={22} /> }))
    : usableP.map((p) => ({ id: p.id, name: p.name || '未命名', hint: p.model, avatar: <Avatar name={providerAvatarName(p)} size={22} /> }))
  const [picked, setPicked] = useState<Record<Mode, string>>({ agent: '', provider: '' })
  const pid = choices.some((c) => c.id === picked[mode]) ? picked[mode]
    : isAgent ? pickDefault(usableA, lastAgent) : pickDefault(usableP, lastProvider)
  const cur = choices.find((c) => c.id === pid)
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => { prev?.focus?.() }
  }, [])
  const ready = cur !== undefined
  useEffect(() => { if (ready) ref.current?.focus() }, [ready, mode])
  useEffect(() => {
    // 下拉开着时 Esc 先关下拉，不关整个弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.ss-menu')) { e.preventDefault(); e.stopPropagation(); onClose() }
      else if (e.key === 'Tab' && boxRef.current) trapTab(boxRef.current, e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const submit = () => {
    if (!cur || busy) return
    if (isAgent) onCreate({ agent_id: cur.id }, text.trim())
    else onCreate({ provider_id: cur.id, model: usableP.find((p) => p.id === cur.id)?.model }, text.trim())
  }
  const pick = (id: string) => { setPicked((p) => ({ ...p, [mode]: id })); ref.current?.focus() }
  // 输入框里上下方向键不抢，用 Option/Alt 加上下切换
  const cycle = (d: 1 | -1) => {
    const i = choices.findIndex((c) => c.id === pid)
    const next = choices[(i + d + choices.length) % choices.length]
    if (next) setPicked((p) => ({ ...p, [mode]: next.id }))
  }
  const chips = chipsOf(choices, pid)
  const rest = choices.filter((c) => !chips.includes(c))
  const what = isAgent ? 'Agent' : '服务商'
  // 跟在中文后面时 Agent 前空一格
  const sp = isAgent ? ' Agent' : '服务商'

  let body
  const failed = isAgent ? loadError?.agents : loadError?.providers
  if (isAgent ? loading.agents : loading.providers) body = <div className="qs-empty">正在读{sp}</div>
  else if (failed) body = <div className="qs-empty">{isAgent ? 'Agent ' : '服务商'}没取到：{failed}</div>
  else if (!choices.length) {
    body = (
      <div className="qs-empty">
        {isAgent
          ? agents.length ? '所有 Agent 都停用了，先到「设置 / Agent」里启用一个' : '还没有 Agent，先到「设置 / Agent」里建一个'
          : providers.length ? '服务商都停用了或没设默认模型，先到「设置」里启用一个' : '还没有模型服务商，先到「设置」里配一个'}
      </div>
    )
  } else {
    body = (
      <>
        <div className="qs-agents" role="radiogroup" aria-label={isAgent ? '和哪个 Agent 聊' : '用哪个服务商聊'}>
          {chips.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={c.id === pid} className={cls('qs-agent', c.id === pid && 'on')}
              title={c.hint || undefined} onClick={() => pick(c.id)}>
              {c.avatar}<span className="ellipsis">{c.name}</span>
            </button>
          ))}
          {rest.length > 0 && (
            <SearchSelect value="" placeholder={`更多${sp}（${rest.length}）`} searchPlaceholder={`搜${sp}`} className="qs-more"
              options={rest.map((c) => ({ value: c.id, label: c.name, hint: c.hint }))}
              onChange={(v) => { if (v) pick(v) }} />
          )}
        </div>
        <textarea ref={ref} className="qs-input" rows={3} value={text} aria-label="第一句话"
          placeholder={`问 ${cur?.name || what} 点什么；留空就只开一个空会话`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); cycle(e.key === 'ArrowDown' ? 1 : -1) }
          }} />
        {error && <span className="field-err">建会话失败：{error}</span>}
      </>
    )
  }

  // 头部说明：Agent 的一句话说明，旧方式是服务商和模型（SPEC-sessions-4.2、4.9）
  const sub = cur ? (cur.hint ? cur.hint : cur.name) : `没有可用的${sp}`
  return createPortal(
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-modal="true" aria-label="快速新建会话" ref={boxRef}>
        <div className="qs-head">
          <b>新建会话</b>
          <span className="list-sub">{isAgent ? sub : cur ? `${cur.name} · ${cur.hint}` : sub}</span>
        </div>
        {!isAgent && noAgent && chosen === null && (
          <div className="qs-note">{agents.length ? 'Agent 都停用了' : '还没有 Agent'}，先直接用服务商聊；要固定指令和工具，到「设置 / Agent」里建一个</div>
        )}
        {body}
        <div className="qs-foot">
          <button type="button" className="qs-mode" onClick={() => setMode(isAgent ? 'provider' : 'agent')}>
            {isAgent ? '更多：不选 Agent，用服务商' : '改回选 Agent'}
          </button>
          <span className="qs-spacer" />
          {choices.length > 0 && (
            <>
              <span className="qs-keys"><kbd>Enter</kbd> 开始 <kbd>Shift Enter</kbd> 换行 <kbd>Option ↑↓</kbd> 换{sp}</span>
              <Button variant="primary" disabled={!cur || busy} onClick={submit}>{busy ? '正在建' : text.trim() ? '发送' : '开空会话'}</Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// 新会话的标题，和会话页一致：第一句话发出时会话页按它改成第一句话的开头
const NEW_TITLE = '新会话'

/** 外壳里挂的那一层：打开时才取 Agent、服务商和会话；建好后记下第一句话，交给 onOpen 跳到会话页 */
export function QuickSessionHost({ onOpen, onClose }: { onOpen: (sessionId: string) => void; onClose: () => void }) {
  const agents = useAgents()
  const providers = useAgentProviders()
  const sessions = useAgentSessions()
  const create = useCreateAgentSession()
  // 后端按 updated_at 倒序，最前面的就是最近聊过的
  const last = lastUsedOf(sessions.data ?? [])
  return (
    <QuickSession agents={agents.data ?? []} providers={providers.data ?? []}
      loading={{ agents: agents.isPending, providers: providers.isPending }}
      loadError={{
        agents: agents.isError ? errorText(agents.error) : undefined,
        providers: providers.isError ? errorText(providers.error) : undefined,
      }}
      lastAgent={last.agent} lastProvider={last.provider}
      busy={create.isPending} error={create.error ? errorText(create.error) : undefined}
      onClose={onClose}
      onCreate={(input, text) => create.mutate({ ...input, title: NEW_TITLE }, {
        onSuccess: (s) => {
          setFirstMessage(s.id, text)
          onOpen(s.id)
        },
      })} />
  )
}
