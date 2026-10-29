import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorText, setFirstMessage, useAgentProviders, useAgentSessions, useCreateAgentSession, type AgentProvider } from '../data'
import { Avatar, Button, cls, SearchSelect } from '../ui'
import { trapTab } from '../ui/focus'
import { chipsOf, pickDefault, usableProvider } from './quickSessionModel'

// 快速新建会话（照原型 web-next/src/quicksession.tsx）：任何页面按 Cmd/Ctrl+J 或点侧栏按钮，挑一个服务商、写下第一句话，回车就开聊。
// 后端会话还没有 Agent，按会话页的约定用「服务商 + 默认模型」代替；原型里的「关联项目」不做：
// 挂到项目上的会话不在会话页的全局列表里，建完跳过去会看不到。要换模型、填产物目录去会话页的「新会话」

const avatarName = (p: AgentProvider) => /[A-Za-z][\w-]*/.exec(p.name)?.[0] ?? (p.name || p.kind)

export function QuickSession({ providers, loading, loadError, lastUsed, busy, error, onCreate, onClose }: {
  providers: readonly AgentProvider[]
  loading: boolean
  /** 服务商没取到的原因 */
  loadError?: string
  /** 最近一次会话用的服务商 */
  lastUsed?: string
  busy: boolean
  error?: string
  onCreate: (provider: AgentProvider, text: string) => void
  onClose: () => void
}) {
  const usable = providers.filter(usableProvider)
  const [picked, setPicked] = useState('')
  const pid = usable.some((p) => p.id === picked) ? picked : pickDefault(usable, lastUsed)
  const cur = usable.find((p) => p.id === pid)
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => { prev?.focus?.() }
  }, [])
  const ready = cur !== undefined
  useEffect(() => { if (ready) ref.current?.focus() }, [ready])
  useEffect(() => {
    // 下拉开着时 Esc 先关下拉，不关整个弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.ss-menu')) { e.preventDefault(); e.stopPropagation(); onClose() }
      else if (e.key === 'Tab' && boxRef.current) trapTab(boxRef.current, e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const submit = () => { if (cur && !busy) onCreate(cur, text.trim()) }
  const pick = (id: string) => { setPicked(id); ref.current?.focus() }
  // 输入框里上下方向键不抢，用 Option/Alt 加上下切服务商
  const cycle = (d: 1 | -1) => {
    const i = usable.findIndex((p) => p.id === pid)
    const next = usable[(i + d + usable.length) % usable.length]
    if (next) setPicked(next.id)
  }
  const chips = chipsOf(usable, pid)
  const rest = usable.filter((p) => !chips.includes(p))

  let body
  if (loading) body = <div className="qs-empty">正在读服务商</div>
  else if (loadError) body = <div className="qs-empty">服务商没取到：{loadError}</div>
  else if (!usable.length) {
    body = <div className="qs-empty">{providers.length ? '服务商都停用了或没设默认模型，先到「设置」里启用一个' : '还没有模型服务商，先到「设置」里配一个'}</div>
  } else {
    body = (
      <>
        <div className="qs-agents" role="radiogroup" aria-label="用哪个服务商聊">
          {chips.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === pid} className={cls('qs-agent', p.id === pid && 'on')}
              title={p.model} onClick={() => pick(p.id)}>
              <Avatar name={avatarName(p)} size={22} /><span className="ellipsis">{p.name || '未命名'}</span>
            </button>
          ))}
          {rest.length > 0 && (
            <SearchSelect value="" placeholder={`更多（${rest.length}）`} searchPlaceholder="搜服务商" className="qs-more"
              options={rest.map((p) => ({ value: p.id, label: p.name || '未命名', hint: p.model }))}
              onChange={(v) => { if (v) pick(v) }} />
          )}
        </div>
        <textarea ref={ref} className="qs-input" rows={3} value={text} aria-label="第一句话"
          placeholder={`问 ${cur?.name || 'Agent'} 点什么；留空就只开一个空会话`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); cycle(e.key === 'ArrowDown' ? 1 : -1) }
          }} />
        {error && <span className="field-err">建会话失败：{error}</span>}
        <div className="qs-foot">
          <span className="qs-keys"><kbd>Enter</kbd> 开始 <kbd>Shift Enter</kbd> 换行 <kbd>Option ↑↓</kbd> 换服务商</span>
          <span className="qs-spacer" />
          <Button variant="primary" disabled={!cur || busy} onClick={submit}>{busy ? '正在建' : text.trim() ? '发送' : '开空会话'}</Button>
        </div>
      </>
    )
  }

  return createPortal(
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-modal="true" aria-label="快速新建会话" ref={boxRef}>
        <div className="qs-head">
          <b>新建会话</b>
          <span className="list-sub">{cur ? `${cur.name || '未命名'} · ${cur.model}` : '没有可用的服务商'}</span>
        </div>
        {body}
      </div>
    </div>,
    document.body,
  )
}

// 新会话的标题，和会话页一致：第一句话发出时会话页按它改成第一句话的开头
const NEW_TITLE = '新会话'

/** 外壳里挂的那一层：打开时才取服务商和会话；建好后记下第一句话，交给 onOpen 跳到会话页 */
export function QuickSessionHost({ onOpen, onClose }: { onOpen: (sessionId: string) => void; onClose: () => void }) {
  const providers = useAgentProviders()
  const sessions = useAgentSessions()
  const create = useCreateAgentSession()
  // 后端按 updated_at 倒序，第一条就是最近聊过的
  const lastUsed = sessions.data?.[0]?.provider_id
  return (
    <QuickSession providers={providers.data ?? []} loading={providers.isPending} lastUsed={lastUsed}
      loadError={providers.isError ? errorText(providers.error) : undefined}
      busy={create.isPending} error={create.error ? errorText(create.error) : undefined}
      onClose={onClose}
      onCreate={(p, text) => create.mutate({ provider_id: p.id, model: p.model, title: NEW_TITLE }, {
        onSuccess: (s) => {
          setFirstMessage(s.id, text)
          onOpen(s.id)
        },
      })} />
  )
}
