// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 模型服务商和模型
//   服务商：一个账号 / 一个端点，配 API Key、地址，测通了才能用
//   模型：从服务商的模型目录里挑出来启用的那些，各自有显示名和默认参数

export type ProviderKind =
  | 'anthropic' | 'openai' | 'azure' | 'bedrock' | 'gemini' | 'mistral' | 'xai'
  | 'deepseek' | 'qwen' | 'zhipu' | 'moonshot' | 'doubao' | 'qianfan' | 'hunyuan' | 'minimax'
  | 'openrouter' | 'siliconflow'
  | 'ollama' | 'lmstudio' | 'vllm'
  | 'custom'

/** 「添加服务商」里按这个分组展示 */
export const PROVIDER_GROUPS = ['国际', '国内', '聚合网关', '本地与自部署', '自定义'] as const
export type ProviderGroup = (typeof PROVIDER_GROUPS)[number]

export interface ProviderField { key: string; label: string; type: 'text' | 'secret'; placeholder?: string; required?: boolean; hint?: string }

export interface CatalogModel { id: string; name: string; context: number; caps: Cap[]; price?: [number, number] }
export type Cap = 'tools' | 'vision' | 'reasoning' | 'fast' | 'local'
export const CAP_LABEL: Record<Cap, string> = { tools: '工具调用', vision: '看图', reasoning: '深度推理', fast: '快', local: '本地' }

export interface ProviderKindDef { kind: ProviderKind; group: ProviderGroup; label: string; short: string; color: string; desc: string; fields: ProviderField[]; catalog: CatalogModel[] }

const key: ProviderField = { key: 'api_key', label: 'API Key', type: 'secret', required: true }
const base = (placeholder: string, required = false): ProviderField => ({ key: 'base_url', label: '接口地址', type: 'text', placeholder, required, hint: required ? undefined : '留空用官方地址；走代理或网关时再填' })

