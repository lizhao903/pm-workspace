// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话里要人确认的调用（AG-02b，SPEC-sessions-1.17、1.18）：打桩 fetch，对话和确认、拒绝都回一段 SSE，
// 每段流发完后消息列表换成对应的那一份。
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient, type Agent, type AgentMessage, type AgentSession, type ChatEvent } from '../data'
import { ChatPane } from './ChatPane'
import { resetLiveChats } from './chatLive'

const now = new Date().toISOString()
const agent: Agent = {
  id: 'ag_1', name: '周报助手', desc: '', color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'apv_1', model: 'm',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [], enabled: true, created_at: now, updated_at: now,
}
const session: AgentSession = {
  id: 'ags_1', title: '建任务', object_id: null, provider_id: 'apv_1', model: 'm', workdir: '', agent_id: 'ag_1', created_at: now, updated_at: now,
  message_count: 0,
}
const m = (id: string, role: string, content: string, extra: Partial<AgentMessage> = {}): AgentMessage =>
  ({ id, session_id: 'ags_1', role, content, created_at: now, ...extra })
const sse = (events: ChatEvent[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
  status: 200, headers: { 'Content-Type': 'text/event-stream' },
})

const ARGS = '{"type_id":"task","title":"开通试点账号"}'
const ASKED: AgentMessage[] = [
  m('u1', 'user', '建一条任务：开通试点账号'),
  m('t1', 'tool', '等待确认：新建「开通试点账号」', { tool_name: 'create_object', tool_args: ARGS }),
  m('a1', 'assistant', '我准备建这条任务。\n【等你确认】新建「开通试点账号」，确认后才会执行。\n'),
]

type Round = { path: RegExp; events: ChatEvent[]; after: AgentMessage[] }

function stub(rounds: Round[], initial: AgentMessage[] = [], runs: { list?: unknown[]; detail?: unknown } = {}) {
  let messages = initial
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: Array.isArray(data) ? data.length : 0 } }), { status: 200 })
    if (init?.method === 'POST') {
      posts.push(u.pathname)
      const r = rounds.find((x) => x.path.test(u.pathname))
      if (!r) return new Response(JSON.stringify({ error: { code: 'conflict', message: '这次调用已经处理过了' } }), { status: 409 })
      rounds.splice(rounds.indexOf(r), 1)
      messages = r.after
      return sse(r.events)
    }
    if (u.pathname === '/api/agent/sessions/ags_1/messages') return json(messages)
    if (u.pathname === '/api/agent-runs') return json(runs.list ?? [])
    if (u.pathname.startsWith('/api/agent-runs/')) return json(runs.detail)
    return json([])
  }))
  return posts
}

function renderPane(onOpenTools = vi.fn()) {
  render(
    <QueryClientProvider client={queryClient}>
      <ChatPane session={session} who={{ kind: 'agent', agent }} onRetitle={vi.fn()} onOpenTools={onOpenTools} />
    </QueryClientProvider>,
  )
  return onOpenTools
}

beforeEach(() => {
  queryClient.clear()
  resetLiveChats()
})
afterEach(() => { vi.unstubAllGlobals() })

const askRound: Round = {
  path: /\/api\/agent\/chat$/,
  events: [
    { type: 'delta', text: '我准备建这条任务。' },
    { type: 'confirm', id: 'atc_1', name: 'create_object', args: ARGS, summary: '新建「开通试点账号」' },
    { type: 'done', session_id: 'ags_1', message_id: 'a1' },
  ],
  after: ASKED,
}

