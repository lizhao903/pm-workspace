// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出结果的分组（B-08）：MCP 回写时一次提交会给涉及的每个任务各登记一条，同一提交号合并成一行。
// 提交号从备注「[commit] sha=...」里取；没有提交号的、不是提交的，一条一行。
import type { Artifact } from '../../core/data'
import { artifactKind, type ArtifactKind } from '../../core/chat/chatModel'

export type OutputGroup = {
  key: string
  kind: ArtifactKind
  /** 最新的一条，标题、链接、时间按它显示 */
  head: Artifact
  /** 按时间倒序，至少一条 */
  items: Artifact[]
  /** 提交的短提交号 */
  sha?: string
}

export function commitSha(a: Pick<Artifact, 'note'>): string {
  return /\bsha=([0-9a-f]{4,40})\b/i.exec(a.note)?.[1] ?? ''
}

/** 列表已按时间倒序；合并后的行按每组最新一条的位置排 */
export function groupOutputs(list: Artifact[]): OutputGroup[] {
  const out: OutputGroup[] = []
  const bySha = new Map<string, OutputGroup>()
  for (const a of list) {
    const kind = artifactKind(a)
    const sha = kind === 'commit' ? commitSha(a) : ''
    const g = sha ? bySha.get(sha) : undefined
    if (g) { g.items.push(a); continue }
    const n: OutputGroup = { key: sha ? 'commit:' + sha : a.id, kind, head: a, items: [a], sha: sha ? sha.slice(0, 7) : undefined }
    if (sha) bySha.set(sha, n)
    out.push(n)
  }
  return out
}

/** 一组涉及的任务（按对象去重），没归属对象的不算 */
export function groupObjects(g: OutputGroup): { id: string; ref: string; title: string }[] {
  const seen = new Map<string, { id: string; ref: string; title: string }>()
  for (const a of g.items) {
    if (a.object_id && !seen.has(a.object_id)) seen.set(a.object_id, { id: a.object_id, ref: a.object_ref ?? '', title: a.object_title ?? '' })
  }
  return [...seen.values()]
}
