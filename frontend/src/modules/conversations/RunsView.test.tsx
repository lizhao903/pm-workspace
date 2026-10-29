// 执行记录页：打桩 fetch，/api/agent-runs 按 query 在桩里筛，详情回调用记录和要确认的调用。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentRun } from '../../core/data'
import { RunsView } from './RunsView'

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, desc: '', color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'apv_1', model: 'm', instructions: '',
  skills: [], mcps: [], kbs: [], triggers: [], enabled: true, created_at: '', updated_at: '', ...over,
})
const run = (id: string, agentId: string, status: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id, agent_id: agentId, trigger_kind: 'im', trigger: `收到 slack 消息 · ${id}`, source_id: 'm', event_key: 'im:' + id, session_id: 'ags_' + id,
  status, summary: `总结 ${id}`, started_at: new Date().toISOString(), finished_at: null, pending: status === 'waiting' ? 1 : 0, ...over,
})

const RUNS = [
  run('ar_1', 'ag_a', 'waiting'),
  run('ar_2', 'ag_a', 'done'),
  run('ar_3', 'ag_b', 'done'),
  run('ar_4', 'ag_gone', 'failed', { summary: '执行失败：模型不可用' }),
]
let urls: string[] = []

function backend(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), 'http://x')
  urls.push(url.pathname + url.search)
  const ok = (data: unknown, total?: number) => Promise.resolve(new Response(JSON.stringify({ data, meta: { total: total ?? (Array.isArray(data) ? data.length : 0) } }), { status: 200 }))
  if (url.pathname === '/api/agents') return ok([agent('ag_a', '分诊助手'), agent('ag_b', '周报助手')])
  if (url.pathname === '/api/agent-runs') {
    const a = url.searchParams.get('agent')
    const st = url.searchParams.get('status')?.split(',')
    const rows = RUNS.filter((r) => (!a || r.agent_id === a) && (!st || st.includes(r.status)))
    const limit = Number(url.searchParams.get('limit') ?? 50)
    return ok(rows.slice(0, limit), rows.length)
  }
  const m = /^\/api\/agent-runs\/(.+)$/.exec(url.pathname)
  if (m) {
    const r = RUNS.find((x) => x.id === m[1])
    if (!r) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: '不存在' } }), { status: 404 }))
    const waiting = r.status === 'waiting'
    return ok({
      ...r,
      calls: [
        { tool: 'search_objects', args: '{}', summary: '找到 2 条', at: '' },
        ...(waiting ? [{ tool: 'create_object', args: '{"title":"开通试点账号"}', summary: '等待确认：新建「开通试点账号」', at: '' }] : []),
      ],
      tool_calls: waiting
        ? [{ id: 'atc_1', agent_id: r.agent_id, session_id: r.session_id, run_id: r.id, call_id: 'c1', tool: 'create_object', grant_key: 'write_tasks',
          args: '{"title":"开通试点账号"}', state: 'pending', result: '', created_at: '', decided_at: null }]
        : [],
    })
  }
  return ok([])
}

function show(props: Partial<Parameters<typeof RunsView>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onOpenSession = vi.fn()
  render(<QueryClientProvider client={client}><RunsView onOpenSession={onOpenSession} {...props} /></QueryClientProvider>)
  return onOpenSession
}
const card = (id: string) => document.querySelector<HTMLElement>(`[data-run="${id}"]`)

beforeEach(() => {
  urls = []
  vi.stubGlobal('fetch', vi.fn(backend))
})
afterEach(() => vi.unstubAllGlobals())

describe('执行记录', () => {
  it('列出执行记录，等确认的默认展开，待确认的调用标「等你确认」并给去会话的入口', async () => {
    const onOpenSession = show()
    await waitFor(() => expect(card('ar_1')).not.toBeNull())
    expect(screen.getAllByText('收到 slack 消息 · ar_1')).toHaveLength(1)
    const waiting = card('ar_1')!
    expect(within(waiting).getByRole('button', { expanded: true, name: /分诊助手/ })).toBeInTheDocument()
    expect(await within(waiting).findByText('等你确认')).toBeInTheDocument()
    expect(waiting.querySelector('[data-call="atc_1"]')).not.toBeNull()
    await userEvent.click(within(waiting).getByRole('button', { name: '去会话里确认' }))
    expect(onOpenSession).toHaveBeenCalledWith('ags_ar_1')
    // 没动过的已完成默认收起；Agent 删了显示「已删除的 Agent」
    expect(within(card('ar_2')!).getByRole('button', { expanded: false })).toBeInTheDocument()
    expect(within(card('ar_4')!).getByText('已删除的 Agent')).toBeInTheDocument()
  })

  it('状态切换带全部执行记录里的条数；按 Agent 筛在后端筛，再点取消', async () => {
    show()
    const tabs = await screen.findByRole('tablist', { name: '状态' })
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /全部/ })).toHaveTextContent('4'))
    expect(within(tabs).getByRole('tab', { name: /已完成/ })).toHaveTextContent('2')
    const chip = await screen.findByRole('button', { name: '周报助手' })
    await userEvent.click(chip)
    await waitFor(() => expect(card('ar_1')).toBeNull())
    expect(card('ar_3')).not.toBeNull()
    expect(urls.some((u) => u.startsWith('/api/agent-runs?') && u.includes('agent=ag_b'))).toBe(true)
    // 状态条数不受 Agent 筛选影响
    expect(within(tabs).getByRole('tab', { name: /全部/ })).toHaveTextContent('4')
    await userEvent.click(within(tabs).getByRole('tab', { name: /等你确认/ }))
    expect(await screen.findByText('没有符合条件的执行记录')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '周报助手' }))
    await waitFor(() => expect(card('ar_1')).not.toBeNull())
    expect(card('ar_3')).toBeNull()
  })

  it('?run= 定位：清掉筛选、展开那一条并高亮', async () => {
    const onFocused = vi.fn()
    show({ focus: 'ar_3', onFocused })
    await waitFor(() => expect(card('ar_3')).not.toBeNull())
    const c = card('ar_3')!
    expect(c).toHaveClass('lit')
    expect(within(c).getByRole('button', { expanded: true })).toBeInTheDocument()
    expect(await within(c).findByText('总结 ar_3')).toBeInTheDocument()
    expect(onFocused).toHaveBeenCalled()
  })

  it('失败的总结写原因', async () => {
    show({ focus: 'ar_4' })
    expect(await screen.findByText('执行失败：模型不可用')).toBeInTheDocument()
  })
})
