import { describe, expect, it } from 'vitest'
import type { SopPipeline, SopWaitingItem, StageChange, WorkObject } from '../../core/data'
import { backToPipeline, durationText, stageSpans, stageTotals, stepTags, timelineRows, waitingTodayItems } from './pipelineModel'

const T0 = Date.parse('2026-11-04T01:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const changes: StageChange[] = [
  { id: 'a1', at: at(0), from: '', to: 'received', actor: 'im' },
  { id: 'a2', at: at(5), from: 'received', to: 'designing', actor: 'sop' },
  { id: 'a3', at: at(65), from: 'designing', to: 'reviewing', actor: 'sop' },
  { id: 'a4', at: at(80), from: 'reviewing', to: 'designing', actor: 'sop' },
  { id: 'a5', at: at(100), from: 'designing', to: 'need_human', actor: 'sop' },
]

const pipeline: SopPipeline = {
  task_id: 'obj_t1',
  budget: { claude_runs: 3, claude_minutes: 70, max_runs: 30, max_minutes: 0 },
  claude: [],
  blockers: [],
  runs: [{
    id: 'spr_1', flow_id: 'sop_im_auto_intake', flow_name: 'IM 需求自动受理', title: '受理', status: 'waiting', started_at: at(1),
    steps: [
      { key: 'read', name: '读取消息', kind: 'im_get_message', status: 'done', attempts: 1, started_at: at(1), ended_at: at(1) },
      { key: 'prd', name: '写 PRD', kind: 'claude_code', status: 'done', attempts: 3, round: 2, started_at: at(80), ended_at: at(95) },
      { key: 'gate', name: '评审不通过就退回', kind: 'loopback', status: 'done', attempts: 2, loops: 3, started_at: at(99), ended_at: at(99) },
      { key: 'dev', name: '研发', kind: 'claude_code', status: 'paused', attempts: 0, started_at: at(100),
        hold: { kind: 'runs', reason: '需求 TSK-0001 已经跑了 30 次 Claude Code，到了上限 30 次', since: at(100) } },
      { key: 'skip', name: '没走到', kind: 'end', status: 'bypassed', attempts: 0 },
      { key: 'later', name: '还没开始', kind: 'end', status: 'pending', attempts: 0 },
    ],
  }],
}

describe('流水线时间线（SPEC-sop-16）', () => {
  it('耗时写法', () => {
    expect(durationText(20_000)).toBe('不到 1 分钟')
    expect(durationText(5 * 60_000)).toBe('5 分钟')
    expect(durationText(125 * 60_000)).toBe('2 小时 5 分')
    expect(durationText(26 * 3600_000)).toBe('1 天 2 小时')
  })

  it('阶段切成段：耗时到下一次变化，当前阶段算到现在；同一阶段多次进出累计', () => {
    const spans = stageSpans(changes, T0 + 130 * 60_000)
    expect(spans.map((s) => [s.label, s.ms / 60_000, s.current])).toEqual([
      ['已接收', 5, false], ['设计中', 60, false], ['评审中', 15, false], ['设计中', 20, false], ['需人工', 30, true],
    ])
    expect(spans.at(-1)!.waiting).toBe(true)
    const totals = stageTotals(spans)
    expect(totals.find((t) => t.label === '设计中')).toMatchObject({ ms: 80 * 60_000, times: 2 })
  })

  it('步骤标记：轮次、重试、退回轮数、超出上限', () => {
    const [, prd, gate, dev] = pipeline.runs[0].steps
    expect(stepTags(prd)).toEqual(['第 2 轮', '重试 1 次'])
    expect(stepTags({ ...prd, attempts: 2 })).toEqual(['第 2 轮'])
    expect(stepTags(gate)).toEqual(['重试 1 次', '已退回 3 轮'])
    expect(stepTags(dev)).toEqual(['超出上限暂停'])
  })

  it('合成时间线：按时间排，没开始和没走到的步骤不进来，同一时刻阶段在前', () => {
    const rows = timelineRows(changes, pipeline, T0 + 130 * 60_000)
    expect(rows.map((r) => (r.kind === 'step' ? `步骤:${r.step.key}` : r.kind === 'run' ? `执行:${r.label}` : `阶段:${r.label}`))).toEqual([
      '阶段:已接收', '执行:IM 需求自动受理', '步骤:read', '阶段:设计中', '阶段:评审中', '阶段:设计中', '步骤:prd', '步骤:gate', '阶段:需人工', '步骤:dev',
    ])
    const dev = rows.at(-1)!
    expect(dev.kind === 'step' && dev.ms).toBe(30 * 60_000)
  })

  it('从执行页返回时回到流水线标签', () => {
    expect(backToPipeline('/tasks?t=obj_1&sop_run=x')).toBe('/tasks?t=obj_1&sop_run=x&tab=pipeline')
    expect(backToPipeline('/today')).toBe('/today?tab=pipeline')
  })
})

describe('今日「待我处理」（SPEC-today-1.30）', () => {
  const task = (id: string, ref: string, stage: string): WorkObject => ({
    id, type_id: 'task', ref, title: `需求${ref}`, body: '', status: 'doing', priority: '', owner: '', owner_id: null, category_id: null,
    project_id: null, source: '', props: { stage }, workdir: '', due_at: null, started_at: null, completed_at: null, archived_at: null,
    deleted_at: null, created_at: at(0), updated_at: at(10), tags: [], link_count: 0, participants: [],
  })
  const step = (p: Partial<SopWaitingItem>): SopWaitingItem => ({
    run_id: 'spr_1', run_title: '研发 pipeline · x', flow_id: 'sop_im_dev_pipeline', flow_name: '研发 pipeline', step_key: 'accept',
    step_name: '人工验收', step_kind: 'decide', step_status: 'review', wait: 'decide', reason: '等人工判断走哪个分支', since: at(20), ...p,
  })

  it('步骤去执行页，阶段任务去流水线标签；同一需求已有等人的步骤时阶段那条不重复', () => {
    const r = waitingTodayItems(
      [step({ task_id: 'obj_a' }), step({ run_id: 'spr_2', step_key: 'dev', step_name: '研发', wait: 'hold', reason: '到了上限 30 次', task_id: 'obj_x' })],
      [task('obj_a', 'TSK-0001', 'accepting'), task('obj_b', 'TSK-0002', 'confirm_project'), task('obj_c', 'TSK-0003', 'need_human')],
    )
    expect(r.total).toBe(4)
    const [decide, hold, pick, human] = r.items
    expect(decide).toMatchObject({ title: '人工验收 · 研发 pipeline', action: '去判断', to: '/sop/runs/spr_1', tone: 'warn' })
    expect(decide.sub).toBe('TSK-0001 需求TSK-0001 · 待验收 · 等人工判断')
    expect(hold).toMatchObject({ action: '去放行', tone: 'danger', to: '/sop/runs/spr_2', sub: '研发 pipeline · x · 超出上限暂停：到了上限 30 次' })
    expect(pick).toMatchObject({ title: 'TSK-0002 需求TSK-0002', action: '去选项目', to: '/tasks?t=obj_b&tab=pipeline' })
    expect(human).toMatchObject({ action: '去裁决', tone: 'danger', sub: '需人工 · 流程转人工，等你裁决' })
  })
})
