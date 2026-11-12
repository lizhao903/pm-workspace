// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 新会话面板（SPEC-sessions-1.6、1.7）：「和哪个 Agent 聊」，最近聊过的在前，停用的置灰；点一个就建会话并打开。
// 默认跟随 Agent 的默认模型；勾「这次指定模型」先选服务商和模型，再点 Agent，会话一开始就单独用它（同会话里换模型）。
// 不选 Agent、按「服务商 + 模型」开的旧方式收在「更多」里（AG-01b8），可选产物目录和第一句话。
import { useState } from 'react'
import {
  errorText, useWorkdirCheck, workdirUsable, type Agent, type AgentProvider, type AgentSessionInput,
} from '../../core/data'
import { Button, Checkbox, Input, Textarea } from '../../core/ui'
import { AgentAvatar } from '../../core/ui/AgentAvatar'
import { ProviderModelPicker, useProviderModelState } from '../../core/chat/ProviderModelPicker'

// 多于这个数时出搜索框
const MANY = 6

export function NewSession({ agents, agentsLoading, providers, busy, error, onCreate, onClose }: {
  /** 已按最近聊过的排好 */
  agents: Agent[]
  agentsLoading?: boolean
  /** 已按最近聊过的排好 */
  providers: AgentProvider[]
  busy: boolean
  error?: unknown
  onCreate: (input: AgentSessionInput, firstMessage: string) => void
  onClose: () => void
}) {
  // 没有能用的 Agent 时默认展开服务商方式，不让人先撞上空列表
  const [moreSel, setMore] = useState<boolean | null>(null)
  const more = moreSel ?? (!agentsLoading && !agents.some((a) => a.enabled))
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const shown = kw ? agents.filter((a) => `${a.name} ${a.desc}`.toLowerCase().includes(kw)) : agents
  const [pickModel, setPickModel] = useState(false)
  const choice = useProviderModelState(providers)
  const modelOk = !pickModel || (!!choice.provider?.enabled && !!choice.model.trim())
  const pick = (a: Agent) => {
    if (!a.enabled || busy || !modelOk) return
    onCreate(pickModel ? { agent_id: a.id, provider_id: choice.pid, model: choice.model.trim() } : { agent_id: a.id }, '')
  }

  return (
    <div className="agent-pick" role="dialog" aria-label="新会话"
      onKeyDown={(e) => { if (e.key === 'Escape' && !document.querySelector('.ss-menu')) { e.stopPropagation(); onClose() } }}>
      <div className="menu-label">和哪个 Agent 聊</div>
      <Checkbox className="ns-model-check" checked={pickModel} onCheckedChange={setPickModel}>这次指定模型（不跟 Agent 的默认模型）</Checkbox>
      {pickModel && (
        <div className="agent-pick-modelbox">
          <ProviderModelPicker providers={providers} state={choice} label="用哪个模型" />
          {!modelOk && <span className="list-sub">先选一个能用的服务商和模型，再点下面的 Agent</span>}
        </div>
      )}
      {agents.length > MANY && (
        <div className="search search-sm agent-pick-search">
          <input autoFocus placeholder="搜 Agent，最近聊过的在前" value={q} aria-label="搜 Agent" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { const a = shown.find((x) => x.enabled); if (e.key === 'Enter' && a) pick(a) }} />
        </div>
      )}
      <div className="agent-pick-list" aria-label="Agent">
        {shown.map((a) => (
          <button key={a.id} type="button" className="menu-item" disabled={!a.enabled || busy || !modelOk} title={a.desc || undefined} onClick={() => pick(a)}>
            <AgentAvatar agent={a} size={20} />
            <span className="ellipsis">{a.name || '未命名'}</span>
            {!a.enabled && <span className="list-sub">已停用</span>}
          </button>
        ))}
        {!shown.length && (
          <div className="io-empty">
            {agentsLoading ? '正在读 Agent' : agents.length ? '没有匹配的 Agent' : '还没有 Agent，先到「设置 / Agent」里建一个'}
          </div>
        )}
      </div>
      {!more && error !== undefined && error !== null && <span className="field-err">建会话失败：{errorText(error)}</span>}
      <button type="button" className="link-btn link-muted agent-pick-more" aria-expanded={more} onClick={() => setMore(!more)}>
        {more ? '收起' : '更多：不选 Agent，直接用服务商和模型'}
      </button>
      {more && <ProviderForm providers={providers} busy={busy} error={error} onCreate={onCreate} onClose={onClose} />}
    </div>
  )
}

/** 旧方式：选服务商（停用的置灰）、模型，可选产物目录和第一句话；服务商和模型的选择和头部换模型共用 ProviderModelPicker */
function ProviderForm({ providers, busy, error, onCreate, onClose }: {
  providers: AgentProvider[]
  busy: boolean
  error?: unknown
  onCreate: (input: AgentSessionInput, firstMessage: string) => void
  onClose: () => void
}) {
  const choice = useProviderModelState(providers)
  const { pid, provider, model } = choice
  const [workdir, setWorkdir] = useState('')
  const wd = workdir.trim()
  const check = useWorkdirCheck(wd)
  const badDir = !!wd && !!check.data && !workdirUsable(check.data)
  const [text, setText] = useState('')

  const ready = !!provider?.enabled && !!model.trim() && !badDir && !busy
  const submit = () => {
    if (!ready) return
    onCreate({ provider_id: pid, model: model.trim(), workdir: wd || undefined }, text.trim())
  }

  return (
    <>
      <ProviderModelPicker providers={providers} state={choice} />
      {provider?.enabled && (
        <div className="agent-pick-form">
          <label className="agent-pick-field">
            <span className="list-sub">产物目录（可选，Agent 写的文件落在这里）</span>
            <Input className="mono-input" value={workdir} invalid={badDir} aria-label="产物目录" placeholder="本机绝对路径"
              onChange={(e) => setWorkdir(e.target.value)} />
            {badDir && <span className="field-err">{check.data?.message || '这个目录不能用'}</span>}
          </label>
          <Textarea rows={2} value={text} aria-label="第一句话" placeholder="第一句话；留空就只开一个空会话"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
          {error !== undefined && error !== null && <span className="field-err">建会话失败：{errorText(error)}</span>}
          <div className="act-row">
            <Button variant="primary" size="sm" disabled={!ready} onClick={submit}>{busy ? '正在建' : text.trim() ? '发送' : '开空会话'}</Button>
            <Button size="sm" onClick={onClose}>取消</Button>
            <span className="list-sub">Enter 开始，Shift Enter 换行</span>
          </div>
        </div>
      )}
    </>
  )
}
