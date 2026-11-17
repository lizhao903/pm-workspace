// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话里看和换模型（TSK-0720，SPEC-sessions-1.46 到 1.50）。正式产品 frontend/src/core/chat/ModelSwitch.tsx、ProviderModelPicker.tsx。
// 挂 Agent 的会话默认跟随 Agent 当前的默认模型；在头部点模型按钮展开面板，选「这个会话单独用」再挑服务商和模型；
// 可同时设为 Agent 的默认（先确认）。正在回复时不能换。切换后对话里插一行提示，只给人看。
import { useState } from 'react'
import type { Session } from './agentdata'
import { cls } from './ui'
import './sessionmodel.css'

/** 能选的模型：服务商停用、连接异常、模型没启用的置灰（ok 为假，why 写原因） */
export type ModelOpt = { key: string; model: string; provider: string; ok: boolean; why?: string; gone?: boolean }

export type SessionModels = {
  options: ModelOpt[]
  /** Agent 当前的默认模型 id；Agent 删了为 undefined */
  agentDefault: (agentId: string) => string | undefined
  agentName: (agentId: string) => string | undefined
  /** 改会话的模型：override 为假是改回跟随 Agent 默认 */
  onSetSession: (sessionId: string, p: { model?: string; model_override: boolean }, notice?: string) => void
  /** 同时设为 Agent 默认（PATCH /api/agents/{id}）；回错误原因，成功回空串 */
  onSetAgentDefault: (agentId: string, model: string) => string
}

/** 「服务商 · 模型」；服务商停用的后面写「（已停用）」，删了写「已删除的服务商 · 模型」 */
export function modelText(opts: ModelOpt[], key?: string): { text: string; bad: boolean } {
  if (!key) return { text: '没设模型', bad: true }
  const o = opts.find((x) => x.key === key)
  if (!o || o.gone) return { text: `已删除的服务商 · ${o?.model ?? key}`, bad: true }
  return { text: `${o.provider} · ${o.model}${o.ok ? '' : '（已停用）'}`, bad: !o.ok }
}

/** 这个会话实际用的模型：单独换过的是会话自己的，否则 Agent 当前的；Agent 删了按会话最后记下的 */
export const effectiveModel = (s: Session, ms: SessionModels) => (s.model_override ? s.model : ms.agentDefault(s.agent_id) ?? s.model)

export function ModelSwitch({ session, models, busy, gone }: {
  session: Session
  models: SessionModels
  /** 正在回复 */
  busy: boolean
  /** Agent 已删除：只显示不能点 */
  gone: boolean
}) {
  const [open, setOpen] = useState(false)
  const cur = effectiveModel(session, models)
  const label = modelText(models.options, cur)
  const def = models.agentDefault(session.agent_id)
  const agentName = models.agentName(session.agent_id) ?? 'Agent'
  const providerGone = !!cur && !models.options.find((o) => o.key === cur && !o.gone)
  const locked = gone || providerGone
  const [follow, setFollow] = useState(!session.model_override)
  const [pick, setPick] = useState(cur ?? '')
  const [asDefault, setAsDefault] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [err, setErr] = useState('')
  const reset = () => { setFollow(!session.model_override); setPick(cur ?? ''); setAsDefault(false); setConfirming(false); setErr('') }
  const target = follow ? def : pick
  const same = follow ? !session.model_override : !!session.model_override && pick === session.model
  const pickOk = follow || !!models.options.find((o) => o.key === pick && o.ok)
  const providers = [...new Set(models.options.filter((o) => !o.gone).map((o) => o.provider))]

  const apply = () => {
    if (busy || same || !pickOk) return
    if (asDefault && !follow && !confirming) { setConfirming(true); return }
    const t = modelText(models.options, target).text
    // 只把跟随中的会话固定到和 Agent 默认一样的模型时不插提示
    const quiet = !session.model_override && !follow && pick === def
    models.onSetSession(session.id, follow ? { model_override: false } : { model: pick, model_override: true },
      quiet ? undefined : `已切换到 ${t}${follow ? '（跟随 Agent 默认）' : ''}，之后的回复用它，之前的回复不变`)
    if (asDefault && !follow) {
      const e = models.onSetAgentDefault(session.agent_id, pick)
      if (e) { setErr(`这个会话已经换好，但没设成「${agentName}」的默认模型：${e}`); setConfirming(false); return }
      models.onSetSession(session.id, { model_override: false })
    }
    setOpen(false)
  }

  return (
    <span className="ms-wrap">
      <button type="button" className={cls('ms-btn', label.bad && 'ms-bad')} disabled={locked} aria-expanded={open}
        title={locked ? '这个会话用的模型（只能回看）' : `这个会话用的模型（${session.model_override ? '本会话单独设的' : '跟随 Agent 默认'}）；点一下换，只影响这个会话`}
        onClick={() => { reset(); setOpen(!open) }}>
        <span className="ellipsis">{label.text}</span>
        {!gone && <span className="ms-tag">{session.model_override ? '本会话' : '跟随 Agent'}</span>}
      </button>
      {open && (
        <div className="ms-panel" role="dialog" aria-label="换模型" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}>
          <label className="ms-opt"><input type="radio" checked={follow} onChange={() => setFollow(true)} />
            <span>跟随 Agent 默认</span><span className="spacer" /><span className="muted ellipsis">{modelText(models.options, def).text}</span></label>
          <label className="ms-opt"><input type="radio" checked={!follow} onChange={() => setFollow(false)} />
            <span>这个会话单独用</span><span className="spacer" /><span className="muted">Agent 改默认不影响它</span></label>
          {!follow && (
            <div className="ms-pick">
              {providers.map((p) => (
                <div key={p} className="ms-group">
                  <div className="menu-label">{p}</div>
                  {models.options.filter((o) => o.provider === p && !o.gone).map((o) => (
                    <button key={o.key} type="button" className={cls('menu-item', pick === o.key && 'on')} disabled={!o.ok} title={o.why}
                      onClick={() => setPick(o.key)}>
                      <span className="ellipsis">{o.model}</span>{o.key === def && <span className="ms-tag">默认</span>}
                      <span className="spacer" />{!o.ok && <span className="muted">{o.why}</span>}
                    </button>
                  ))}
                </div>
              ))}
              <label className="ms-check"><input type="checkbox" checked={asDefault} onChange={(e) => { setAsDefault(e.target.checked); setConfirming(false) }} />同时设为「{agentName}」的默认模型</label>
            </div>
          )}
          {confirming && (
            <div className="ms-confirm">
              把「{agentName}」的默认模型改成 {modelText(models.options, pick).text}？跟随默认的会话、之后的触发执行都会用它
            </div>
          )}
          {err && <div className="ms-err" role="alert">{err}</div>}
          <div className="ms-foot">
            <span className="muted">{busy ? '正在回复，等这一轮跑完再换模型' : '只影响这个会话，之前的回复不变'}</span>
            <span className="spacer" />
            <button type="button" className="act act-quiet" onClick={() => (confirming ? setConfirming(false) : setOpen(false))}>取消</button>
            <button type="button" className="act act-primary" disabled={busy || same || !pickOk} onClick={apply}>{confirming ? '确定改' : '切换'}</button>
          </div>
        </div>
      )}
    </span>
  )
}
