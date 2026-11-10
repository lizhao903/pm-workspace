// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交给执行弹窗里的「服务商」「模型」两格（TSK-0460 起交给工作台 Agent 用，TSK-0722 交给 DeepSeek 共用）：
// 服务商一个下拉（第一项是「按 … 设置 / 默认」），模型可手填，候选是这个服务商设置的、手录的和测出来的模型。
// 只改这一次用的，不改 Agent 和服务商的设置。
import { useId } from 'react'
import { providerModelIds, useProviderModels, type AgentProvider } from '../../core/data'
import { Field, Input, Select } from '../../core/ui'

export function ProviderModelFields({ options, providerId, onProvider, model, onModel, provider, placeholder }: {
  /** 下拉选项，第一项空值是「不指定」 */
  options: { value: string; label: string }[]
  providerId: string
  onProvider: (id: string) => void
  model: string
  onModel: (m: string) => void
  /** 这次实际会用的服务商（选了的，或不指定时默认的那个），模型候选按它列 */
  provider: AgentProvider | undefined
  /** 模型没填时的占位：会用哪个模型 */
  placeholder: string
}) {
  const id = useId()
  const tested = useProviderModels(provider?.id ?? '', !!provider)
  const modelIds = provider ? [...new Set([...providerModelIds(provider), ...(tested.data ?? [])])] : []
  return (
    <div className="ho-row">
      <Field label="服务商">
        <Select aria-label="服务商" value={providerId} onValueChange={(v) => { onProvider(v); onModel('') }} options={options} />
      </Field>
      <Field label="模型">
        <Input aria-label="模型" list={`${id}-models`} value={model} placeholder={placeholder} onChange={(e) => onModel(e.target.value)} />
        <datalist id={`${id}-models`}>{modelIds.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
    </div>
  )
}
