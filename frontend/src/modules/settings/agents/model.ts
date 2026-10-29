// Agent 列表和配置页的纯函数（AG-01b5），照原型 web-next/src/agents.tsx、agentdata.ts、App.tsx 的 modelChoices。
// 色值写在这里（.tsx 里不出现色值），单元测试盯着模型可选项、草稿改动和问题汇总。
import type {
  Agent, AgentInput, AgentPatch, AgentProvider, AgentTrigger, AgentTriggerKind, AgentTriggerMatch, ProviderCheck,
} from '../../../core/data'
import { kindOf, splitIds, uiKindOf } from '../providers/catalog'

/** 头像底色，同后端不给 color 时随机挑的那组（原型 AGENT_COLORS） */
export const AGENT_COLORS = ['#3d4fd6', '#7a4fd6', '#0f8a8a', '#b0570b', '#2f7d43', '#c0352b', '#e8590c', '#23221e'] as const
export const AVATAR_ICONS = ['robot', 'chat', 'doc', 'chart', 'flow', 'search', 'mail', 'calendar', 'shield', 'spark'] as const
/** 头像图片上限，同后端 */
export const AVATAR_MAX_BYTES = 1024 * 1024

export const TRIGGER_KINDS: AgentTriggerKind[] = ['manual', 'im', 'schedule', 'task']
export const TRIGGER_LABEL: Record<AgentTriggerKind, string> = { manual: '手动对话', im: '收到 IM 消息', schedule: '定时', task: '任务分配给它' }
export const TRIGGER_PLACEHOLDER: Record<AgentTriggerKind, string> = {
  manual: '', im: '哪些渠道、群还是私聊', schedule: '比如：每周五 16:00', task: '比如：标签含「Agent」的任务',
}
export const triggerLabel = (k: string) => TRIGGER_LABEL[k as AgentTriggerKind] ?? k

/** 内置能力（契约「Agent 工具授权」的 key），列表卡片的能力标签按这个顺序 */
export const ABILITIES: { key: string; label: string; write: boolean }[] = [
  { key: 'read_messages', label: '读 IM 消息', write: false },
  { key: 'reply_message', label: '回复 IM 消息', write: true },
  { key: 'read_contacts', label: '查联系人', write: false },
  { key: 'write_contacts', label: '新建 / 修改联系人', write: true },
  { key: 'read_tasks', label: '查任务', write: false },
  { key: 'write_tasks', label: '新建 / 更新任务', write: true },
  { key: 'read_content', label: '读文档', write: false },
  { key: 'write_content', label: '写文档', write: true },
  { key: 'run_sop', label: '发起 SOP', write: true },
]

/** 空格隔开的词都要命中，不分大小写 */
export function hasAll(hay: string, q: string): boolean {
  const h = hay.toLowerCase()
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w))
}

// ---- 模型 ----

/** 一个可选模型：服务商加模型名；ok 为 false 时 note 是不可用原因 */
export type ModelChoice = { key: string; providerId: string; model: string; label: string; note: string; ok: boolean; group: string }

export const choiceKey = (providerId: string, model: string) => `${providerId}\u0000${model}`

/** 服务商能不能用：启用、该有的 API Key 有、最近一次测试没失败（没测过按能用） */
export function providerProblem(p: AgentProvider, check?: ProviderCheck): string | undefined {
  if (!p.enabled) return `${p.name} 已停用`
  // Ollama 不要求 API Key（后端 providerNeedsKey）
  if (p.kind !== 'ollama' && !p.has_api_key) return `${p.name} 还没配 API Key`
  if (check && !check.result.ok) return `${p.name} 连接异常`
  return undefined
}

/**
 * 各服务商的模型：测通了用实际返回的列表，没测过用手填的模型 ID 或内置目录，默认模型总在里面。
 * keep 是要保留的当前选择（Agent 正在用的），不在列表里也补进来；服务商删了的单独列成不可用。
 */
export function modelChoices(
  providers: AgentProvider[],
  checks: Record<string, ProviderCheck | undefined> = {},
  keep: { provider_id: string; model: string }[] = [],
): ModelChoice[] {
  const out: ModelChoice[] = []
  for (const p of providers) {
    const def = kindOf(uiKindOf(p))
    const check = checks[p.id]
    const tested = check?.result.ok && check.result.models?.length ? check.result.models : null
    const manual = typeof p.extra?.model_ids === 'string' ? splitIds(p.extra.model_ids) : []
    const ids = tested ?? (manual.length ? manual : def.catalog.map((m) => m.id))
    const kept = keep.filter((k) => k.provider_id === p.id && k.model).map((k) => k.model)
    const all = [...new Set([...(p.model ? [p.model] : []), ...ids, ...kept])]
    const why = providerProblem(p, check)
    for (const id of all) {
      const known = def.catalog.find((m) => m.id === id)
      const label = known?.name ?? id
      const note = why ?? (known?.context ? `${p.name} · ${known.context}K 上下文` : p.name)
      out.push({ key: choiceKey(p.id, id), providerId: p.id, model: id, label, note, ok: !why, group: p.name })
    }
  }
  for (const k of keep) {
    if (!k.model || providers.some((p) => p.id === k.provider_id)) continue
    const key = choiceKey(k.provider_id, k.model)
    if (!out.some((m) => m.key === key)) {
      out.push({ key, providerId: k.provider_id, model: k.model, label: k.model, note: '服务商已删除', ok: false, group: '不可用' })
    }
  }
  return out
}

