// 产出物 note 前缀解析（docs/api-contract.md「代码类产物」）：
// 「[commit] sha=… branch=… repo=…  自由备注」，种类看前缀，sha / branch / repo 从紧跟的 key=value 里取。
import type { Artifact } from '../../core/data'

export type ArtifactKind = 'commit' | 'branch' | 'pr' | 'file'

export const ARTIFACT_GROUPS: { key: ArtifactKind; label: string }[] = [
  { key: 'commit', label: '提交' },
  { key: 'branch', label: '分支' },
  { key: 'pr', label: 'PR' },
  { key: 'file', label: '文件' },
]

export type ParsedNote = { kind: ArtifactKind; sha?: string; branch?: string; repo?: string; text: string }

const PREFIX = /^\[(commit|branch|pr)\]\s*/
const PAIR = /^(sha|branch|repo)=(\S*)\s*/

/** 拆出种类、sha、branch、repo 和余下的备注；没有前缀的算文件，备注原样留着 */
export function parseArtifactNote(note: string): ParsedNote {
  const src = note.trimStart()
  const m = PREFIX.exec(src)
  if (!m) return { kind: 'file', text: note.trim() }
  const kv: Partial<Record<'sha' | 'branch' | 'repo', string>> = {}
  let rest = src.slice(m[0].length)
  for (let x = PAIR.exec(rest); x; x = PAIR.exec(rest)) {
    // 空值（sha=）当作没给
    if (x[2]) kv[x[1] as 'sha' | 'branch' | 'repo'] = x[2]
    rest = rest.slice(x[0].length)
  }
  return { kind: m[1] as ArtifactKind, ...kv, text: rest.trim() }
}

/** 提交显示 7 位 sha */
export const shortSha = (sha: string) => sha.slice(0, 7)

/** 按四类分组，组内保持后端顺序（最近登记的在前）；空组不出现 */
export function groupArtifacts(items: readonly Artifact[]) {
  const parsed = items.map((a) => ({ a, p: parseArtifactNote(a.note) }))
  return ARTIFACT_GROUPS
    .map((g) => ({ ...g, items: parsed.filter((x) => x.p.kind === g.key) }))
    .filter((g) => g.items.length > 0)
}

/** 登记时填的位置：http(s) 开头算链接，/ 开头算本机绝对路径，其余不合法 */
export function locationOf(raw: string): { url: string } | { path: string } | null {
  const v = raw.trim()
  if (/^https?:\/\/\S+$/i.test(v)) return { url: v }
  if (v.startsWith('/')) return { path: v }
  return null
}
