import { describe, expect, it } from 'vitest'
import type { SopInputRun, SopRun, SopRunStep, SopStepDef } from '../../core/data'
import { attemptChildId, attemptStatus, summarizeTriage, triageAttempts, triageBrief } from './triageSummary'

// 两条流程的形状同 7796 上的「消息分诊：要不要我处理」「消息分流：按项目归档」，步骤 key 故意换掉，确认不认 key
const TRIAGE_DEFS: SopStepDef[] = [
  { key: 's1', name: '读取消息', kind: 'im_get_message', after: [] },
  { key: 's2', name: '已经忽略了吗', kind: 'decide', after: ['s1'], rule: 'message.status 等于 ignored', cases: [{ key: 'ignored', label: '已忽略，不判' }, { key: 'go', label: '继续判断' }] },
  { key: 's3', name: '整理判断材料', kind: 'template', after: ['s2'], branch: { of: 's2', case: 'go' }, config: { output: 'brief' } },
  { key: 's4', name: '要不要我处理', kind: 'classifier', after: ['s3'], cases: [{ key: 'handle', label: '需要我处理' }, { key: 'ignore', label: '忽略' }] },
  { key: 's5', name: '写处理建议', kind: 'ai', after: ['s4'], branch: { of: 's4', case: 'handle' }, config: { output: 'advice' } },
  { key: 's6', name: '标成已忽略', kind: 'im_mark_message', after: ['s4'], branch: { of: 's4', case: 'ignore' }, config: { state: 'ignore' } },
  { key: 's7', name: '标记要建任务', kind: 'template', after: ['s5'], config: { output: 'need', template: 'yes' } },
]
const ROUTE_DEFS: SopStepDef[] = [
  { key: 'r_read', name: '读取消息', kind: 'im_get_message', after: [] },
  { key: 'r_kw', name: '群名带 xaue', kind: 'decide', after: ['r_read'], rule: 'message.conversation 包含 xaue', cases: [{ key: 'yes', label: '是 XAUE 的群' }, { key: 'no', label: '不是' }] },
  { key: 'r_cls', name: '按内容判断属于哪个项目', kind: 'classifier', after: ['r_kw'], branch: { of: 'r_kw', case: 'no' }, cases: [{ key: 'xaue', label: 'XAUE' }, { key: 'other', label: '非项目' }] },
  { key: 'r_hit1', name: '按群名归 XAUE', kind: 'auto', after: ['r_kw'], branch: { of: 'r_kw', case: 'yes' } },
  { key: 'r_hit2', name: '按内容归 XAUE', kind: 'auto', after: ['r_cls'], branch: { of: 'r_cls', case: 'xaue' } },
  { key: 'r_join', name: 'XAUE', kind: 'aggregate', after: ['r_hit1', 'r_hit2'] },
  { key: 'r_set', name: '归到 XAUE', kind: 'im_set_project', after: ['r_join'] },
  { key: 'r_sub', name: '走分诊', kind: 'subflow', after: ['r_set'] },
  { key: 'r_need', name: '要我处理吗', kind: 'decide', after: ['r_sub'], rule: 'subflow.output.need 等于 yes', cases: [{ key: 'handle', label: '要处理' }, { key: 'skip', label: '可忽略' }] },
  { key: 'r_task', name: '建任务', kind: 'task', after: ['r_need'], branch: { of: 'r_need', case: 'handle' } },
  { key: 'r_other', name: '走分诊', kind: 'subflow', after: ['r_cls'], branch: { of: 'r_cls', case: 'other' } },
]

type S = Partial<SopRunStep> & { status: SopRunStep['status'] }
function detail(id: string, flowName: string, defs: SopStepDef[], st: Record<string, S>, p: Partial<SopRun> = {}): SopRun {
  return {
    id, flow_id: `sop_${flowName}`, flow_name: flowName, flow_version: 1,
    flow: { id: `sop_${flowName}`, name: flowName, desc: '', trigger: 'manual', fields: [], steps: defs, version: 1, created_at: '', updated_at: '' },
    title: '', input: { message_id: 'msg_1' }, step_through: false, stopped: false, status: 'done', source: 'manual',
    started_at: '2026-11-02T08:53:24.958Z', ended_at: '2026-11-02T08:53:33.414Z', updated_at: '2026-11-02T08:53:33.414Z',
    steps: defs.map((d) => ({ key: d.key, input: null, output: null, attempts: 1, log: [], ...(st[d.key] ?? { status: 'bypassed' }) })),
    ...p,
  }
}
const ADVICE = '对方报告 XAUE Shop 无法连接多签钱包并请求排查。\n回复「收到，正在检查」，定位后同步进展。'

