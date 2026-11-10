// 选服务商和模型（新会话「更多」里的旧方式，SPEC-sessions-1.6；会话头部换模型，SPEC-sessions-1.46）：
// 服务商一列（停用的置灰），模型拉得到列表就从列表挑（当前默认模型一定在里面），拉不到就手填。
import { useState } from 'react'
import { useProviderModels, type AgentProvider } from '../../core/data'
import { Avatar, Input, SearchSelect, cls } from '../../core/ui'
import { avatarName } from '../../core/chat/chatModel'

export type ProviderModelState = {
  pid: string
  setPid: (pid: string) => void
  provider: AgentProvider | undefined
  model: string
  setModel: (model: string) => void
}

/**
 * 选择的状态：每个服务商各记一个模型，切回来还是刚才挑的；没挑过取服务商的默认模型。
 * init 给了就从它开始（头部换模型从当前用的开始），否则取默认的、启用的服务商
 */
export function useProviderModelState(providers: readonly AgentProvider[], init?: { pid: string; model: string }): ProviderModelState {
  const [pid, setPid] = useState(() => {
    if (init?.pid) return init.pid
    const usable = providers.filter((p) => p.enabled)
    return (usable.find((p) => p.is_default) ?? usable[0])?.id ?? ''
  })
  const [models, setModels] = useState<Record<string, string>>(() => (init?.pid ? { [init.pid]: init.model } : {}))
  const provider = providers.find((p) => p.id === pid)
  return {
    pid, setPid, provider,
    model: models[pid] ?? provider?.model ?? '',
    setModel: (m) => setModels((x) => ({ ...x, [pid]: m })),
  }
}

export function ProviderModelPicker({ providers, state, label = '用哪个服务商聊' }: {
  providers: readonly AgentProvider[]
  state: ProviderModelState
  label?: string
}) {
  const { pid, setPid, provider, model, setModel } = state
  const list = useProviderModels(pid, !!provider?.enabled)
  const modelOpts = [...new Set([...(provider?.model ? [provider.model] : []), ...(model ? [model] : []), ...(list.data ?? [])])]
    .map((m) => ({ value: m, label: m, hint: m === provider?.model ? '默认' : undefined }))

  return (
    <>
      <div className="menu-label">{label}</div>
      <div className="agent-pick-list" role="radiogroup" aria-label="服务商">
        {providers.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === pid} className={cls('menu-item', p.id === pid && 'on')}
            disabled={!p.enabled} onClick={() => setPid(p.id)}>
            <Avatar name={avatarName(p)} size={20} />
            <span className="ellipsis">{p.name || '未命名'}</span>
            <span className="list-sub">{p.enabled ? p.model || p.kind : '已停用'}</span>
          </button>
        ))}
        {!providers.length && <div className="io-empty">还没有服务商，先到「设置」里配一个</div>}
      </div>
      {provider?.enabled && (
        <label className="agent-pick-field agent-pick-model">
          <span className="list-sub">模型</span>
          {modelOpts.length > 1 ? (
            <SearchSelect variant="field" value={model} options={modelOpts} searchPlaceholder="搜模型" aria-label="模型"
              missingLabel={(v) => v} onChange={setModel} />
          ) : (
            <Input value={model} aria-label="模型" placeholder={list.isFetching ? '正在拉取模型列表' : '模型名'}
              onChange={(e) => setModel(e.target.value)} />
          )}
        </label>
      )}
    </>
  )
}