export const PROVIDER_KINDS: ProviderKindDef[] = [
  {
    kind: 'anthropic', group: '国际', label: 'Anthropic', short: 'A', color: '#c96442', desc: 'Claude 系列模型',
    fields: [{ ...key, placeholder: 'sk-ant-...' }, base('https://api.anthropic.com')],
    catalog: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', context: 200, caps: ['tools', 'vision', 'reasoning'], price: [15, 75] },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200, caps: ['tools', 'vision', 'reasoning'], price: [3, 15] },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 200, caps: ['tools', 'vision', 'fast'], price: [1, 5] },
    ],
  },
  {
    kind: 'openai', group: '国际', label: 'OpenAI', short: 'O', color: '#10a37f', desc: 'GPT 系列模型',
    fields: [{ ...key, placeholder: 'sk-...' }, base('https://api.openai.com/v1'), { key: 'org', label: 'Organization ID', type: 'text', placeholder: '可选' }],
    catalog: [
      { id: 'gpt-5', name: 'GPT-5', context: 400, caps: ['tools', 'vision', 'reasoning'], price: [1.25, 10] },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', context: 400, caps: ['tools', 'vision', 'fast'], price: [0.25, 2] },
    ],
  },
  {
    kind: 'azure', group: '国际', label: 'Azure OpenAI', short: 'Az', color: '#0078d4', desc: '企业账号里部署的 OpenAI 模型',
    fields: [{ ...key }, base('https://<资源名>.openai.azure.com', true), { key: 'deployment', label: '部署名', type: 'text', required: true }, { key: 'api_version', label: 'API 版本', type: 'text', placeholder: '2025-04-01-preview' }],
    catalog: [{ id: 'azure-gpt-5', name: 'GPT-5（Azure 部署）', context: 400, caps: ['tools', 'vision'], price: [1.25, 10] }],
  },
  {
    kind: 'bedrock', group: '国际', label: 'AWS Bedrock', short: 'B', color: '#ff9900', desc: '通过 AWS 账号调用 Claude 等模型',
    fields: [{ key: 'access_key', label: 'Access Key ID', type: 'text', required: true }, { key: 'secret_key', label: 'Secret Access Key', type: 'secret', required: true }, { key: 'region', label: '区域', type: 'text', placeholder: 'us-east-1', required: true }],
    catalog: [{ id: 'bedrock-claude-sonnet-5-5', name: 'Claude Sonnet 5.5（Bedrock）', context: 200, caps: ['tools', 'vision', 'reasoning'], price: [3, 15] }],
  },
  {
    kind: 'deepseek', group: '国内', label: 'DeepSeek', short: 'D', color: '#4d6bfe', desc: '',
    fields: [{ ...key }, base('https://api.deepseek.com')],
    catalog: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', context: 128, caps: ['tools', 'fast'], price: [0.27, 1.1] }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', context: 128, caps: ['reasoning'], price: [0.55, 2.19] }],
  },
  {
    kind: 'ollama', group: '本地与自部署', label: 'Ollama', short: 'Ol', color: '#555', desc: '本机或内网跑的开源模型，不出内网',
    fields: [base('http://127.0.0.1:11434', true)],
    catalog: [{ id: 'qwen3:14b', name: 'Qwen3 14B', context: 32, caps: ['tools', 'local'] }, { id: 'llama3.3:70b', name: 'Llama 3.3 70B', context: 128, caps: ['tools', 'local'] }],
  },
  {
    kind: 'gemini', group: '国际', label: 'Google Gemini', short: 'G', color: '#4285f4', desc: 'Gemini 系列，长上下文',
    fields: [{ ...key, placeholder: 'AIza...' }, base('https://generativelanguage.googleapis.com')],
    catalog: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1000, caps: ['tools', 'vision', 'reasoning'] },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1000, caps: ['tools', 'vision', 'fast'] },
    ],
  },
  {
    kind: 'mistral', group: '国际', label: 'Mistral', short: 'M', color: '#fa520f', desc: '',
    fields: [{ ...key }, base('https://api.mistral.ai/v1')],
    catalog: [{ id: 'mistral-large-latest', name: 'Mistral Large', context: 128, caps: ['tools'] }, { id: 'mistral-small-latest', name: 'Mistral Small', context: 128, caps: ['tools', 'fast'] }],
  },
  {
    kind: 'xai', group: '国际', label: 'xAI', short: 'x', color: '#111', desc: 'Grok 系列',
    fields: [{ ...key, placeholder: 'xai-...' }, base('https://api.x.ai/v1')],
    catalog: [{ id: 'grok-4', name: 'Grok 4', context: 256, caps: ['tools', 'vision', 'reasoning'] }],
  },
  {
    kind: 'qwen', group: '国内', label: '阿里云百炼（通义千问）', short: '通', color: '#615ced', desc: '通义千问系列，DashScope 接口',
    fields: [{ ...key, placeholder: 'sk-...' }, base('https://dashscope.aliyuncs.com/compatible-mode/v1')],
    catalog: [
      { id: 'qwen-max', name: '通义千问 Max', context: 32, caps: ['tools'] },
      { id: 'qwen-plus', name: '通义千问 Plus', context: 128, caps: ['tools'] },
      { id: 'qwen-turbo', name: '通义千问 Turbo', context: 1000, caps: ['tools', 'fast'] },
      { id: 'qwen-vl-max', name: '通义千问 VL Max', context: 32, caps: ['vision'] },
    ],
  },
  {
    kind: 'zhipu', group: '国内', label: '智谱 AI', short: '智', color: '#3b5bdb', desc: 'GLM 系列',
    fields: [{ ...key }, base('https://open.bigmodel.cn/api/paas/v4')],
    catalog: [{ id: 'glm-4.5', name: 'GLM-4.5', context: 128, caps: ['tools', 'reasoning'] }, { id: 'glm-4.5-air', name: 'GLM-4.5 Air', context: 128, caps: ['tools', 'fast'] }],
  },
  {
    kind: 'moonshot', group: '国内', label: '月之暗面（Kimi）', short: 'K', color: '#16191e', desc: 'Kimi 系列，长文本',
    fields: [{ ...key, placeholder: 'sk-...' }, base('https://api.moonshot.cn/v1')],
    catalog: [{ id: 'kimi-k2', name: 'Kimi K2', context: 128, caps: ['tools'] }],
  },
  {
    kind: 'doubao', group: '国内', label: '火山方舟（豆包）', short: '豆', color: '#1664ff', desc: '豆包系列，按接入点调用',
    fields: [{ ...key }, base('https://ark.cn-beijing.volces.com/api/v3'), { key: 'endpoint', label: '接入点 ID', type: 'text', placeholder: 'ep-2025...', required: true, hint: '在火山方舟控制台创建接入点后拿到' }],
    catalog: [{ id: 'doubao-seed-1.6', name: '豆包 Seed 1.6', context: 256, caps: ['tools', 'vision', 'reasoning'] }, { id: 'doubao-seed-1.6-flash', name: '豆包 Seed 1.6 Flash', context: 256, caps: ['tools', 'fast'] }],
  },
  {
    kind: 'qianfan', group: '国内', label: '百度千帆（文心）', short: '文', color: '#2932e1', desc: '文心系列',
    fields: [{ ...key }, base('https://qianfan.baidubce.com/v2')],
    catalog: [{ id: 'ernie-4.5', name: '文心 4.5', context: 128, caps: ['tools', 'vision'] }, { id: 'ernie-speed', name: '文心 Speed', context: 128, caps: ['fast'] }],
  },
  {
    kind: 'hunyuan', group: '国内', label: '腾讯混元', short: '混', color: '#0052d9', desc: '',
    fields: [{ ...key }, base('https://api.hunyuan.cloud.tencent.com/v1')],
    catalog: [{ id: 'hunyuan-turbos', name: '混元 TurboS', context: 32, caps: ['tools', 'fast'] }, { id: 'hunyuan-t1', name: '混元 T1', context: 32, caps: ['reasoning'] }],
  },
  {
    kind: 'minimax', group: '国内', label: 'MiniMax', short: 'Mx', color: '#e2167e', desc: '',
    fields: [{ ...key }, base('https://api.minimaxi.com/v1')],
    catalog: [{ id: 'minimax-m1', name: 'MiniMax M1', context: 1000, caps: ['tools', 'reasoning'] }],
  },
  {
    kind: 'openrouter', group: '聚合网关', label: 'OpenRouter', short: 'OR', color: '#6467f2', desc: '一个 Key 调多家模型',
    fields: [{ ...key, placeholder: 'sk-or-...' }, base('https://openrouter.ai/api/v1')],
    catalog: [
      { id: 'openrouter/auto', name: 'OpenRouter 自动路由', context: 200, caps: ['tools'] },
      { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5（经 OpenRouter）', context: 200, caps: ['tools', 'vision'] },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash（经 OpenRouter）', context: 1000, caps: ['tools', 'fast'] },
    ],
  },
  {
    kind: 'siliconflow', group: '聚合网关', label: '硅基流动', short: '硅', color: '#7c3aed', desc: '国内访问的开源模型托管',
    fields: [{ ...key }, base('https://api.siliconflow.cn/v1')],
    catalog: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3（硅基流动）', context: 128, caps: ['tools'] },
      { id: 'Qwen/Qwen3-32B', name: 'Qwen3 32B（硅基流动）', context: 128, caps: ['tools', 'fast'] },
    ],
  },
  {
    kind: 'lmstudio', group: '本地与自部署', label: 'LM Studio', short: 'LM', color: '#4b5563', desc: '本机桌面端加载的模型',
    fields: [base('http://127.0.0.1:1234/v1', true)],
    catalog: [{ id: 'local-model', name: '当前加载的模型', context: 32, caps: ['local'] }],
  },
  {
    kind: 'vllm', group: '本地与自部署', label: 'vLLM', short: 'v', color: '#30a2ff', desc: '公司内网 GPU 上部署的模型',
    fields: [base('http://gpu-01.internal:8000/v1', true), { ...key, required: false, placeholder: '部署时设了 --api-key 才需要' }, { key: 'model_ids', label: '模型 ID', type: 'text', placeholder: '部署的模型名，多个用逗号隔开', required: true }],
    catalog: [],
  },
  {
    kind: 'custom', group: '自定义', label: '自定义（OpenAI 兼容）', short: '+', color: '#7a4fd6', desc: '任何兼容 OpenAI 接口的网关或服务',
    fields: [base('https://your-gateway.example.com/v1', true), { ...key, required: false, placeholder: '没有就留空' }, { key: 'model_ids', label: '模型 ID', type: 'text', placeholder: '多个用逗号隔开', required: true }],
    catalog: [],
  },
]
export const kindOf = (k: ProviderKind) => PROVIDER_KINDS.find((x) => x.kind === k)!