const handledChild = (p: Partial<SopRun> = {}) => detail('spr_child', '消息分诊', TRIAGE_DEFS, {
  s1: { status: 'done' },
  s2: { status: 'done', route: 'go', route_reason: '规则「message.status 等于 ignored」不成立' },
  s3: { status: 'done', output: { brief: 'b' } },
  s4: { status: 'done', route: 'handle', route_reason: '模型判断属于「需要我处理」' },
  s5: { status: 'done', output: { brief: 'b', advice: ADVICE } },
  s7: { status: 'done', output: { brief: 'b', advice: ADVICE, need: 'yes' } },
}, { parent_run_id: 'spr_top', parent_step: 'r_sub', source: 'subflow', ...p })

const routedTop = (p: Partial<SopRun> = {}) => detail('spr_top', '消息分流', ROUTE_DEFS, {
  r_read: { status: 'done' },
  r_kw: { status: 'done', route: 'yes', route_reason: '规则「message.conversation 包含 xaue」成立' },
  r_hit1: { status: 'done' },
  r_join: { status: 'done' },
  r_set: { status: 'done', output: { project: { id: 'obj_x', ref: 'PRJ-0008', name: 'XAUE' } } },
  r_sub: { status: 'done', child_run_id: 'spr_child', output: { project: { id: 'obj_x' }, subflow: { flow_id: 'sop_t', output: { advice: ADVICE, need: 'yes' } } } },
  r_need: { status: 'done', route: 'handle', route_reason: '规则「subflow.output.need 等于 yes」成立' },
  r_task: { status: 'done', output: { project: { id: 'obj_x' }, task: { id: 'obj_t', ref: 'TSK-0385', title: '[#xaue-技术支持] Jenna 的消息待处理' } } },
}, p)

describe('分诊结论：分流套分诊', () => {
  it('要处理：建议原文、按群名归项目、建了任务、两条流程名', () => {
    const s = summarizeTriage(routedTop(), [handledChild()])
    expect(s.verdict).toBe('handle')
    expect(s.label).toBe('要处理')
    expect(s.reason).toBe('模型判断属于「需要我处理」')
    expect(s.advice).toBe(ADVICE)
    expect(s.project).toEqual({ id: 'obj_x', ref: 'PRJ-0008', name: 'XAUE' })
    expect(s.by).toEqual({ how: '按群名', why: '规则「message.conversation 包含 xaue」成立' })
    expect(s.tasks).toEqual([{ id: 'obj_t', ref: 'TSK-0385', title: '[#xaue-技术支持] Jenna 的消息待处理' }])
    expect(s.flow).toBe('消息分流')
    expect(s.subFlow).toBe('消息分诊')
    expect(s.runId).toBe('spr_top')
    expect(s.childId).toBe('spr_child')
  })

  it('子执行详情没取到时，建议从子流程节点带回的 subflow.output 里取', () => {
    const s = summarizeTriage(routedTop())
    expect(s.verdict).toBe('handle')
    expect(s.advice).toBe(ADVICE)
  })

  it('按内容分到「非项目」：没有项目，写那一路的名字和判定方式；子流程里忽略了', () => {
    const top = detail('spr_top', '消息分流', ROUTE_DEFS, {
      r_read: { status: 'done' },
      r_kw: { status: 'done', route: 'no', route_reason: '规则不成立' },
      r_cls: { status: 'done', route: 'other', route_reason: '模型判断属于「非项目」' },
      r_other: { status: 'done', child_run_id: 'spr_child' },
    })
    const child = detail('spr_child', '消息分诊', TRIAGE_DEFS, {
      s1: { status: 'done' }, s2: { status: 'done', route: 'go' }, s3: { status: 'done' },
      s4: { status: 'done', route: 'ignore', route_reason: '模型判断属于「忽略」' },
      s6: { status: 'done', output: { marked: { message_id: 'msg_1', state: 'ignore', status: 'ignored' } } },
    })
    const s = summarizeTriage(top, [child])
    expect(s.verdict).toBe('ignore')
    expect(s.label).toBe('可忽略')
    expect(s.reason).toBe('模型判断属于「忽略」；已标为已忽略')
    expect(s.project).toBeNull()
    expect(s.routeLabel).toBe('非项目')
    expect(s.by).toEqual({ how: '按内容', why: '模型判断属于「非项目」' })
    expect(s.tasks).toEqual([])
    expect(s.advice).toBe('')
  })

  it('子执行做完、父执行还在建任务：算分诊中，建议已经有了', () => {
    const top = routedTop({ status: 'running', ended_at: undefined })
    top.steps = top.steps.map((x) => (x.key === 'r_task' ? { ...x, status: 'running', output: null } : x))
    const s = summarizeTriage(top, [handledChild()])
    expect(s.verdict).toBe('running')
    expect(s.step).toBe('建任务 · 执行中')
    expect(s.advice).toBe(ADVICE)
  })
})

