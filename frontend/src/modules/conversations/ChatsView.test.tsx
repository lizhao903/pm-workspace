// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 空会话不堆积（B-09）：没有消息的会话只在打开时列出，从它切走时删掉；有消息的、删除会话后切走的不再删。
// P0-S1：搜索（标题+消息正文）和项目筛选都走服务端，第二行显示最后一条消息；这里打桩 fetch 模拟后端按 q/project_id 筛。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttention, AgentSession } from '../../core/data'
import { resetLiveChats } from '../../core/chat/chatLive'
import { ChatsView } from './ChatsView'

const now = new Date().toISOString()
const sess = (id: string, title: string, message_count: number, extra: Partial<AgentSession> = {}): AgentSession => ({
  id, title, object_id: null, provider_id: 'apv_1', model: 'm', workdir: '', agent_id: null, created_at: now, updated_at: now, message_count, ...extra,
})
let sessions: AgentSession[] = []
let deleted: string[] = []
// 等确认注意力（P0-O3）：默认没有，用例里按需造
let attention: AgentAttention = { total: 0, pending_calls: [], waiting_runs: [] }
// 项目下拉的选项（P0-S1 项目筛选）
let projects: { id: string; title: string }[] = []
// 记下每次请求的 path+query，断言服务端搜索 / 项目筛选的传参
let requestUrls: string[] = []

beforeEach(() => {
  resetLiveChats()
  deleted = []
  requestUrls = []
  projects = []
  attention = { total: 0, pending_calls: [], waiting_runs: [] }
  sessions = [
    sess('ags_e', '新会话', 0),
    sess('ags_m', '周报怎么写', 2, { last_message: '先把上周的数据汇总一下', last_message_at: now }),
    sess('ags_e2', '新会话', 0),
  ]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    requestUrls.push(u.pathname + u.search)
    const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: Array.isArray(data) ? data.length : 0 } }), { status: 200 })
    if (init?.method === 'DELETE') {
      const id = u.pathname.split('/').pop() ?? ''
      deleted.push(id)
      sessions = sessions.filter((s) => s.id !== id)
      return new Response(null, { status: 204 })
    }
    // 会话列表：按契约模拟服务端筛选，q 搜标题+消息正文，project_id 只看该项目
    if (u.pathname === '/api/agent/sessions') {
      const q = (u.searchParams.get('q') ?? '').trim().toLowerCase()
      const projectId = u.searchParams.get('project_id')
      let rows = sessions
      if (projectId) rows = rows.filter((s) => s.source_ref?.project_id === projectId)
      if (q) rows = rows.filter((s) => `${s.title} ${s.last_message ?? ''}`.toLowerCase().includes(q))
      return json(rows)
    }
    if (u.pathname === '/api/agent-providers') return json([{ id: 'apv_1', name: '本机 Ollama', kind: 'ollama', model: 'm', enabled: true, is_default: true }])
    if (u.pathname === '/api/agent/attention') return json(attention)
    if (u.pathname === '/api/objects') return json(projects)
    return json([])
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function setup(current: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (c: string | null) => <QueryClientProvider client={client}><ChatsView current={c} onOpen={vi.fn()} /></QueryClientProvider>
  const r = render(view(current))
  return { rerender: (c: string | null) => r.rerender(view(c)), container: r.container }
}
const items = (c: HTMLElement) => [...c.querySelectorAll('.chat-item-title')].map((e) => e.textContent)
// 会话列表每次请求的 query 参数：筛选时前端还会顺带请求一份不筛选的（保留当前会话），所以按参数找
const sessionParams = () => requestUrls.filter((u) => u.startsWith('/api/agent/sessions')).map((u) => new URLSearchParams(u.split('?')[1]))
const findParam = (key: string, value: string) => sessionParams().find((p) => p.get(key) === value)

describe('空会话（B-09）', () => {
  it('列表不列没有消息的会话，正打开的除外', async () => {
    const { container, rerender } = setup(null)
    await screen.findByText('周报怎么写')
    expect(items(container)).toEqual(['周报怎么写'])
    rerender('ags_e')
    await waitFor(() => expect(items(container)).toEqual(['新会话', '周报怎么写']))
    expect(deleted).toEqual([])
  })

  it('从空会话切走就删掉它，从有消息的切走不删', async () => {
    const { container, rerender } = setup('ags_e')
    await waitFor(() => expect(items(container)).toContain('新会话'))
    rerender('ags_m')
    await waitFor(() => expect(deleted).toEqual(['ags_e']))
    rerender('ags_e2')
    await waitFor(() => expect(items(container)).toContain('新会话'))
    rerender('ags_m')
    await waitFor(() => expect(deleted).toEqual(['ags_e', 'ags_e2']))
    rerender(null)
    await new Promise((r) => setTimeout(r, 20))
    expect(deleted).toEqual(['ags_e', 'ags_e2'])
  })
})

