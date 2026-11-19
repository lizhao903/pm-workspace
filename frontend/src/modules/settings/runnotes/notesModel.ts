// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「快捷说明」（SPEC-settings-32）的校验：和后端 cleanRunQuickNotes 同一套上限，前端先挡，其余以后端为准。
import type { RunQuickNote } from '../../../core/data'

export const NOTE_MAX = 20
export const NOTE_LABEL_MAX = 12
export const NOTE_TEXT_MAX = 500

/** 每一条的问题（没有就是空串），下标同输入 */
export type NoteIssue = { label: string; text: string }

export function noteIssues(list: readonly RunQuickNote[]): NoteIssue[] {
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

/** 保存前去掉首尾空白 */
export const cleanNotes = (list: readonly RunQuickNote[]): RunQuickNote[] => list.map((n) => ({ label: n.label.trim(), text: n.text.trim() }))

export const sameNotes = (a: readonly RunQuickNote[], b: readonly RunQuickNote[]) => JSON.stringify(cleanNotes(a)) === JSON.stringify(cleanNotes(b))
