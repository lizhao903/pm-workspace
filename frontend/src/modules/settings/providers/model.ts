// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 服务商抽屉的表单和请求体（纯函数，单元测试盯着）。
// api_key 的三态：输入框空着就不带（不改），清空走单独的确认（传空串），填了才覆盖。
import type { AgentProvider, ProviderCheck, ProviderInput, ProviderPatch } from '../../../core/data'
import { keyOptional, splitIds, type CatalogModel, type FieldKey, type ProviderKindDef } from './catalog'

export type ProviderForm = {
  name: string
  values: Record<FieldKey, string>
  /** 默认模型（后端的 model） */
  model: string
  enabled: boolean
  /** 失败时改用的服务商 id（extra.fallback_id，TSK-0392），空串不改用 */
  fallback: string
}

/** 服务商 extra 里「失败时改用」的键，后端 agent.FallbackKey */
export const FALLBACK_KEY = 'fallback_id'
const extraFallback = (p: AgentProvider) => (typeof p.extra?.[FALLBACK_KEY] === 'string' ? (p.extra[FALLBACK_KEY] as string) : '')

const extraIds = (p: AgentProvider) => (typeof p.extra?.model_ids === 'string' ? p.extra.model_ids : '')

export function initialForm(def: ProviderKindDef, p?: AgentProvider): ProviderForm {
  if (!p) {
    return {
      name: def.label,
      values: { api_key: '', base_url: def.prefill ?? '', model_ids: '' },
      model: def.catalog[0]?.id ?? '',
      enabled: true,
      fallback: '',
    }
  }
  return {
    name: p.name, values: { api_key: '', base_url: p.base_url, model_ids: extraIds(p) }, model: p.model, enabled: p.enabled,
    fallback: extraFallback(p),
  }
}

/** 必填没填的项。API Key 编辑时已经配过就不算没填（空着表示不改） */
export function missingFields(def: ProviderKindDef, f: ProviderForm, p?: AgentProvider): FieldKey[] {
  return def.fields
    .filter((x) => x.required && !f.values[x.key].trim())
    .filter((x) => !(x.key === 'api_key' && (keyOptional(def) || p?.has_api_key)))
    .map((x) => x.key)
}

function nextExtra(def: ProviderKindDef, f: ProviderForm, prev: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev }
  if (def.api?.preset) out.preset = def.api.preset
  else delete out.preset
  const ids = f.values.model_ids.trim()
  if (def.fields.some((x) => x.key === 'model_ids') && ids) out.model_ids = ids
  else delete out.model_ids
  if (f.fallback) out[FALLBACK_KEY] = f.fallback
  else delete out[FALLBACK_KEY]
  return out
}

/**
 * 「失败时改用」的候选：别的已接入服务商（不含自己），停用的标出来不能选；
 * 当前选的已经删了也列上，免得看不到。
 */
export function fallbackOptions(list: AgentProvider[], self: string | undefined, cur: string): { value: string; label: string; disabled?: boolean }[] {
  const out: { value: string; label: string; disabled?: boolean }[] = [{ value: '', label: '不改用，直接报错' }]
  for (const p of list) {
    if (p.id === self) continue
    out.push({ value: p.id, label: p.enabled ? `${p.name}${p.model ? ` · ${p.model}` : ''}` : `${p.name}（已停用）`, disabled: !p.enabled && p.id !== cur })
  }
  if (cur && !list.some((p) => p.id === cur)) out.push({ value: cur, label: '已删除的服务商' })
  return out
}

export function createBody(def: ProviderKindDef, f: ProviderForm): ProviderInput {
  if (!def.api) throw new Error(`${def.label} 暂未支持`)
  const body: ProviderInput = { name: f.name.trim(), kind: def.api.kind, model: f.model.trim(), enabled: f.enabled, extra: nextExtra(def, f) }
  const base = f.values.base_url.trim()
  if (base) body.base_url = base
  const key = f.values.api_key.trim()
  if (key) body.api_key = key
  return body
}

/** 只带改了的字段；api_key 没填就不带 */
export function patchBody(def: ProviderKindDef, f: ProviderForm, p: AgentProvider): ProviderPatch {
  const patch: ProviderPatch = {}
  const name = f.name.trim()
  if (name !== p.name) patch.name = name
  const base = f.values.base_url.trim()
  if (base !== p.base_url) patch.base_url = base
  const model = f.model.trim()
  if (model !== p.model) patch.model = model
  if (f.enabled !== p.enabled) patch.enabled = f.enabled
  const key = f.values.api_key.trim()
  if (key) patch.api_key = key
  const extra = nextExtra(def, f, p.extra ?? {})
  if (JSON.stringify(extra) !== JSON.stringify(p.extra ?? {})) patch.extra = extra
  return patch
}

export type ModelRow = CatalogModel & { known: boolean }
export type ModelList = { rows: ModelRow[]; source: 'tested' | 'manual' | 'catalog' }

/**
 * 默认模型的候选：测通了用服务商实际返回的列表，没测通时手填的模型 ID 或内置目录。
 * 目录里有的补上显示名、能力、上下文和价格；当前默认模型不在列表里也放进来，免得看不到。
 */
export function modelList(def: ProviderKindDef, f: ProviderForm, check?: ProviderCheck): ModelList {
  const tested = check?.result.ok && check.result.models?.length ? check.result.models : null
  const manual = def.fields.some((x) => x.key === 'model_ids') ? splitIds(f.values.model_ids) : null
  const source: ModelList['source'] = tested ? 'tested' : manual ? 'manual' : 'catalog'
  const ids = tested ?? manual ?? def.catalog.map((m) => m.id)
  const all = [...ids]
  const cur = f.model.trim()
  if (cur && !all.includes(cur)) all.unshift(cur)
  const rows = [...new Set(all)].map((id): ModelRow => {
    const known = def.catalog.find((m) => m.id === id)
    return known ? { ...known, known: true } : { id, name: id, caps: [], known: false }
  })
  return { rows, source }
}

export type StatusKey = 'ok' | 'error' | 'untested' | 'off'
export const STATUS: Record<StatusKey, { label: string; color: string }> = {
  ok: { label: '连接正常', color: '#2f7d43' },
  error: { label: '连接异常', color: '#c0352b' },
  untested: { label: '未测试', color: '' },
  off: { label: '已停用', color: '' },
}

export function statusOf(p: Pick<AgentProvider, 'enabled'>, check?: ProviderCheck): StatusKey {
  if (!p.enabled) return 'off'
  if (!check) return 'untested'
  return check.result.ok ? 'ok' : 'error'
}

export function timeAgo(ms: number, now = Date.now()): string {
  const m = Math.round((now - ms) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  return `${Math.floor(m / 1440)} 天前`
}