describe('最后一条消息（P0-S1）', () => {
  it('第二行显示最后一条消息；没有消息时仍显示「N 条消息」', async () => {
    sessions = [
      sess('ags_a', '有最后一条', 3, { last_message: '周报我已经整理好了，你看下', last_message_at: now }),
      sess('ags_b', '只有条数', 2),
    ]
    setup(null)
    await screen.findByText('有最后一条')
    const a = screen.getByText('有最后一条').closest('.chat-item') as HTMLElement
    expect(a.querySelector('.chat-item-last')?.textContent).toContain('周报我已经整理好了，你看下')
    const b = screen.getByText('只有条数').closest('.chat-item') as HTMLElement
    expect(b.querySelector('.chat-item-last')?.textContent).toContain('2 条消息')
  })
})

describe('会话清单底部：执行记录、产出结果（原二级菜单）', () => {
  it('两个并排按钮，点了各自跳过去；有等确认的执行记录时带红点', async () => {
    const onRuns = vi.fn()
    const onOutputs = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><ChatsView current={null} onOpen={vi.fn()} onOpenRuns={onRuns} onOpenOutputs={onOutputs} runsWaiting={2} /></QueryClientProvider>)
    const foot = await screen.findByRole('group', { name: '执行记录和产出结果' })
    await userEvent.click(within(foot).getByRole('button', { name: /执行记录/ }))
    await userEvent.click(within(foot).getByRole('button', { name: '产出结果' }))
    expect(onRuns).toHaveBeenCalledTimes(1)
    expect(onOutputs).toHaveBeenCalledTimes(1)
    expect(within(foot).getByLabelText('2 条等你确认')).toBeInTheDocument()
  })
})

describe('服务端搜索（P0-S1）', () => {
  it('输入防抖后带 q 请求，搜得到消息正文里的词，列表只留后端命中的会话', async () => {
    sessions = [
      sess('ags_a', '周报怎么写', 2, { last_message: '先把上周的数据汇总一下', last_message_at: now }),
      sess('ags_b', '别的话题', 1, { last_message: '今天天气不错', last_message_at: now }),
    ]
    const { container } = setup(null)
    await screen.findByText('别的话题')
    const input = screen.getByRole('textbox', { name: '搜会话' })
    expect(input).toHaveAttribute('placeholder', '搜会话标题和消息')
    await userEvent.type(input, '汇总')
    // 标题里没有「汇总」，是正文命中的
    await waitFor(() => expect(findParam('q', '汇总')).toBeDefined())
    await waitFor(() => expect(items(container)).toEqual(['周报怎么写']))
  })
})

describe('项目筛选（P0-S1）', () => {
  it('选了项目只按 project_id 请求，列表只剩这个项目的会话；清空回全部', async () => {
    projects = [{ id: 'obj_p1', title: '一人之下控制台' }]
    sessions = [
      sess('ags_p', '项目的会话', 2, { last_message: '项目里的讨论', last_message_at: now, source_ref: { kind: 'task_run', project_id: 'obj_p1' } }),
      sess('ags_g', '全局会话', 1, { last_message: '全局的讨论', last_message_at: now }),
    ]
    const { container } = setup(null)
    await screen.findByText('全局会话')
    await userEvent.click(screen.getByLabelText('按项目筛选'))
    await userEvent.click(await screen.findByRole('option', { name: /一人之下控制台/ }))
    await waitFor(() => expect(items(container)).toEqual(['项目的会话']))
    const byProject = findParam('project_id', 'obj_p1')!
    expect(byProject).toBeDefined()
    // 按契约给 project_id 时只传它，不再传 unscoped
    expect(byProject.get('unscoped')).toBeNull()

    // 清空项目筛选：回到不筛选的列表
    await userEvent.click(screen.getByLabelText('按项目筛选'))
    await userEvent.click(await screen.findByRole('option', { name: '全部项目' }))
    await waitFor(() => expect(items(container)).toEqual(['项目的会话', '全局会话']))
  })
})

describe('会话里的等确认圆点（P0-O3）', () => {
  it('有 Agent 调用等你确认的会话标题右侧出红点，悬停提示条数；没有的不出', async () => {
    attention = {
      total: 2,
      pending_calls: [
        { call_id: 'atc_1', session_id: 'ags_m', session_title: '周报怎么写', agent_id: 'ag_1', agent_name: '周报助手', tool: 'create_object', args: '{}', summary: '新建「周报」', at: now },
        { call_id: 'atc_2', session_id: 'ags_m', session_title: '周报怎么写', agent_id: 'ag_1', agent_name: '周报助手', tool: 'write_file', args: '{}', summary: '写文件', at: now },
      ],
      waiting_runs: [],
    }
    const { container } = setup(null)
    await screen.findByText('周报怎么写')
    const item = screen.getByText('周报怎么写').closest('.chat-item') as HTMLElement
    const dot = await within(item).findByLabelText('2 个调用等你确认')
    expect(dot).toHaveAttribute('title', '2 个调用等你确认')
    // 只有这一个会话有等确认的调用
    expect(container.querySelectorAll('.chat-item .side-dot')).toHaveLength(1)
  })
})
