// 新会话面板（SPEC-sessions-1.6、1.7，SPEC-sessions-4 的第一句话）：会话还没有 Agent，
// 按契约用「服务商 + 模型」代替。选服务商（最近聊过的在前，停用的置灰），选模型，可选产物目录和第一句话。
import { useState } from 'react'
import {
  errorText, useProviderModels, useWorkdirCheck, workdirUsable, type AgentProvider, type AgentSessionInput,
} from '../../core/data'
import { Avatar, Button, Input, SearchSelect, Textarea, cls } from '../../core/ui'
import { avatarName } from './chatModel'

// 服务商多于这个数时出搜索框
const MANY = 6

export function NewSession({ providers, busy, error, onCreate, onClose }: {
  /** 已按最近聊过的排好 */
  providers: AgentProvider[]
  busy: boolean
  error?: unknown
  onCreate: (input: AgentSessionInput, firstMessage: string) => void
  onClose: () => void
}) {
  const usable = providers.filter((p) => p.enabled)
  const [pid, setPid] = useState(() => (usable.find((p) => p.is_default) ?? usable[0])?.id ?? '')
  const provider = providers.find((p) => p.id === pid)
  const [models, setModels] = useState<Record<string, string>>({})
  const model = models[pid] ?? provider?.model ?? ''
  const list = useProviderModels(pid)
  const [workdir, setWorkdir] = useState('')
  const wd = workdir.trim()
  const check = useWorkdirCheck(wd)
  const badDir = !!wd && !!check.data && !workdirUsable(check.data)
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const shown = kw ? providers.filter((p) => `${p.name} ${p.model} ${p.kind}`.toLowerCase().includes(kw)) : providers

  const ready = !!provider?.enabled && !!model.trim() && !badDir && !busy
  const submit = () => {
    if (!ready) return
    onCreate({ provider_id: pid, model: model.trim(), workdir: wd || undefined }, text.trim())
  }

  // 模型：拉得到列表就从列表挑（当前默认模型一定在里面），拉不到就手填
  const modelOpts = [...new Set([...(provider?.model ? [provider.model] : []), ...(list.data ?? [])])]
    .map((m) => ({ value: m, label: m }))

  return (
    <div className="agent-pick" role="dialog" aria-label="新会话"
      onKeyDown={(e) => { if (e.key === 'Escape' && !document.querySelector('.ss-menu')) { e.stopPropagation(); onClose() } }}>
      <div className="menu-label">用哪个服务商聊</div>
      {providers.length > MANY && (
        <div className="search search-sm agent-pick-search">
          <input autoFocus placeholder="搜服务商，最近聊过的在前" value={q} aria-label="搜服务商" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { const p = shown.find((x) => x.enabled); if (e.key === 'Enter' && p) setPid(p.id) }} />
        </div>
      )}
      <div className="agent-pick-list" role="radiogroup" aria-label="服务商">
        {shown.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === pid} className={cls('menu-item', p.id === pid && 'on')}
            disabled={!p.enabled} onClick={() => setPid(p.id)}>
            <Avatar name={avatarName(p)} size={20} />
            <span className="ellipsis">{p.name || '未命名'}</span>
            <span className="list-sub">{p.enabled ? p.model || p.kind : '已停用'}</span>
          </button>
        ))}
        {!shown.length && <div className="io-empty">{providers.length ? '没有匹配的服务商' : '还没有服务商，先到「设置」里配一个'}</div>}
      </div>
      {provider?.enabled && (
        <div className="agent-pick-form">
          <label className="agent-pick-field">
            <span className="list-sub">模型</span>
            {modelOpts.length > 1 ? (
              <SearchSelect variant="field" value={model} options={modelOpts} searchPlaceholder="搜模型" aria-label="模型"
                missingLabel={(v) => v} onChange={(v) => setModels((m) => ({ ...m, [pid]: v }))} />
            ) : (
              <Input value={model} aria-label="模型" placeholder={list.isFetching ? '正在拉取模型列表' : '模型名'}
                onChange={(e) => setModels((m) => ({ ...m, [pid]: e.target.value }))} />
            )}
          </label>
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
    </div>
  )
}
