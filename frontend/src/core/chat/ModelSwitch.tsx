// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话头部的模型（SPEC-sessions-1.46 到 1.49，TSK-0720）：显示这个会话实际用的「服务商 · 模型」，点了换。
// 挂 Agent 的会话：「跟随 Agent 默认」或「这个会话单独用」；单独用时可勾「同时设为 Agent 的默认模型」，要再确认一次。
// 只改这个会话，后续消息用新模型，会话里多一条「已切换到 X」；正在回复时不能换。
import { useState } from 'react'
import './chat.css'
import {
  errorText, usePatchAgent, useSwitchSessionModel, type Agent, type AgentProvider, type AgentSession,
} from '../data'
import { Button, Checkbox, cls } from '../ui'
import { modelLabel } from './chatModel'
import { ProviderModelPicker, useProviderModelState } from './ProviderModelPicker'

type Mode = 'follow' | 'custom'

export function ModelSwitch({ session, agent, providers, busy, readOnly }: {
  session: AgentSession
  /** 挂的 Agent（停用的也给）；不挂 Agent 的会话、Agent 已删除时为空 */
  agent?: Agent
  providers: readonly AgentProvider[]
  /** 正在回复：不能换 */
  busy: boolean
  /** Agent 已删除、服务商删了等只能回看的会话：只显示不能换 */
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const cur = modelLabel(session.provider_id, session.model, providers)
  const following = !!agent && !session.model_override
  return (
    <span className="model-switch-wrap">
      <button type="button" className={cls('chat-model', cur.disabled && 'warn', cur.gone && 'gone')} aria-expanded={open} aria-haspopup="dialog"
        disabled={readOnly}
        title={readOnly ? `用的模型：${cur.text}` : `这个会话用的模型${following ? '（跟随 Agent 默认）' : ''}；点一下换，只影响这个会话`}
        onClick={() => setOpen(!open)}>
        <span className="ellipsis">{cur.text}</span>
        {agent && <span className="chat-model-tag">{following ? '跟随 Agent' : '本会话'}</span>}
      </button>
      {open && !readOnly && (
        <ModelPanel session={session} agent={agent} providers={providers} busy={busy} onClose={() => setOpen(false)} />
      )}
    </span>
  )
}

function ModelPanel({ session, agent, providers, busy, onClose }: {
  session: AgentSession
  agent?: Agent
  providers: readonly AgentProvider[]
  busy: boolean
  onClose: () => void
}) {
  const [mode, setMode] = useState<Mode>(agent && !session.model_override ? 'follow' : 'custom')
  const choice = useProviderModelState(providers, { pid: session.provider_id, model: session.model })
  const [asDefault, setAsDefault] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const switchModel = useSwitchSessionModel()
  const patchAgent = usePatchAgent()
  const [err, setErr] = useState('')
  const working = switchModel.isPending || patchAgent.isPending

  const model = choice.model.trim()
  const target = modelLabel(choice.pid, model, providers)
  const agentDefault = agent ? modelLabel(agent.provider_id, agent.model, providers) : null
  // 和现在一样就不用换：跟随的还是跟随；单独用的服务商和模型都没变（跟随中挑了和默认一样的也算换：固定下来）
  const unchanged = mode === 'follow'
    ? !session.model_override
    : !!session.model_override === !!agent && choice.pid === session.provider_id && model === session.model && !asDefault
  const valid = mode === 'follow' || (!!choice.provider?.enabled && !!model)
  const blocked = busy ? '正在回复，等这一轮跑完再换模型' : ''

  const done = () => { setConfirming(false); onClose() }
  const submit = async () => {
    setErr('')
    if (mode === 'follow') {
      switchModel.mutate({ id: session.id, patch: { model_override: false } }, { onSuccess: done, onError: (e) => setErr(`没换成：${errorText(e)}`) })
      return
    }
    try {
      await switchModel.mutateAsync({ id: session.id, patch: { provider_id: choice.pid, model } })
    } catch (e) {
      setErr(`没换成：${errorText(e)}`)
      return
    }
    if (!asDefault || !agent) { done(); return }
    // 设为 Agent 默认：先改 Agent，再把这个会话改回跟随（这样以后 Agent 再改默认，这个会话也跟着）
    try {
      await patchAgent.mutateAsync({ id: agent.id, patch: { provider_id: choice.pid, model } })
    } catch (e) {
      setConfirming(false)
      setErr(`这个会话已经换好，但没设成「${agent.name || '未命名'}」的默认模型：${errorText(e)}`)
      return
    }
    try {
      await switchModel.mutateAsync({ id: session.id, patch: { model_override: false } })
    } catch (e) {
      setConfirming(false)
      setErr(`已设为 Agent 默认，但这个会话没改回跟随：${errorText(e)}`)
      return
    }
    done()
  }

  return (
    <div className="agent-pick model-panel" role="dialog" aria-label="换模型"
      onKeyDown={(e) => { if (e.key === 'Escape' && !document.querySelector('.ss-menu')) { e.stopPropagation(); onClose() } }}>
      {agent && (
        <div className="model-mode" role="radiogroup" aria-label="这个会话用哪个模型">
          <button type="button" role="radio" aria-checked={mode === 'follow'} className={cls('menu-item', mode === 'follow' && 'on')}
            onClick={() => { setMode('follow'); setAsDefault(false) }}>
            <span className="ellipsis">跟随 Agent 默认</span>
            <span className={cls('list-sub ellipsis', agentDefault?.disabled && 'danger-text')}>{agentDefault?.text}</span>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'custom'} className={cls('menu-item', mode === 'custom' && 'on')}
            onClick={() => setMode('custom')}>
            <span className="ellipsis">这个会话单独用</span>
            <span className="list-sub">Agent 改默认不影响它</span>
          </button>
        </div>
      )}
      {mode === 'custom' && (
        <>
          <ProviderModelPicker providers={providers} state={choice} label="换成哪个服务商和模型" />
          {agent && (
            <Checkbox className="model-default" checked={asDefault} disabled={working} onCheckedChange={(v) => { setAsDefault(v); setConfirming(false) }}>
              同时设为「{agent.name || '未命名'}」的默认模型
            </Checkbox>
          )}
        </>
      )}
      <div className="agent-pick-form model-foot">
        {confirming && agent ? (
          <div className="model-confirm" role="alert">
            <span>把「{agent.name || '未命名'}」的默认模型改成 {target.text}？跟随默认的会话、之后的触发执行都会用它</span>
            <div className="act-row">
              <Button size="sm" variant="primary" disabled={working || !!blocked} onClick={() => void submit()}>{working ? '正在改…' : '确定改'}</Button>
              <Button size="sm" disabled={working} onClick={() => setConfirming(false)}>取消</Button>
            </div>
          </div>
        ) : (
          <div className="act-row">
            <Button size="sm" variant="primary" disabled={working || !valid || unchanged || !!blocked} title={blocked || undefined}
              onClick={() => (asDefault && mode === 'custom' ? setConfirming(true) : void submit())}>
              {working ? '正在换…' : '切换'}
            </Button>
            <Button size="sm" disabled={working} onClick={onClose}>取消</Button>
            <span className="list-sub">{blocked || '只影响这个会话，之前的回复不变'}</span>
          </div>
        )}
        {err && <span className="field-err" role="alert">{err}</span>}
      </div>
    </div>
  )
}