export interface Provider {
  id: string
  kind: ProviderKind
  name: string
  values: Record<string, string>
  enabled: boolean
  status: 'ok' | 'error' | 'untested'
  error?: string
  checked_at?: string
  /** 失败时改用的服务商 id（SPEC-settings-7.22）：它连不上、5xx 被暂停调用（熔断）时改用，空的不改用 */
  fallback_id?: string
}

export interface ModelConf {
  /** 服务商里的模型 ID */
  id: string
  provider_id: string
  name: string
  context: number
  caps: Cap[]
  price?: [number, number]
  enabled: boolean
  temperature: number
  max_output: number
}


const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()

export const seedProviders: Provider[] = [
  { id: 'pv_anthropic', kind: 'anthropic', name: 'Anthropic', values: { api_key: 'sk-ant-api03-7f2c...b91e', base_url: '' }, enabled: true, status: 'ok', checked_at: minsAgo(40) },
  { id: 'pv_openai', kind: 'openai', name: 'OpenAI', values: { api_key: 'sk-proj-expired', base_url: '', org: '' }, enabled: true, status: 'error', error: '401 Unauthorized：API Key 已失效或被撤销', checked_at: minsAgo(60 * 3) },
  { id: 'pv_ollama', kind: 'ollama', name: '本机 Ollama', values: { base_url: 'http://127.0.0.1:11434' }, enabled: true, status: 'ok', checked_at: minsAgo(60 * 20) },
]

