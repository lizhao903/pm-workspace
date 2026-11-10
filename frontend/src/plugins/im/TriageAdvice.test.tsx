// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage, SopInputRun, SopStepDef } from '../../core/data'
import { GroupTriageSection, TriageSection, TriageTagButton } from './TriageAdvice'
import { triageAttempts } from './triageSummary'

const DEFS: SopStepDef[] = [
  { key: 'read', name: '读取消息', kind: 'im_get_message', after: [] },
  { key: 'triage', name: '要不要我处理', kind: 'classifier', after: ['read'], cases: [{ key: 'handle', label: '需要我处理' }, { key: 'ignore', label: '忽略' }] },
  { key: 'advise', name: '写处理建议', kind: 'ai', after: ['triage'], branch: { of: 'triage', case: 'handle' }, config: { output: 'advice' } },
  { key: 'drop', name: '标成已忽略', kind: 'im_mark_message', after: ['triage'], branch: { of: 'triage', case: 'ignore' } },
]
const flow = { id: 'sop_t', name: '消息分诊', desc: '', trigger: 'manual', fields: [], steps: DEFS, version: 1, created_at: '', updated_at: '' }

function detail(id: string, route: 'handle' | 'ignore', advice: string, started: string) {
  return {
    id, flow_id: 'sop_t', flow_name: '消息分诊', flow_version: 1, flow, title: '', input: {}, step_through: false, stopped: false, status: 'done',
    source: 'manual', started_at: started, ended_at: started, updated_at: started,
    steps: [
      { key: 'read', status: 'done', attempts: 1, log: [] },
      { key: 'triage', status: 'done', route, route_reason: `模型判断属于「${route === 'handle' ? '需要我处理' : '忽略'}」`, attempts: 1, log: [] },
      route === 'handle'
        ? { key: 'advise', status: 'done', output: { advice }, attempts: 1, log: [] }
        : { key: 'advise', status: 'bypassed', attempts: 0, log: [] },
      route === 'ignore'
        ? { key: 'drop', status: 'done', output: { marked: { state: 'ignore' } }, attempts: 1, log: [] }
        : { key: 'drop', status: 'bypassed', attempts: 0, log: [] },
    ],
  }
}

let details: Record<string, unknown> = {}
let reads: string[] = []

function brief(id: string, msg: string, started: string): SopInputRun {
  return {
    id, flow_id: 'sop_t', flow_name: '消息分诊', flow_version: 1, title: '', step_through: false, stopped: false, status: 'done', source: 'manual',
    started_at: started, ended_at: started, updated_at: started, focus: 0, steps: [], input_value: msg,
  }
}

const NEW = '2026-11-02T08:00:00.000Z'
const OLD = '2026-11-01T08:00:00.000Z'

