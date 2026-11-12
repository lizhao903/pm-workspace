// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 命令面板「联系人」组（A-01、SPEC-contacts-0）：按姓名、电话、邮箱、IM 编号搜，公司和职位跟原型一样也算；
// 回车去联系人页打开抽屉（?c=<id>）
import { fetchContacts, fetchIdentities, type Contact, type Identity } from '../../core/data'
import type { CommandDef } from '../../core/plugin'

export const CONTACT_SEARCH_LIMIT = 6

const norm = (v: string) => v.toLowerCase().replace(/\s/g, '')

/** 按空格切词，每个词都要命中某个字段；姓名开头命中的排前面，其次姓名包含，其余按名册顺序 */
export function findContacts(list: readonly Contact[], ids: readonly Identity[] | null, q: string): Contact[] {
  const words = q.trim().split(/\s+/).filter(Boolean).map(norm)
  if (!words.length) return []
  const im = new Map<string, string[]>()
  for (const i of ids ?? []) im.set(i.stakeholder_id, [...(im.get(i.stakeholder_id) ?? []), i.external_id, i.display_name])
  const scored: { c: Contact; s: number; n: number }[] = []
  list.forEach((c, n) => {
    const name = norm(c.name)
    const hay = [name, ...[c.phone, c.email, c.company, c.title, ...(im.get(c.id) ?? []), ...Object.values(c.im ?? {})].filter(Boolean).map(norm)]
    if (!words.every((w) => hay.some((v) => v.includes(w)))) return
    const s = name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2
    scored.push({ c, s, n })
  })
  return scored.sort((a, b) => a.s - b.s || a.n - b.n).map((x) => x.c)
}

export function contactCommand(c: Contact, root: string): CommandDef {
  return {
    id: 'contact.' + c.id,
    group: '联系人',
    title: c.name,
    sub: [c.company, c.title].filter(Boolean).join(' · ') || undefined,
    run: ({ shell }) => shell.navigate(`/${root}?c=${encodeURIComponent(c.id)}`),
  }
}

export async function searchContacts(q: string, root: string): Promise<CommandDef[]> {
  if (!q.trim()) return []
  const [list, ids] = await Promise.all([fetchContacts(), fetchIdentities()])
  return findContacts(list, ids, q).slice(0, CONTACT_SEARCH_LIMIT).map((c) => contactCommand(c, root))
}
