// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 服务商目录，照原型 web-next/src/modeldata.ts PROVIDER_KINDS 抄过来，多了一列 api：前端类型到后端协议的对应。
// 对应关系见 docs/api-contract.md「Agent 供应商」：kind 是协议，兼容 OpenAI 的厂商用 kind=openai 加 extra.preset（取前端类型名）。
// 后端只给 deepseek 补默认地址，其余兼容厂商的接口地址必填，新建时预填官方地址。
// Azure、Bedrock 的鉴权方式后端还没接，api 为 null，卡片上写「暂未支持」。
import type { AgentProvider, ProviderProtocol } from '../../../core/data'

export const PROVIDER_GROUPS = ['国际', '国内', '聚合网关', '本地与自部署', '自定义'] as const
export type ProviderGroup = (typeof PROVIDER_GROUPS)[number]

export type Cap = 'tools' | 'vision' | 'reasoning' | 'fast' | 'local'
export const CAP_LABEL: Record<Cap, string> = { tools: '工具调用', vision: '看图', reasoning: '深度推理', fast: '快', local: '本地' }

/** context 单位 K；price 是每百万 token 的输入、输出美元价 */
export type CatalogModel = { id: string; name: string; context?: number; caps: Cap[]; price?: [number, number] }

/** api_key 存保险箱；base_url 是后端字段；model_ids 是手填的模型 ID，存 extra.model_ids */
export type FieldKey = 'api_key' | 'base_url' | 'model_ids'
export type ProviderField = { key: FieldKey; label: string; secret?: boolean; placeholder?: string; required?: boolean; hint?: string }

export type ProviderKindDef = {
  kind: string
  group: ProviderGroup
  label: string
  short: string
  color: string
  desc: string
  fields: ProviderField[]
  catalog: CatalogModel[]
  /** 后端协议；null 是后端还没接入 */
  api: { kind: ProviderProtocol; preset?: string } | null
  /** 新建时预填的接口地址（后端不会替它补默认值的那些） */
  prefill?: string
}

// 后端除 Ollama 外都要求有 API Key，本地服务没设 Key 时也得填一个
const key = (placeholder?: string): ProviderField => ({ key: 'api_key', label: 'API Key', secret: true, required: true, placeholder })
const localKey: ProviderField = { key: 'api_key', label: 'API Key', secret: true, required: true, placeholder: '没设 Key 时随便填一个', hint: '后端要求必填' }
// 官方地址后端会补，留空即可
const officialBase = (placeholder: string): ProviderField => ({ key: 'base_url', label: '接口地址', placeholder, hint: '留空用官方地址；走代理或网关时再填' })
const base = (placeholder: string): ProviderField => ({ key: 'base_url', label: '接口地址', placeholder, required: true })
const modelIds = (label = '模型 ID', placeholder = '多个用逗号隔开'): ProviderField => ({ key: 'model_ids', label, placeholder, required: true })
const compat = (kind: string, address: string) => ({ api: { kind: 'openai' as const, preset: kind }, prefill: address })

