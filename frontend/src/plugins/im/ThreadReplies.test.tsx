// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataKeys, useImBatch, type ImMessage, type SopInputRun, type SopRun } from '../../core/data'
import { statusItems, statusView } from './model'
import { ThreadReplies, type ThreadTriage } from './ThreadReplies'
import type { TriageAttempt } from './triageSummary'
import { batchIds, batchNote, confirmTitle } from './threadBatch'

type Call = { method: string; path: string; body?: Record<string, unknown> }
let calls: Call[] = []
/** 后端：送去的 id 里只有这些算「还没处理」，别的跳过 */
let openIds = new Set<string>()
let fail: string | null = null
/** 分诊执行详情 GET /api/sop/runs/{id} */
let runDetails: Record<string, unknown> = {}

const base: ImMessage = {
  id: 'msg_p', channel: 'slack', connector_id: '', external_id: 'x', conversation_id: 'cv', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin', identity_id: null, stakeholder_id: null, contact_name: '',
  text: '原消息', relevance: '', status: 'pending', read: true, snooze_until: null, at: '2026-11-04T01:00:00Z', received_at: '2026-11-04T01:00:00Z',
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '',
  sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 3, attachments: [],
}
const reply = (id: string, status: ImMessage['status'], name: string): ImMessage => ({
  ...base, id, status, sender_name: name, text: `${name} 的回复`, reply_count: 0, thread: { parent_external_id: 'x', parent_message_id: 'msg_p', parent_sender_name: 'Lin', parent_text: '原消息' } as ImMessage['thread'],
})
const sv = statusView(statusItems(undefined))

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: u.pathname, body })
    if (method === 'GET' && runDetails[u.pathname]) return json(runDetails[u.pathname])
    if (u.pathname === '/api/im/messages/batch' && method === 'POST') {
      if (fail) return json({ error: { code: 'validation', message: fail } }, 400)
      const ids = (body!.ids as string[]).filter((id) => openIds.has(id))
      return json({ action: body!.action, ids, count: ids.length })
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }))
}

function renderSection(replies: ImMessage[], parent: ImMessage = base) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(dataKeys.im.list, [parent, ...replies])
  render(<QueryClientProvider client={qc}><ThreadReplies parent={parent} replies={replies} sv={sv} /></QueryClientProvider>)
  return qc
}
const batches = () => calls.filter((c) => c.path === '/api/im/messages/batch')

const THREAD = [reply('r1', 'pending', 'Amy'), reply('r2', 'expired', 'Bob'), reply('r3', 'done', 'Cat')]

beforeEach(() => {
  calls = []
  openIds = new Set(['msg_p', 'r1', 'r2'])
  fail = null
  runDetails = {}
  fakeBackend()
})
afterEach(() => vi.unstubAllGlobals())

describe('消息列回复批量处理的规则', () => {
  it('连原消息只在原消息还没处理时带上，加在最后', () => {
    expect(batchIds(['a'], { id: 'p', status: 'pending' }, true)).toEqual(['a', 'p'])
    expect(batchIds(['a'], { id: 'p', status: 'expired' }, true)).toEqual(['a', 'p'])
    expect(batchIds(['a'], { id: 'p', status: 'done' }, true)).toEqual(['a'])
    expect(batchIds(['a'], { id: 'p', status: 'pending' }, false)).toEqual(['a'])
  })
  it('提示写改了几条、跳过几条', () => {
    expect(batchNote(3, 3, '已处理')).toBe('已把 3 条标为已处理')
    expect(batchNote(3, 1, '已忽略')).toBe('已把 1 条标为已忽略，跳过 2 条（已经在别处处理过）')
    expect(batchNote(2, 0, '已处理')).toBe('没有要处理的消息，跳过 2 条（已经在别处处理过）')
    expect(confirmTitle(4, true, '忽略')).toBe('把这个消息列里 4 条没处理的回复和原消息忽略？')
  })
})