beforeEach(() => {
  reads = []
  details = {
    run_new: detail('run_new', 'handle', '对方要报价单，今天下班前回复', NEW),
    run_old: detail('run_old', 'ignore', '', OLD),
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const p = new URL(String(input), 'http://x').pathname
    const m = p.match(/^\/api\/sop\/runs\/([^/]+)$/)
    if (m && details[m[1]]) {
      reads.push(m[1])
      return new Response(JSON.stringify({ data: details[m[1]] }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const msg = (id: string, at: string, text: string) => ({ id, at, text }) as ImMessage

describe('消息抽屉的分诊建议', () => {
  it('默认最近一次：结论、建议原文、查看执行；展开历史切到上一次', async () => {
    const attempts = triageAttempts([brief('run_new', 'msg_1', NEW), brief('run_old', 'msg_1', OLD)]).get('msg_1')!
    const onOpenRun = vi.fn()
    wrap(<TriageSection attempts={attempts} onStart={vi.fn()} onOpenRun={onOpenRun} onOpenTask={vi.fn()} />)
    const sec = screen.getByRole('region', { name: '分诊建议' })
    expect(await within(sec).findByLabelText('处理建议')).toHaveTextContent('对方要报价单，今天下班前回复')
    expect(within(sec).getByText('要处理')).toBeInTheDocument()
    expect(within(sec).getByText('模型判断属于「需要我处理」')).toBeInTheDocument()
    // 只取了最近一次的详情
    expect(reads).toEqual(['run_new'])
    await userEvent.click(within(sec).getByRole('button', { name: '查看执行' }))
    expect(onOpenRun).toHaveBeenCalledWith('run_new')

    await userEvent.click(within(sec).getByRole('button', { name: '共分诊 2 次，看历史' }))
    const rows = within(screen.getByRole('list', { name: '历史分诊' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    await userEvent.click(rows[1])
    expect(await within(sec).findByText('可忽略')).toBeInTheDocument()
    expect(within(sec).getByText('模型判断属于「忽略」；已标为已忽略')).toBeInTheDocument()
    expect(within(sec).queryByLabelText('处理建议')).toBeNull()
  })

  it('建了任务的能点开任务', async () => {
    const d = details.run_new as ReturnType<typeof detail>
    d.flow = { ...flow, steps: [...DEFS, { key: 'task', name: '建任务', kind: 'task', after: ['advise'] }] }
    d.steps.push({ key: 'task', status: 'done', output: { task: { id: 'obj_t', ref: 'TSK-0001', title: '回报价' } }, attempts: 1, log: [] } as never)
    const onOpenTask = vi.fn()
    wrap(<TriageSection attempts={triageAttempts([brief('run_new', 'msg_1', NEW)]).get('msg_1')!} onStart={vi.fn()} onOpenRun={vi.fn()} onOpenTask={onOpenTask} />)
    await userEvent.click(await screen.findByRole('button', { name: /TSK-0001/ }))
    expect(onOpenTask).toHaveBeenCalledWith('obj_t')
    expect(screen.queryByRole('button', { name: /看历史/ })).toBeNull()
  })

  it('没分诊过：给「发起分诊」，不取详情', async () => {
    const onStart = vi.fn()
    wrap(<TriageSection attempts={[]} onStart={onStart} onOpenRun={vi.fn()} onOpenTask={vi.fn()} />)
    expect(screen.getByText('还没分诊过')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '发起分诊' }))
    expect(onStart).toHaveBeenCalled()
    expect(reads).toEqual([])
  })

  it('详情读不出来时说原因', async () => {
    wrap(<TriageSection attempts={triageAttempts([brief('run_gone', 'msg_1', NEW)]).get('msg_1')!} onStart={vi.fn()} onOpenRun={vi.fn()} onOpenTask={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('分诊详情没读出来')
  })
})

describe('组抽屉的分诊建议', () => {
  it('最新分诊过的那条展开，其余一行，点了展开那条', async () => {
    const m = triageAttempts([brief('run_new', 'msg_b', NEW), brief('run_old', 'msg_a', OLD)])
    const msgs = [msg('msg_a', OLD, '第一条消息'), msg('msg_b', NEW, '第二条消息'), msg('msg_c', NEW, '没分诊的')]
    wrap(<GroupTriageSection msgs={msgs} attemptsOf={(id) => m.get(id) ?? []} onStart={vi.fn()} onOpenRun={vi.fn()} onOpenTask={vi.fn()} />)
    const sec = screen.getByRole('region', { name: '分诊建议' })
    expect(within(sec).getByText('分诊建议 · 2 条分诊过')).toBeInTheDocument()
    expect(await within(sec).findByLabelText('处理建议')).toHaveTextContent('对方要报价单')
    expect(reads).toEqual(['run_new'])
    await userEvent.click(within(sec).getByRole('button', { name: /第一条消息/ }))
    expect(await within(sec).findByText('可忽略')).toBeInTheDocument()
    expect(within(sec).getByRole('button', { name: /第二条消息/ })).toBeInTheDocument()
  })

  it('一条都没分诊过：发起分诊', async () => {
    const onStart = vi.fn()
    wrap(<GroupTriageSection msgs={[msg('msg_a', OLD, 'x')]} attemptsOf={() => []} onStart={onStart} onOpenRun={vi.fn()} onOpenTask={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '发起分诊' }))
    expect(onStart).toHaveBeenCalled()
  })
})

describe('列表行的分诊小标', () => {
  it('已分诊：悬停才取详情，title 是结论和建议；点了打开抽屉的分诊建议', async () => {
    const a = triageAttempts([brief('run_new', 'msg_1', NEW)]).get('msg_1')![0]
    const onOpenAdvice = vi.fn()
    const onOpenQueue = vi.fn()
    wrap(<TriageTagButton attempt={a} onOpenAdvice={onOpenAdvice} onOpenQueue={onOpenQueue} />)
    const tag = screen.getByRole('button', { name: '已分诊' })
    expect(reads).toEqual([])
    fireEvent.mouseEnter(tag)
    await waitFor(() => expect(tag.title).toContain('要处理：对方要报价单，今天下班前回复'))
    expect(tag.title).toContain('消息分诊：点击查看分诊建议')
    await userEvent.click(tag)
    expect(onOpenAdvice).toHaveBeenCalled()
    expect(onOpenQueue).not.toHaveBeenCalled()
  })

  it('分诊中：不取详情，点了打开处理队列；没分诊过不显示', async () => {
    const a = triageAttempts([{ ...brief('run_new', 'msg_1', NEW), status: 'running' }]).get('msg_1')![0]
    const onOpenQueue = vi.fn()
    const { rerender } = wrap(<TriageTagButton attempt={a} onOpenAdvice={vi.fn()} onOpenQueue={onOpenQueue} />)
    const tag = screen.getByRole('button', { name: '分诊中' })
    fireEvent.mouseEnter(tag)
    expect(tag.title).toBe('消息分诊：打开处理队列')
    await userEvent.click(tag)
    expect(onOpenQueue).toHaveBeenCalled()
    expect(reads).toEqual([])
    rerender(<QueryClientProvider client={new QueryClient()}><TriageTagButton attempt={undefined} onOpenAdvice={vi.fn()} onOpenQueue={vi.fn()} /></QueryClientProvider>)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
