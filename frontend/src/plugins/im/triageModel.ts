// 批量分诊和处理队列的纯函数：消息的分诊状态、队列分段、当前步骤的说法、要分诊的消息。
// 分诊的执行按输入里的 message_id 关联消息（GET /api/sop/runs?input_key=message_id）。
import type { ImMessage, SopBatchResult, SopInputRun } from '../../core/data'

/** 处理队列里「最近完成」一段显示几条 */
export const QUEUE_RECENT = 20

const ACTIVE = new Set(['running', 'waiting'])
export const isActiveRun = (r: Pick<SopInputRun, 'status'>) => ACTIVE.has(r.status)

/** 每条消息最近一次分诊执行（列表按开始时间倒序，取第一次碰到的） */
export function latestByMessage(runs: readonly SopInputRun[]): Map<string, SopInputRun> {
  const out = new Map<string, SopInputRun>()
  for (const r of runs) if (r.input_value && !out.has(r.input_value)) out.set(r.input_value, r)
  return out
}

export type TriageTag = { label: string; tone: 'run' | 'wait' | 'ok' | 'bad' }

/** 消息行上的分诊小标：跑中、等确认、已分诊、失败；终止了的不标 */
export function triageTag(r: Pick<SopInputRun, 'status'> | undefined): TriageTag | null {
  switch (r?.status) {
    case 'running': return { label: '分诊中', tone: 'run' }
    case 'waiting': return { label: '分诊等确认', tone: 'wait' }
    case 'done': return { label: '已分诊', tone: 'ok' }
    case 'failed': return { label: '分诊失败', tone: 'bad' }
  }
  return null
}

/** 队列分两段：进行中的按开始时间先后（先来的在上）；已结束的按结束时间倒序取最近 QUEUE_RECENT 条 */
export function queueSplit(runs: readonly SopInputRun[]) {
  const active = runs.filter(isActiveRun).sort((a, b) => a.started_at.localeCompare(b.started_at))
  const end = (r: SopInputRun) => r.ended_at ?? r.updated_at
  const recent = runs.filter((r) => !isActiveRun(r)).sort((a, b) => end(b).localeCompare(end(a))).slice(0, QUEUE_RECENT)
  return { active, recent }
}

const STEP_STATE: Record<string, string> = {
  pending: '未开始', running: '执行中', paused: '等确认', review: '待审核', done: '已完成', failed: '失败', skipped: '已跳过', bypassed: '没走到',
}

/** 当前步骤和它的状态：「步骤名 · 执行中」；在排队等模型名额时「步骤名 · 排队中，前面 N 个」 */
export function focusText(r: SopInputRun): string {
  const s = r.steps[r.focus]
  if (!s) return ''
  const state = s.queue ? `排队中，前面 ${s.queue.ahead} 个` : STEP_STATE[s.status] ?? s.status
  return `${s.name || s.key} · ${state}`
}

/** 已等多久：不到 1 分钟、N 分钟、N 小时、N 天 */
export function waitFor(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
  if (m < 1) return '不到 1 分钟'
  if (m < 60) return `${m} 分钟`
  if (m < 1440) return `${Math.floor(m / 60)} 小时`
  return `${Math.floor(m / 1440)} 天`
}

/** 进行中的执行有没有步骤在排队 */
export const isQueued = (r: SopInputRun) => r.steps.some((s) => !!s.queue)

/** 失败的执行能重试的步骤：当前步骤是失败的；已按最新流程重跑过的（relaunched_to）不能再重试 */
export const retryStep = (r: SopInputRun) => (r.status === 'failed' && !r.relaunched_to && r.steps[r.focus]?.status === 'failed' ? r.focus : null)

/** 消息摘要：发信人、群（私聊写私聊）、正文前 40 字 */
export function messageBrief(m: Pick<ImMessage, 'contact_name' | 'sender_name' | 'conversation' | 'text'>) {
  return {
    who: m.contact_name || m.sender_name,
    where: m.conversation || '私聊',
    text: m.text.replace(/\s+/g, ' ').trim().slice(0, 40),
  }
}

/**
 * 要分诊的消息：勾了的就是勾了的，没勾就是当前筛选结果全部；超过 max 时 over 为真，不发起，让人先缩小范围
 */
export function triageTargets(picked: readonly ImMessage[], rows: readonly ImMessage[], max: number) {
  const from = picked.length ? 'picked' as const : 'filter' as const
  const list = picked.length ? picked : rows
  return { from, list, over: list.length > max }
}

/** 这些消息里已经被这条流程跑过的条数（任意状态） */
export function alreadyRun(runs: readonly SopInputRun[], flowId: string, ids: readonly string[]) {
  const done = new Set(runs.filter((r) => r.flow_id === flowId).map((r) => r.input_value))
  return ids.filter((id) => done.has(id)).length
}

/** 批量分诊结果的一句话（标题行提示位置窄，说短） */
export function triageNote(r: SopBatchResult) {
  const parts = [`分诊发起 ${r.started.length} 条`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 条已跑过的`)
  if (r.failed.length) parts.push(`${r.failed.length} 条没发起成：${r.failed[0].error ?? ''}`)
  return { text: parts.join('，'), bad: r.failed.length > 0 }
}
