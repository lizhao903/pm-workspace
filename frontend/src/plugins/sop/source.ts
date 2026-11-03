// 执行的发起来源（SOP-06）：「手动」「手动（批量重跑）」「Agent：分诊助手」「定时：周一例会」「IM 消息」「子流程」「插件：video」。
// Agent、定时任务的名字现查（改名后跟着变），查不到用发起那一刻记下的 source_name，再没有用 id；以前的执行没有来源，不显示
import { useMemo } from 'react'
import { useAgents, useSchedules, type SopRunBrief } from '../../core/data'

type Src = Pick<SopRunBrief, 'source' | 'source_ref' | 'source_name'>
export type NameOf = (kind: 'agent' | 'schedule', id: string) => string | undefined

export function sourceText(r: Src, nameOf: NameOf = () => undefined): string {
  const ref = r.source_ref ?? ''
  const name = (kind: 'agent' | 'schedule') => (ref && nameOf(kind, ref)) || r.source_name || ref
  switch (r.source) {
    // 界面上批量发起、批量重跑的记了 source_name
    case 'manual': return r.source_name ? `手动（${r.source_name}）` : '手动'
    case 'agent': return name('agent') ? `Agent：${name('agent')}` : 'Agent'
    case 'schedule': return name('schedule') ? `定时：${name('schedule')}` : '定时'
    case 'im': return 'IM 消息'
    case 'subflow': return '子流程'
    case 'plugin': return r.source_name || ref ? `插件：${r.source_name || ref}` : '插件'
    default: return ''
  }
}

/** 按当前的 Agent、定时任务列表现查名字；列表没取到时退回记下的名字 */
export function useSourceText(): (r: Src) => string {
  const agents = useAgents()
  const schedules = useSchedules()
  return useMemo(() => {
    const a = new Map((agents.data ?? []).map((x) => [x.id, x.name]))
    const s = new Map((schedules.data ?? []).map((x) => [x.id, x.name]))
    const nameOf: NameOf = (kind, id) => (kind === 'agent' ? a : s).get(id)
    return (r: Src) => sourceText(r, nameOf)
  }, [agents.data, schedules.data])
}