describe('分诊结论：直接分诊', () => {
  it('已经忽略的消息跳过判断：已忽略，未判断', () => {
    const r = detail('spr_1', '消息分诊', TRIAGE_DEFS, {
      s1: { status: 'done' }, s2: { status: 'done', route: 'ignored', route_reason: '规则「message.status 等于 ignored」成立' },
    })
    const s = summarizeTriage(r)
    expect(s.verdict).toBe('skipped')
    expect(s.label).toBe('已忽略，未判断')
    expect(s.reason).toBe('规则「message.status 等于 ignored」成立')
    expect(s.project).toBeNull()
    expect(s.by).toBeNull()
    expect(s.subFlow).toBe('')
  })

  it('要处理：ai 节点的输出字段不叫 advice 时也取得到', () => {
    const defs = TRIAGE_DEFS.map((d) => (d.key === 's5' ? { ...d, config: { output: 'suggestion' } } : d))
    const r = detail('spr_1', '消息分诊', defs, {
      s1: { status: 'done' }, s2: { status: 'done', route: 'go' }, s3: { status: 'done' },
      s4: { status: 'done', route: 'handle', route_reason: '模型判断属于「需要我处理」' },
      s5: { status: 'done', output: { suggestion: '回他一句' } },
      s7: { status: 'done', output: { suggestion: '回他一句', need: 'yes' } },
    })
    const s = summarizeTriage(r)
    expect(s.verdict).toBe('handle')
    expect(s.advice).toBe('回他一句')
  })

  it('失败：失败的步骤和原因', () => {
    const r = detail('spr_1', '消息分诊', TRIAGE_DEFS, {
      s1: { status: 'done' }, s2: { status: 'done', route: 'go' }, s3: { status: 'done' },
      s4: { status: 'failed', error: '模型调用失败：连不上服务商' },
      s5: { status: 'pending' }, s6: { status: 'pending' }, s7: { status: 'pending' },
    }, { status: 'failed' })
    const s = summarizeTriage(r)
    expect(s.verdict).toBe('failed')
    expect(s.label).toBe('分诊失败')
    expect(s.step).toBe('要不要我处理')
    expect(s.error).toBe('模型调用失败：连不上服务商')
  })

  it('进行中：当前步骤，排队时写前面几个；等确认', () => {
    const r = detail('spr_1', '消息分诊', TRIAGE_DEFS, {
      s1: { status: 'done' }, s2: { status: 'done', route: 'go' }, s3: { status: 'done' },
      s4: { status: 'running', queue: { ahead: 2 } }, s5: { status: 'pending' }, s6: { status: 'pending' }, s7: { status: 'pending' },
    }, { status: 'running', ended_at: undefined })
    expect(summarizeTriage(r)).toMatchObject({ verdict: 'running', label: '分诊中', step: '要不要我处理 · 排队中，前面 2 个' })
    const w = { ...r, status: 'waiting' as const, steps: r.steps.map((x) => (x.key === 's4' ? { ...x, status: 'review' as const, queue: undefined } : x)) }
    expect(summarizeTriage(w)).toMatchObject({ verdict: 'waiting', step: '要不要我处理 · 等人检查' })
  })

  it('终止了的', () => {
    const r = detail('spr_1', '消息分诊', TRIAGE_DEFS, { s1: { status: 'done' } }, { status: 'stopped', stopped: true })
    expect(summarizeTriage(r).verdict).toBe('stopped')
  })

  it('悬停摘要：结论 + 建议前 80 字，没有建议写理由', () => {
    const s = summarizeTriage(routedTop(), [handledChild()])
    const long = { ...s, advice: '字'.repeat(100) }
    expect(triageBrief(long)).toBe(`要处理：${'字'.repeat(80)}…`)
    expect(triageBrief(s)).toBe(`要处理：${ADVICE.replace(/\s+/g, ' ')}`)
    expect(triageBrief({ ...s, advice: '', reason: '模型判断属于「忽略」', label: '可忽略' })).toBe('可忽略：模型判断属于「忽略」')
    expect(triageBrief({ ...s, advice: '', reason: '', label: '已终止' })).toBe('已终止')
  })
})