/** 新建时默认的模型：第一个能用的，没有能用的取第一个 */
export const defaultChoice = (choices: ModelChoice[]) => choices.find((m) => m.ok) ?? choices[0]

/** 可选模型多于这个数时，只露当前选中的，点「换模型」再展开 */
export const MANY_MODELS = 6

// ---- 草稿 ----

export type AgentDraft = AgentInput

const randomColor = () => AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]

/** 新建的空草稿：服务商和模型空着，表示用默认的那个（保存时再定），这样什么都没填不算改动 */
export function blankDraft(color: string = randomColor()): AgentDraft {
  return {
    name: '', desc: '', color, avatar: { kind: 'text', value: '' }, provider_id: '', model: '', instructions: '',
    skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }], enabled: true,
  }
}

export function draftOf(a: Agent): AgentDraft {
  return {
    name: a.name, desc: a.desc, color: a.color, avatar: a.avatar, provider_id: a.provider_id, model: a.model, instructions: a.instructions,
    skills: a.skills, mcps: a.mcps, kbs: a.kbs, triggers: a.triggers, enabled: a.enabled,
  }
}

const DRAFT_KEYS = Object.keys(blankDraft('#000000')) as (keyof AgentDraft)[]

/** 和原值比改了的字段；名称按去首尾空白比，后端也是这么存的 */
export function draftPatch(base: AgentDraft, d: AgentDraft): AgentPatch {
  const out: AgentPatch = {}
  for (const k of DRAFT_KEYS) {
    const a = k === 'name' ? base.name.trim() : base[k]
    const b = k === 'name' ? d.name.trim() : d[k]
    if (JSON.stringify(a) !== JSON.stringify(b)) (out as Record<string, unknown>)[k] = b
  }
  return out
}

export const draftChanged = (base: AgentDraft, d: AgentDraft) => Object.keys(draftPatch(base, d)).length > 0

/** 新建的请求体：服务商和模型没选时用默认的 */
export function createBody(d: AgentDraft, fallback?: ModelChoice): AgentInput {
  const pick = d.provider_id ? { provider_id: d.provider_id, model: d.model } : { provider_id: fallback?.providerId ?? '', model: fallback?.model ?? '' }
  return { ...d, ...pick, name: d.name.trim() }
}

// ---- 问题汇总 ----

export type EditorTab = 'basic' | 'model' | 'instructions' | 'skills' | 'tools' | 'kbs' | 'triggers'
export const EDITOR_TABS: { key: EditorTab; label: string }[] = [
  { key: 'basic', label: '基本信息' }, { key: 'model', label: '模型' }, { key: 'instructions', label: '指令' }, { key: 'skills', label: '技能' },
  { key: 'tools', label: '工具与权限' }, { key: 'kbs', label: '知识库' }, { key: 'triggers', label: '触发方式' },
]

/** 各标签的问题：名称没填、模型没选或不可用、挂的连接器异常、非手动触发没填条件 */
export function editorIssues(d: AgentDraft, model: ModelChoice | undefined, badConns: string[] = []): Partial<Record<EditorTab, string>> {
  return {
    basic: !d.name.trim() ? '名称还没填' : undefined,
    model: !model ? '还没选模型' : !model.ok ? `${model.label} 当前不可用` : undefined,
    tools: badConns.length ? `${badConns.join('、')} 连接异常` : undefined,
    triggers: d.triggers.some((t) => !triggerHasCondition(t)) ? '有触发方式没填条件' : undefined,
  }
}

/** 空的结构化条件：后端按 kind 只留自己的字段 */
export const emptyMatch = (): AgentTriggerMatch => ({ assigned: false, tags: [], connector_id: '', channel: '', conversation_id: '', only_me: false })

/** 任务触发没给 match 时后端按「分配给它」处理 */
export const taskMatchOf = (t: AgentTrigger): AgentTriggerMatch => t.match ?? { ...emptyMatch(), assigned: true }

/** 手动不用条件；任务触发总有结构化条件（默认分配给它）；IM 填了说明或选了连接器、会话、只看与我相关都算 */
export function triggerHasCondition(t: AgentTrigger): boolean {
  if (t.kind === 'manual' || t.kind === 'task') return true
  if (t.detail.trim()) return true
  const m = t.match
  return t.kind === 'im' && !!m && (!!m.connector_id || !!m.conversation_id || !!m.channel || m.only_me)
}

/** 卡片底部的触发方式：手动写「手动」，其余写条件，没条件写类型名 */
export const triggerSummary = (ts: AgentTrigger[]) =>
  ts.map((t) => (t.kind === 'manual' ? '手动' : t.detail.trim() || triggerLabel(t.kind))).join(' · ')

/** 本地目录必须是绝对路径；去掉末尾斜杠 */
export function normDir(s: string): { dir: string; error: string } {
  const dir = s.trim().replace(/(.)\/+$/, '$1')
  return { dir, error: dir && !dir.startsWith('/') ? '填绝对路径，以 / 开头' : '' }
}
