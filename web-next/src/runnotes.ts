// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 快捷说明（SPEC-settings-32、SPEC-tasks-6.40，用户 2026-11-19 提）：「交给执行」弹窗附加说明上面一排芯片，点一个把文字追加进附加说明。
// 原型只放内存，刷新回到内置的一组；正式产品 GET / PUT /api/run-quick-notes（整组替换），校验同 frontend/src/modules/settings/runnotes/notesModel.ts。
import { useSyncExternalStore } from 'react'

export type RunQuickNote = { label: string; text: string }

export const NOTE_MAX = 20
export const NOTE_LABEL_MAX = 12
export const NOTE_TEXT_MAX = 500

/** 没设过时的内置六条（前两条取自执行记录里出现过的附加说明） */
export const DEFAULT_NOTES: RunQuickNote[] = [
  { label: '整理需求及原型', text: '整理需求及对应原型' },
  { label: '需求设计回写任务', text: '输出需求设计和原型文档后，更新到当前任务信息中' },
  { label: '只读调研', text: '只读调研，不改代码：读相关代码和文档，给出结论和建议的改法' },
  { label: '修复并补测试', text: '修复问题并补上能复现这个问题的测试，相关测试跑通后再提交' },
  { label: '按规格同步原型', text: '按规格同步原型：对照规格文档改原型，规格没写的不要自己加' },
  { label: '更新 PRD 并回复', text: '更新 PRD 与原型，完成后回复原消息，说明改了什么、在哪里看' },
]

let state: RunQuickNote[] = DEFAULT_NOTES
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export const useRunQuickNotes = () => useSyncExternalStore(subscribe, () => state)

/** 整组替换（去首尾空白）；保存过（包括全删）就以保存的为准，以后不补内置的 */
export function saveRunQuickNotes(list: readonly RunQuickNote[]) {
  state = cleanNotes(list)
  subs.forEach((f) => f())
}

/** 每一条的问题（没有就是空串），下标同输入 */
export function noteIssues(list: readonly RunQuickNote[]): { label: string; text: string }[] {
  const seen = new Set<string>()
  return list.map((n) => {
    const label = n.label.trim()
    const text = n.text.trim()
    let l = ''
    if (!label) l = '写一个名称'
    else if ([...label].length > NOTE_LABEL_MAX) l = `最多 ${NOTE_LABEL_MAX} 字`
    else if (seen.has(label)) l = '和上面的重复了'
    seen.add(label)
    let t = ''
    if (!text) t = '写上要填进附加说明的文字'
    else if ([...text].length > NOTE_TEXT_MAX) t = `最多 ${NOTE_TEXT_MAX} 字`
    return { label: l, text: t }
  })
}

export const cleanNotes = (list: readonly RunQuickNote[]): RunQuickNote[] => list.map((n) => ({ label: n.label.trim(), text: n.text.trim() }))
export const sameNotes = (a: readonly RunQuickNote[], b: readonly RunQuickNote[]) => JSON.stringify(cleanNotes(a)) === JSON.stringify(cleanNotes(b))

/** 点快捷说明：追加到附加说明末尾，另起一行；已经有这段文字时不重复加；附加说明是空的就直接用这段 */
export function appendQuickNote(extra: string, text: string): string {
  const t = text.trim()
  if (!t || extra.includes(t)) return extra
  const head = extra.replace(/\s+$/, '')
  return head ? `${head}\n${t}` : t
}