describe('消息列回复一节的批量处理', () => {
  it('整列处理：先确认，只送没处理的回复，不含原消息；处理完提示并刷新消息', async () => {
    const qc = renderSection(THREAD)
    await userEvent.click(screen.getByRole('button', { name: '全部标为已处理' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg).toHaveTextContent('把这个消息列里 2 条没处理的回复标为已处理？')
    expect(batches()).toHaveLength(0)
    await userEvent.click(within(dlg).getByRole('button', { name: '全部标为已处理' }))
    await screen.findByText('已把 2 条标为已处理')
    expect(batches()[0].body).toEqual({ action: 'done', ids: ['r1', 'r2'] })
    await waitFor(() => expect(qc.getQueryState(dataKeys.im.list)?.isInvalidated).toBe(true))
  })

  it('整列忽略在确认框里取消就不调接口', async () => {
    renderSection(THREAD)
    await userEvent.click(screen.getByRole('button', { name: '全部忽略' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(batches()).toHaveLength(0)
  })

  it('都处理过了时没有整列按钮和勾选框', () => {
    renderSection([reply('r3', 'done', 'Cat')], { ...base, status: 'done' })
    expect(screen.queryByRole('button', { name: '全部标为已处理' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('勾选批量：已处理的不能勾，勾了换成已选条，全选、忽略后清掉勾选', async () => {
    renderSection(THREAD)
    // 原消息没处理：两条回复的勾选框 + 「连原消息一起」
    const boxes = screen.getAllByRole('checkbox', { name: /^选择/ })
    expect(boxes).toHaveLength(2)
    await userEvent.click(boxes[0])
    const bar = screen.getByRole('toolbar', { name: '批量处理消息列回复' })
    expect(bar).toHaveTextContent('已选 1 条')
    expect(screen.queryByRole('button', { name: '全部标为已处理' })).toBeNull()
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['全选 2 条', '标为已处理', '忽略', '取消选择'])
    await userEvent.click(within(bar).getByRole('button', { name: '全选 2 条' }))
    expect(bar).toHaveTextContent('已选 2 条')
    await userEvent.click(within(bar).getByRole('button', { name: '忽略' }))
    await screen.findByText('已把 2 条标为已忽略')
    expect(batches()[0].body).toEqual({ action: 'ignore', ids: ['r1', 'r2'] })
    expect(screen.queryByRole('toolbar', { name: '批量处理消息列回复' })).toBeNull()
    expect(screen.getAllByRole('checkbox', { name: /^选择/ }).every((b) => !(b as HTMLInputElement).checked)).toBe(true)
  })

  it('取消选择清掉勾选', async () => {
    renderSection(THREAD)
    await userEvent.click(screen.getAllByRole('checkbox', { name: /^选择/ })[1])
    await userEvent.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.getByRole('button', { name: '全部标为已处理' })).toBeInTheDocument()
  })

  it('连原消息一起：原消息没处理时才有，勾上后整列和勾选都带上原消息', async () => {
    renderSection(THREAD)
    await userEvent.click(screen.getByRole('checkbox', { name: '连原消息一起' }))
    await userEvent.click(screen.getByRole('button', { name: '全部标为已处理' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg).toHaveTextContent('2 条没处理的回复和原消息标为已处理？')
    await userEvent.click(within(dlg).getByRole('button', { name: '全部标为已处理' }))
    await screen.findByText('已把 3 条标为已处理')
    expect(batches()[0].body).toEqual({ action: 'done', ids: ['r1', 'r2', 'msg_p'] })
  })

  it('原消息已处理时没有「连原消息一起」', () => {
    renderSection(THREAD, { ...base, status: 'done' })
    expect(screen.queryByRole('checkbox', { name: '连原消息一起' })).toBeNull()
  })

  it('勾选批量时连原消息', async () => {
    renderSection(THREAD)
    await userEvent.click(screen.getAllByRole('checkbox', { name: /^选择/ })[0])
    await userEvent.click(screen.getByRole('checkbox', { name: '连原消息一起' }))
    await userEvent.click(within(screen.getByRole('toolbar', { name: '批量处理消息列回复' })).getByRole('button', { name: '标为已处理' }))
    await screen.findByText('已把 2 条标为已处理')
    expect(batches()[0].body).toEqual({ action: 'done', ids: ['r1', 'msg_p'] })
  })

  it('部分跳过：别处已处理掉的算跳过', async () => {
    openIds = new Set(['r1'])
    renderSection(THREAD)
    await userEvent.click(screen.getByRole('button', { name: '全部忽略' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '全部忽略' }))
    await screen.findByText('已把 1 条标为已忽略，跳过 1 条（已经在别处处理过）')
  })

  it('失败时红字写后端原因，勾选保留', async () => {
    fail = '一次最多 500 条'
    renderSection(THREAD)
    await userEvent.click(screen.getAllByRole('checkbox', { name: /^选择/ })[0])
    await userEvent.click(within(screen.getByRole('toolbar', { name: '批量处理消息列回复' })).getByRole('button', { name: '标为已处理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没改成：一次最多 500 条')
    expect(screen.getByRole('toolbar', { name: '批量处理消息列回复' })).toHaveTextContent('已选 1 条')
    expect((screen.getAllByRole('checkbox', { name: /^选择/ })[0] as HTMLInputElement).checked).toBe(true)
  })

  it('超过 500 条分批调，合并结果再提示', async () => {
    const many = Array.from({ length: 1203 }, (_, i) => reply(`r${i}`, 'pending', `U${i}`))
    openIds = new Set(many.map((m) => m.id))
    const qc = new QueryClient()
    const { result } = renderHook(() => useImBatch(), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
    const r = await result.current.mutateAsync({ action: 'done', ids: many.map((m) => m.id) })
    expect(batches().map((c) => (c.body!.ids as string[]).length)).toEqual([500, 500, 203])
    expect(r.count).toBe(1203)
    expect(r.ids).toHaveLength(1203)
    expect(batchNote(1203, r.count, '已处理')).toBe('已把 1203 条标为已处理')
  })
})

// 消息列回复也走分诊（2026-11-19，SPEC-messages-2.45、2.51）：勾选后「批量分诊」只带勾的回复；每条回复有自己的分诊小标，
// 已分诊的再跟结论；已处理、已忽略的回复带悬停才显示动作的类名（动作仍在 DOM 里）
describe('消息列回复的分诊', () => {
  const inputRun = (id: string, value: string, status: SopInputRun['status']): SopInputRun => ({
    id, flow_id: 'sop_t', flow_name: '分诊', flow_version: 1, title: '', step_through: false, stopped: false, status, source: 'im',
    started_at: '2026-11-04T02:00:00Z', updated_at: '2026-11-04T02:00:00Z', focus: 0, steps: [], input_value: value,
  })
  const attempts: Record<string, TriageAttempt[]> = {
    r1: [{ top: inputRun('spr_1', 'r1', 'done'), children: [] }],
    r3: [{ top: inputRun('spr_3', 'r3', 'running'), children: [] }],
  }
  function renderWithTriage(onStart = vi.fn(), onOpenAdvice = vi.fn()) {
    const triage: ThreadTriage = { attemptsOf: (id) => attempts[id] ?? [], onStart, onOpenQueue: vi.fn(), onOpenAdvice }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(dataKeys.im.list, [base, ...THREAD])
    render(<QueryClientProvider client={qc}><ThreadReplies parent={base} replies={THREAD} sv={sv} triage={triage} /></QueryClientProvider>)
    return { onStart, onOpenAdvice }
  }

  it('勾选后批量分诊只带勾的回复', async () => {
    const { onStart } = renderWithTriage()
    await userEvent.click(screen.getByRole('checkbox', { name: /Amy/ }))
    await userEvent.click(screen.getByRole('button', { name: '批量分诊' }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart.mock.calls[0][0].map((m: ImMessage) => m.id)).toEqual(['r1'])
  })

  it('没给分诊（SOP 插件不在跑）时没有批量分诊和小标', async () => {
    renderSection(THREAD)
    await userEvent.click(screen.getByRole('checkbox', { name: /Amy/ }))
    expect(screen.queryByRole('button', { name: '批量分诊' })).toBeNull()
    expect(screen.queryByText('已分诊')).toBeNull()
  })

  it('每条回复显示自己的分诊小标，已分诊的跟结论，点结论打开那条的分诊建议', async () => {
    runDetails['/api/sop/runs/spr_1'] = {
      id: 'spr_1', flow_id: 'sop_t', flow_name: '分诊', flow_version: 1,
      flow: { id: 'sop_t', name: '分诊', desc: '', trigger: 'im', fields: [], version: 1, created_at: '', updated_at: '',
        steps: [{ key: 'n', name: '要处理吗', kind: 'template', after: [], config: { output: 'need' } }] },
      title: '', input: { message_id: 'r1' }, step_through: false, stopped: false, status: 'done', source: 'im',
      started_at: '2026-11-04T02:00:00Z', updated_at: '2026-11-04T02:00:00Z',
      steps: [{ key: 'n', status: 'done', input: null, output: { need: 'yes' }, attempts: 1, log: [] }],
    } satisfies Partial<SopRun>
    const { onOpenAdvice } = renderWithTriage()
    const items = screen.getAllByRole('listitem')
    expect(within(items[0]).getByRole('button', { name: '已分诊' })).toBeTruthy()
    expect(within(items[2]).getByRole('button', { name: '分诊中' })).toBeTruthy()
    expect(within(items[1]).queryByRole('button', { name: /分诊/ })).toBeNull()
    const verdict = await within(items[0]).findByRole('button', { name: '要处理' })
    await userEvent.click(verdict)
    expect(onOpenAdvice).toHaveBeenCalledWith('r1')
  })

  it('已处理、已忽略的回复动作只在悬停时显示：类名在，按钮仍在 DOM 里', () => {
    renderSection(THREAD)
    const items = screen.getAllByRole('listitem')
    expect(items[2].className).toContain('im-acts-hover')
    expect(within(items[2]).getByRole('button', { name: '重新打开' })).toBeTruthy()
    expect(items[0].className).not.toContain('im-acts-hover')
    expect(items[1].className).not.toContain('im-acts-hover') // 已过期还没处理，常显
  })
})