let seq = 0
function brief(p: Partial<SopInputRun>): SopInputRun {
  seq += 1
  return {
    id: `spr_${seq}`, flow_id: 'sop_a', flow_name: '分诊', flow_version: 1, title: '', step_through: false, stopped: false, status: 'done',
    source: 'manual', started_at: '2026-11-02T01:00:00.000Z', updated_at: '2026-11-02T01:00:00.000Z', focus: 0, steps: [], input_value: 'msg_1', ...p,
  }
}

describe('多次分诊：按父子归成一次次', () => {
  it('子执行挂到父执行下，最近一次在前；父执行不在列表里的子执行自己算一次', () => {
    const t1 = brief({ id: 'top1', started_at: '2026-11-01T01:00:00.000Z' })
    const c1 = brief({ id: 'kid1', parent_run_id: 'top1', started_at: '2026-11-01T01:00:01.000Z' })
    const t2 = brief({ id: 'top2', started_at: '2026-11-02T01:00:00.000Z', status: 'running' })
    const c2 = brief({ id: 'kid2', parent_run_id: 'top2', started_at: '2026-11-02T01:00:01.000Z' })
    const orphan = brief({ id: 'kid3', parent_run_id: 'gone', started_at: '2026-10-30T01:00:00.000Z' })
    const other = brief({ id: 'x', input_value: 'msg_2' })
    const m = triageAttempts([c2, t2, c1, t1, orphan, other])
    const as = m.get('msg_1')!
    expect(as.map((a) => a.top.id)).toEqual(['top2', 'top1', 'kid3'])
    expect(as[0].children.map((r) => r.id)).toEqual(['kid2'])
    expect(attemptChildId(as[0])).toBe('kid2')
    expect(attemptChildId(as[2])).toBeNull()
    expect(m.get('msg_2')).toHaveLength(1)
    // 子执行做完、父执行还在跑：整次算执行中
    expect(attemptStatus(as[0])).toBe('running')
    expect(attemptStatus(as[1])).toBe('done')
  })

  it('整次的状态：子执行失败算失败；已重跑过的失败不算；等确认优先于执行中', () => {
    const top = brief({ id: 'a', status: 'running' })
    expect(attemptStatus({ top, children: [brief({ status: 'failed' })] })).toBe('failed')
    expect(attemptStatus({ top: brief({ status: 'failed', relaunched_to: 'b' }), children: [] })).toBe('failed')
    expect(attemptStatus({ top, children: [brief({ status: 'failed', relaunched_to: 'b' })] })).toBe('running')
    expect(attemptStatus({ top, children: [brief({ status: 'waiting' })] })).toBe('waiting')
    expect(attemptStatus({ top: brief({ status: 'stopped' }), children: [] })).toBe('stopped')
  })
})
