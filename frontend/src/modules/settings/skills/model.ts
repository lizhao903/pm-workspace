// 技能页的纯函数：来源分组、搜索、工具选项、表单和请求体（SPEC-settings-15、16）。
import type { Connector, Skill, SkillInput, SkillPatch } from '../../../core/data'

/**
 * 内置工具的名字，照原型 web-next/src/agentdata.ts ABILITIES 的 label。
 * 后端没有能力的目录接口（授权 key 见契约「工具授权」），技能的 uses 存的就是这些中文名，只是说明
 */
export const BUILTIN_TOOLS = ['读 IM 消息', '回复 IM 消息', '查联系人', '新建 / 修改联系人', '查任务', '新建 / 更新任务', '读文档', '写文档', '发起 SOP']

export type SourceGroup = 'builtin' | 'custom' | 'plugin'
export type SourceFilter = '' | SourceGroup

export const GROUP_LABEL: Record<SourceGroup, string> = { builtin: '内置', custom: '自定义', plugin: '插件' }

/** 来源分组：不是 builtin、custom 的都是插件 id */
export const groupOf = (s: Pick<Skill, 'source'>): SourceGroup =>
  s.source === 'builtin' ? 'builtin' : s.source === 'custom' ? 'custom' : 'plugin'

/** 按名称、说明、用到的工具搜，不分大小写，空格隔开的词都要命中 */
export function matchSkill(s: Pick<Skill, 'name' | 'desc' | 'uses'>, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${s.name} ${s.desc} ${s.uses.join(' ')}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export function filterSkills(list: readonly Skill[], src: SourceFilter, q: string): Skill[] {
  return list.filter((s) => (!src || groupOf(s) === src) && matchSkill(s, q))
}

/** 「加连接器工具」的选项：连接器里开着的工具，写成「<连接器> · <工具名>」，按连接器分组 */
export type ToolOption = { value: string; label: string; group: string; keywords: string }

export function connectorToolOptions(conns: readonly Connector[]): ToolOption[] {
  const seen = new Set<string>()
  const out: ToolOption[] = []
  for (const c of conns) {
    // 照原型 connToolChoices：暂停、断开的连接器不算
    if (c.status === 'paused' || c.status === 'disconnected') continue
    for (const t of c.tools) {
      if (t.mode === 'off') continue
      const value = `${c.name} · ${t.name}`
      if (seen.has(value)) continue
      seen.add(value)
      out.push({ value, label: t.name, group: c.name, keywords: value })
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group, 'zh-CN'))
}

/** uses 拆成内置工具和其余（连接器工具，或种子里直接写的工具名） */
export const pickedTools = (uses: readonly string[]) => uses.filter((u) => !BUILTIN_TOOLS.includes(u))

/** 只换掉其余那部分，内置工具的勾选保留 */
export const withPicked = (uses: readonly string[], picked: readonly string[]) => [...uses.filter((u) => BUILTIN_TOOLS.includes(u)), ...picked]

export const toggleTool = (uses: readonly string[], t: string) => (uses.includes(t) ? uses.filter((x) => x !== t) : [...uses, t])

export type SkillForm = { name: string; desc: string; when: string; instructions: string; uses: string[] }

export const EMPTY_FORM: SkillForm = { name: '', desc: '', when: '', instructions: '', uses: [] }

export const formOf = (s: Skill): SkillForm => ({ name: s.name, desc: s.desc, when: s.when, instructions: s.instructions, uses: [...s.uses] })

/** 复制一份来改：内容照搬，名称加「（我的）」（原型写法；后端默认的「（副本）」不用） */
export const copyForm = (s: Skill): SkillForm => ({ ...formOf(s), name: `${s.name}（我的）` })

/** 名称和怎么做都要填 */
export const missingOf = (f: SkillForm) => ({ name: !f.name.trim(), instructions: !f.instructions.trim() })

export function createBody(f: SkillForm, copyFrom?: string): SkillInput {
  return {
    name: f.name.trim(), desc: f.desc.trim(), when: f.when.trim(), instructions: f.instructions, uses: f.uses,
    ...(copyFrom ? { copy_from: copyFrom } : {}),
  }
}

/** 只带改了的字段 */
export function patchBody(f: SkillForm, s: Skill): SkillPatch {
  const p: SkillPatch = {}
  if (f.name.trim() !== s.name) p.name = f.name.trim()
  if (f.desc.trim() !== s.desc) p.desc = f.desc.trim()
  if (f.when.trim() !== s.when) p.when = f.when.trim()
  if (f.instructions !== s.instructions) p.instructions = f.instructions
  if (f.uses.length !== s.uses.length || f.uses.some((u, i) => u !== s.uses[i])) p.uses = f.uses
  return p
}

/** 删除确认里点名：最多列三个 */
export const agentNames = (list: readonly { name: string }[]) =>
  list.length > 3 ? `${list.slice(0, 3).map((a) => a.name).join('、')} 等 ${list.length} 个 Agent` : list.map((a) => a.name).join('、')

/** 删除确认的文案（SPEC-settings-16.11） */
export const deleteText = (agents: readonly { name: string }[]) =>
  agents.length ? `${agentNames(agents)} 挂着它，删除后会自动卸下` : '删除后不能恢复'
