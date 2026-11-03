// 命令面板的「项目」数据源（SPEC-projects-0 联动）：按名称、说明、目录搜，多个词按空格拆开、每个词都要命中
import { projectView, type ProjectView, type WorkObject } from '../../core/data'

/** 一次最多给几条，和命令面板每组露出的条数一致 */
export const SEARCH_MAX = 6

/** 名称开头命中第一个词的排前面，其余保持传进来的顺序（最近更新在前） */
export function searchProjects(rows: readonly WorkObject[], q: string): ProjectView[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hit = rows.map(projectView).filter((p) => {
    const hay = `${p.name} ${p.desc} ${p.root}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  const head = (p: ProjectView) => Number(!p.name.toLowerCase().startsWith(words[0]))
  return [...hit].sort((a, b) => head(a) - head(b)).slice(0, SEARCH_MAX)
}

/** 说明只取第一行，太长的交给面板截断 */
export const firstLine = (s: string) => s.split('\n').map((x) => x.trim()).find(Boolean) ?? ''