describe('会话里的确认卡片', () => {
  it('confirm 事件出「确认执行 / 拒绝」；确认后卡片变已确认执行带结果，接着的回复流式显示', async () => {
    const posts = stub([askRound, {
      path: /\/api\/agent\/tool-calls\/atc_1\/confirm$/,
      events: [
        { type: 'tool_call', name: 'create_object', args: ARGS },
        { type: 'tool_result', name: 'create_object', summary: '已新建 TSK-0042「开通试点账号」' },
        { type: 'delta', text: '建好了，编号 TSK-0042。' },
        { type: 'done', session_id: 'ags_1', message_id: 'a2' },
      ],
      after: [
        ...ASKED,
        m('t2', 'tool', '已新建 TSK-0042「开通试点账号」', { tool_name: 'create_object', tool_args: ARGS }),
        m('a2', 'assistant', '建好了，编号 TSK-0042。'),
      ],
    }])
    renderPane()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '消息' }), '建一条任务：开通试点账号')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await screen.findByRole('button', { name: '确认执行' })
    // 读回后：「【等你确认】」那行不重复，卡片还能点
    await waitFor(() => expect(screen.getAllByText('建一条任务：开通试点账号')).toHaveLength(1))
    expect(screen.queryByText(/【等你确认】/)).toBeNull()
    expect(screen.getByText('等你确认')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '确认执行' }))

    expect(await screen.findByText('建好了，编号 TSK-0042。')).toBeInTheDocument()
    expect(posts).toEqual(['/api/agent/chat', '/api/agent/tool-calls/atc_1/confirm'])
    await waitFor(() => expect(screen.getByText('已确认执行')).toBeInTheDocument())
    // 只有一张卡片：执行结果合回原卡片
    expect(document.querySelectorAll('[data-tool="create_object"]')).toHaveLength(1)
    const card = document.querySelector<HTMLElement>('[data-tool="create_object"]')!
    if (!within(card).queryByText('已新建 TSK-0042「开通试点账号」')) await user.click(within(card).getByRole('button', { name: /新建工作对象/ }))
    expect(within(card).getByText('已新建 TSK-0042「开通试点账号」')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull()
  })

  it('拒绝：卡片变已拒绝，接着的回复照常显示；处理失败时卡片退回等你确认并说原因', async () => {
    const posts = stub([{
      path: /\/api\/agent\/tool-calls\/atc_1\/reject$/,
      events: [
        { type: 'tool_result', name: 'create_object', summary: '用户拒绝了：新建「开通试点账号」，没有执行' },
        { type: 'delta', text: '好的，不建了。' },
        { type: 'done', session_id: 'ags_1', message_id: 'a2' },
      ],
      after: [
        ...ASKED,
        m('t2', 'tool', '用户拒绝了：新建「开通试点账号」，没有执行', { tool_name: 'create_object', tool_args: ARGS }),
        m('a2', 'assistant', '好的，不建了。'),
      ],
    }, askRound])
    renderPane()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '消息' }), '建一条任务：开通试点账号')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '拒绝' }))
    expect(await screen.findByText('好的，不建了。')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('已拒绝')).toBeInTheDocument())
    expect(posts[1]).toBe('/api/agent/tool-calls/atc_1/reject')
  })

  it('已经处理过（409）：卡片退回等你确认，提示原因', async () => {
    stub([askRound])
    renderPane()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '消息' }), '建一条任务：开通试点账号')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '确认执行' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('确认没成功：这次调用已经处理过了')
    expect(screen.getByText('等你确认')).toBeInTheDocument()
  })

  it('执行记录建的会话：等确认的调用 id 从执行记录详情里找回', async () => {
    stub([], ASKED, {
      list: [{ id: 'ar_1', agent_id: 'ag_1', session_id: 'ags_1', status: 'waiting', pending: 1 }],
      detail: {
        id: 'ar_1', agent_id: 'ag_1', session_id: 'ags_1', status: 'waiting', summary: '', pending: 1, calls: [],
        tool_calls: [{ id: 'atc_9', tool: 'create_object', args: ARGS, state: 'pending', result: '' }],
      },
    })
    renderPane()
    expect(await screen.findByRole('button', { name: '确认执行' })).toBeEnabled()
    expect(document.querySelector('[data-call="atc_9"]')).not.toBeNull()
  })

  it('找不到 id（页面刷新过）：只显示状态，说明为什么点不了', async () => {
    stub([], ASKED)
    renderPane()
    expect(await screen.findByText(/页面刷新过，这里确认不了/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull()
  })

  it('权限没开：说明要开哪一项，能跳到「设置 / Agent / 工具与权限」（会话_权限没开）', async () => {
    stub([], [
      m('u1', 'user', '建一条任务'),
      m('t1', 'tool', 'create_object 没有授权，没有执行', { tool_name: 'create_object', tool_args: '{}' }),
      m('a1', 'assistant', '这个 Agent 没有建任务的权限。'),
    ])
    const onOpenTools = renderPane()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /新建工作对象/ }))
    expect(screen.getByText(/这件事要用到「新建 \/ 更新任务」，这个 Agent 没开这项权限/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '可以到「设置 / Agent / 工具与权限」里打开' }))
    expect(onOpenTools).toHaveBeenCalled()
  })
})