export const PROVIDER_KINDS: ProviderKindDef[] = [
  {
    kind: 'anthropic', group: '国际', label: 'Anthropic', short: 'A', color: '#c96442', desc: 'Claude 系列模型',
    fields: [key('sk-ant-...'), officialBase('https://api.anthropic.com')],
    catalog: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', context: 200, caps: ['tools', 'vision', 'reasoning'], price: [15, 75] },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200, caps: ['tools', 'vision', 'reasoning'], price: [3, 15] },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 200, caps: ['tools', 'vision', 'fast'], price: [1, 5] },
    ],
    api: { kind: 'anthropic' },
  },
  {
    kind: 'openai', group: '国际', label: 'OpenAI', short: 'O', color: '#10a37f', desc: 'GPT 系列模型',
    fields: [key('sk-...'), officialBase('https://api.openai.com/v1')],
    catalog: [
      { id: 'gpt-5', name: 'GPT-5', context: 400, caps: ['tools', 'vision', 'reasoning'], price: [1.25, 10] },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', context: 400, caps: ['tools', 'vision', 'fast'], price: [0.25, 2] },
    ],
    api: { kind: 'openai' },
  },
  {
    kind: 'azure', group: '国际', label: 'Azure OpenAI', short: 'Az', color: '#0078d4', desc: '企业账号里部署的 OpenAI 模型',
    fields: [], catalog: [], api: null,
  },
  {
    kind: 'bedrock', group: '国际', label: 'AWS Bedrock', short: 'B', color: '#ff9900', desc: '通过 AWS 账号调用 Claude 等模型',
    fields: [], catalog: [], api: null,
  },
  {
    kind: 'gemini', group: '国际', label: 'Google Gemini', short: 'G', color: '#4285f4', desc: 'Gemini 系列，长上下文',
    fields: [key('AIza...'), officialBase('https://generativelanguage.googleapis.com/v1beta')],
    catalog: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1000, caps: ['tools', 'vision', 'reasoning'] },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1000, caps: ['tools', 'vision', 'fast'] },
    ],
    api: { kind: 'gemini' },
  },
  {
    kind: 'mistral', group: '国际', label: 'Mistral', short: 'M', color: '#fa520f', desc: '',
    fields: [key(), base('https://api.mistral.ai/v1')],
    catalog: [{ id: 'mistral-large-latest', name: 'Mistral Large', context: 128, caps: ['tools'] }, { id: 'mistral-small-latest', name: 'Mistral Small', context: 128, caps: ['tools', 'fast'] }],
    ...compat('mistral', 'https://api.mistral.ai/v1'),
  },
  {
    kind: 'xai', group: '国际', label: 'xAI', short: 'x', color: '#111', desc: 'Grok 系列',
    fields: [key('xai-...'), base('https://api.x.ai/v1')],
    catalog: [{ id: 'grok-4', name: 'Grok 4', context: 256, caps: ['tools', 'vision', 'reasoning'] }],
    ...compat('xai', 'https://api.x.ai/v1'),
  },
  {
    kind: 'deepseek', group: '国内', label: 'DeepSeek', short: 'D', color: '#4d6bfe', desc: '',
    fields: [key(), officialBase('https://api.deepseek.com')],
    catalog: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', context: 128, caps: ['tools', 'fast'], price: [0.27, 1.1] },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', context: 128, caps: ['reasoning'], price: [0.55, 2.19] },
    ],
    api: { kind: 'openai', preset: 'deepseek' },
  },
  {
    kind: 'qwen', group: '国内', label: '阿里云百炼（通义千问）', short: '通', color: '#615ced', desc: '通义千问系列，DashScope 接口',
    fields: [key('sk-...'), base('https://dashscope.aliyuncs.com/compatible-mode/v1')],
    catalog: [
      { id: 'qwen-max', name: '通义千问 Max', context: 32, caps: ['tools'] },
      { id: 'qwen-plus', name: '通义千问 Plus', context: 128, caps: ['tools'] },
      { id: 'qwen-turbo', name: '通义千问 Turbo', context: 1000, caps: ['tools', 'fast'] },
      { id: 'qwen-vl-max', name: '通义千问 VL Max', context: 32, caps: ['vision'] },
    ],
    ...compat('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
  },
  {
    kind: 'zhipu', group: '国内', label: '智谱 AI', short: '智', color: '#3b5bdb', desc: 'GLM 系列',
    fields: [key(), base('https://open.bigmodel.cn/api/paas/v4')],
    catalog: [{ id: 'glm-4.5', name: 'GLM-4.5', context: 128, caps: ['tools', 'reasoning'] }, { id: 'glm-4.5-air', name: 'GLM-4.5 Air', context: 128, caps: ['tools', 'fast'] }],
    ...compat('zhipu', 'https://open.bigmodel.cn/api/paas/v4'),
  },
  {
    kind: 'moonshot', group: '国内', label: '月之暗面（Kimi）', short: 'K', color: '#16191e', desc: 'Kimi 系列，长文本',
    fields: [key('sk-...'), base('https://api.moonshot.cn/v1')],
    catalog: [{ id: 'kimi-k2', name: 'Kimi K2', context: 128, caps: ['tools'] }],
    ...compat('moonshot', 'https://api.moonshot.cn/v1'),
  },
  {
    kind: 'doubao', group: '国内', label: '火山方舟（豆包）', short: '豆', color: '#1664ff', desc: '豆包系列，按接入点调用',
    fields: [key(), base('https://ark.cn-beijing.volces.com/api/v3'), { ...modelIds('接入点 ID', 'ep-2025...'), hint: '在火山方舟控制台创建接入点后拿到' }],
    catalog: [],
    ...compat('doubao', 'https://ark.cn-beijing.volces.com/api/v3'),
  },
  {
    kind: 'qianfan', group: '国内', label: '百度千帆（文心）', short: '文', color: '#2932e1', desc: '文心系列',
    fields: [key(), base('https://qianfan.baidubce.com/v2')],
    catalog: [{ id: 'ernie-4.5', name: '文心 4.5', context: 128, caps: ['tools', 'vision'] }, { id: 'ernie-speed', name: '文心 Speed', context: 128, caps: ['fast'] }],
    ...compat('qianfan', 'https://qianfan.baidubce.com/v2'),
  },
  {
    kind: 'hunyuan', group: '国内', label: '腾讯混元', short: '混', color: '#0052d9', desc: '',
    fields: [key(), base('https://api.hunyuan.cloud.tencent.com/v1')],
    catalog: [{ id: 'hunyuan-turbos', name: '混元 TurboS', context: 32, caps: ['tools', 'fast'] }, { id: 'hunyuan-t1', name: '混元 T1', context: 32, caps: ['reasoning'] }],
    ...compat('hunyuan', 'https://api.hunyuan.cloud.tencent.com/v1'),
  },
  {
    kind: 'minimax', group: '国内', label: 'MiniMax', short: 'Mx', color: '#e2167e', desc: '',
    fields: [key(), base('https://api.minimaxi.com/v1')],
    catalog: [{ id: 'minimax-m1', name: 'MiniMax M1', context: 1000, caps: ['tools', 'reasoning'] }],
    ...compat('minimax', 'https://api.minimaxi.com/v1'),
  },
  {
    kind: 'openrouter', group: '聚合网关', label: 'OpenRouter', short: 'OR', color: '#6467f2', desc: '一个 Key 调多家模型',
    fields: [key('sk-or-...'), base('https://openrouter.ai/api/v1')],
    catalog: [
      { id: 'openrouter/auto', name: 'OpenRouter 自动路由', context: 200, caps: ['tools'] },
      { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5（经 OpenRouter）', context: 200, caps: ['tools', 'vision'] },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash（经 OpenRouter）', context: 1000, caps: ['tools', 'fast'] },
    ],
    ...compat('openrouter', 'https://openrouter.ai/api/v1'),
  },
  {
    kind: 'siliconflow', group: '聚合网关', label: '硅基流动', short: '硅', color: '#7c3aed', desc: '国内访问的开源模型托管',
    fields: [key(), base('https://api.siliconflow.cn/v1')],
    catalog: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3（硅基流动）', context: 128, caps: ['tools'] },
      { id: 'Qwen/Qwen3-32B', name: 'Qwen3 32B（硅基流动）', context: 128, caps: ['tools', 'fast'] },
    ],
    ...compat('siliconflow', 'https://api.siliconflow.cn/v1'),
  },
  {
    kind: 'ollama', group: '本地与自部署', label: 'Ollama', short: 'Ol', color: '#555', desc: '本机或内网跑的开源模型，不出内网',
    fields: [base('http://127.0.0.1:11434')],
    catalog: [{ id: 'qwen3:14b', name: 'Qwen3 14B', context: 32, caps: ['tools', 'local'] }, { id: 'llama3.3:70b', name: 'Llama 3.3 70B', context: 128, caps: ['tools', 'local'] }],
    api: { kind: 'ollama' }, prefill: 'http://127.0.0.1:11434',
  },
  {
    kind: 'lmstudio', group: '本地与自部署', label: 'LM Studio', short: 'LM', color: '#4b5563', desc: '本机桌面端加载的模型',
    fields: [base('http://127.0.0.1:1234/v1'), localKey],
    catalog: [{ id: 'local-model', name: '当前加载的模型', context: 32, caps: ['local'] }],
    ...compat('lmstudio', 'http://127.0.0.1:1234/v1'),
  },
  {
    kind: 'vllm', group: '本地与自部署', label: 'vLLM', short: 'v', color: '#30a2ff', desc: '公司内网 GPU 上部署的模型',
    fields: [base('http://gpu-01.internal:8000/v1'), { ...localKey, placeholder: '部署时没设 --api-key 就随便填一个' }, modelIds('模型 ID', '部署的模型名，多个用逗号隔开')],
    catalog: [],
    api: { kind: 'openai', preset: 'vllm' },
  },
  {
    kind: 'custom', group: '自定义', label: '自定义（OpenAI 兼容）', short: '+', color: '#7a4fd6', desc: '任何兼容 OpenAI 接口的网关或服务',
    fields: [base('https://your-gateway.example.com/v1'), localKey, modelIds()],
    catalog: [],
    api: { kind: 'openai', preset: 'custom' },
  },
]

export const kindOf = (k: string): ProviderKindDef => PROVIDER_KINDS.find((x) => x.kind === k) ?? PROVIDER_KINDS.find((x) => x.kind === 'custom')!

/** 已接入的服务商在目录里是哪一类：协议加 preset 反推；认不出的兼容服务按「自定义」 */
export function uiKindOf(p: Pick<AgentProvider, 'kind' | 'extra'>): string {
  const preset = typeof p.extra?.preset === 'string' ? p.extra.preset : ''
  if (p.kind === 'openai') {
    if (!preset) return 'openai'
    return PROVIDER_KINDS.some((k) => k.kind === preset && k.api?.kind === 'openai') ? preset : 'custom'
  }
  return PROVIDER_KINDS.some((k) => k.kind === p.kind && k.api?.kind === p.kind) ? p.kind : 'custom'
}

/** 手填的模型 ID：逗号（中英文）或空格隔开 */
export const splitIds = (s: string) => s.split(/[,，\s]+/).filter(Boolean)

/** 不需要 API Key 的协议（后端 providerNeedsKey） */
export const keyOptional = (def: ProviderKindDef) => def.api?.kind === 'ollama'