const fromCatalog = (provider: string, m: CatalogModel, enabled = true): ModelConf => ({ ...m, provider_id: provider, enabled, temperature: 0.7, max_output: 4096 })
export const catalogModel = fromCatalog

export const seedModels: ModelConf[] = [
  ...kindOf('anthropic').catalog.map((m) => fromCatalog('pv_anthropic', m)),
  fromCatalog('pv_openai', kindOf('openai').catalog[0]),
  fromCatalog('pv_ollama', kindOf('ollama').catalog[0]),
]

/** 模型能不能用：自己启用、服务商启用且连得上 */
export function usable(m: ModelConf, providers: Provider[]): { ok: boolean; why?: string } {
  const p = providers.find((x) => x.id === m.provider_id)
  if (!p) return { ok: false, why: '服务商已删除' }
  if (!p.enabled) return { ok: false, why: `${p.name} 已停用` }
  if (p.status === 'error') return { ok: false, why: `${p.name} 连接异常` }
  if (!m.enabled) return { ok: false, why: '模型未启用' }
  return { ok: true }
}

/** 模拟测试连接：必填没填、Key 里带 expired / bad 的算失败 */
export function testProvider(kind: ProviderKind, values: Record<string, string>): { ok: boolean; error?: string } {
  const def = kindOf(kind)
  const miss = def.fields.filter((f) => f.required && !values[f.key]?.trim())
  if (miss.length) return { ok: false, error: `还没填：${miss.map((f) => f.label).join('、')}` }
  const k = Object.values(values).join(' ')
  if (/expired|bad|invalid/i.test(k)) return { ok: false, error: '401 Unauthorized：API Key 已失效或被撤销' }
  if (values.base_url && !/^https?:\/\//.test(values.base_url)) return { ok: false, error: '接口地址要以 http:// 或 https:// 开头' }
  return { ok: true }
}
