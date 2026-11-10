// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 对话面板：打桩 fetch，消息列表回 JSON，/api/agent/chat 回一段 SSE。
// 流收尾后的刷新作用在应用唯一的缓存上（streamChat 用的是它），所以这里也用它渲染，用例之间清空。
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient, type Agent, type AgentMessage, type AgentProvider, type AgentSession, type ChatEvent } from '../data'
import { ChatPane } from './ChatPane'
import type { ChatWho } from './chatModel'
import { resetLiveChats } from './chatLive'

const now = new Date().toISOString()
const provider: AgentProvider = {
  id: 'apv_1', name: '本机 Ollama', kind: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3.5:4b', enabled: true,
  is_default: true, api_key_masked: '', has_api_key: false, extra: {}, created_at: now, updated_at: now,
}
const session: AgentSession = {
  id: 'ags_1', title: '新会话', object_id: null, provider_id: 'apv_1', model: 'qwen3.5:4b', workdir: '', created_at: now, updated_at: now,
  message_count: 0,
}
const m = (id: string, role: string, content: string, extra: Partial<AgentMessage> = {}): AgentMessage =>
  ({ id, session_id: 'ags_1', role, content, created_at: now, ...extra })

const sse = (events: ChatEvent[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
  status: 200, headers: { 'Content-Type': 'text/event-stream' },
})

// 每次 chat 依次取一段流、发完后消息列表换成对应的那一份；attention 是等确认注意力接口的返回（P0-O3）
function stub(rounds: { events: ChatEvent[]; after: AgentMessage[] }[], initial: AgentMessage[] = [],
  attention: unknown = { total: 0, pending_calls: [], waiting_runs: [] }) {
  let messages = initial
  const chats: { session_id?: string; message: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/agent/chat')) {
      const body = JSON.parse(String(init?.body))
      chats.push(body)
      const r = rounds[chats.length - 1]
      messages = r.after
      return sse(r.events)
    }
    if (/\/api\/agent\/sessions\/ags_1\/messages$/.test(url)) {
      return new Response(JSON.stringify({ data: messages, meta: { total: messages.length } }), { status: 200 })
    }
    if (url.includes('/api/agent/attention')) {
      return new Response(JSON.stringify({ data: attention, meta: {} }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
  }))
  return chats
}

const agent: Agent = {
  id: 'ag_1', name: '周报助手', desc: '', color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'apv_1', model: 'qwen3.5:4b',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [], enabled: true, created_at: now, updated_at: now,
}

function renderPane(p: Partial<{ provider: AgentProvider | undefined; who: ChatWho; session: AgentSession; onRetitle: (t: string) => void }> = {}) {
  const onRetitle = p.onRetitle ?? vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ChatPane session={p.session ?? session} who={p.who ?? { kind: 'provider', provider: 'provider' in p ? p.provider : provider }} onRetitle={onRetitle} />
    </QueryClientProvider>,
  )
  return onRetitle
}

beforeEach(() => {
  queryClient.clear()
  resetLiveChats()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('对话面板', () => {
  it('发消息：流式回复显示正文和工具卡片，收尾后以读回的消息为准；第一句话改标题', async () => {
    const chats = stub([{
      events: [
        { type: 'delta', text: '好的，' },
        { type: 'tool_call', name: 'create_object', args: '{"type_id":"task","title":"整理演示环境"}' },
        { type: 'tool_result', name: 'create_object', summary: '已建 TSK-0042' },
        { type: 'delta', text: '已经建好了。' },
        { type: 'done', session_id: 'ags_1', message_id: 'a1' },
      ],
      after: [
        m('u1', 'user', '建一条任务：周五前整理演示环境'),
        m('t1', 'tool', '已建 TSK-0042', { tool_name: 'create_object', tool_args: '{"type_id":"task","title":"整理演示环境"}' }),
        m('a1', 'assistant', '好的，\n已经建好了。'),
      ],
    }])
    const onRetitle = renderPane()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '消息' }), '建一条任务：周五前整理演示环境')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(chats).toEqual([{ session_id: 'ags_1', message: '建一条任务：周五前整理演示环境' }])
    expect(onRetitle).toHaveBeenCalledWith('建一条任务：周五前整理演示环境')
    // 读回后：一条人的消息、一条带工具卡片的回复，不重复
    await waitFor(() => expect(screen.getAllByText('建一条任务：周五前整理演示环境')).toHaveLength(1))
    const reply = await screen.findByText(/已经建好了。/)
    const bubble = reply.closest('.ai-bubble') as HTMLElement
    expect(within(bubble).getByText('新建工作对象')).toBeInTheDocument()
    expect(within(bubble).getByText('已执行')).toBeInTheDocument()
    await user.click(within(bubble).getByRole('button', { name: /新建工作对象/ }))
    expect(within(bubble).getByText('已建 TSK-0042')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '消息' })).toHaveValue('')
  })

  it('question 事件显示成选项按钮，点选后作为一条普通消息发出', async () => {
    const q = '【需要你确认】这个需求要不要拆成独立任务？\n- 拆成三个任务：按前端/后端/联调拆\n- 先不拆：作为一个整体推进\n'
    const chats = stub([
      {
        events: [
          { type: 'delta', text: '我先看一下。' },
          {
            type: 'question', id: 'q_1', question: '这个需求要不要拆成独立任务？', multi: false,
            options: [{ label: '拆成三个任务', detail: '按前端/后端/联调拆' }, { label: '先不拆', detail: '作为一个整体推进' }],
          },
          { type: 'done', session_id: 'ags_1', message_id: 'a1' },
        ],
        after: [m('u1', 'user', '这个需求怎么推进'), m('a1', 'assistant', '我先看一下。' + q)],
      },
      {
        events: [{ type: 'delta', text: '那就拆成三个。' }, { type: 'done', session_id: 'ags_1', message_id: 'a2' }],
        after: [
          m('u1', 'user', '这个需求怎么推进'), m('a1', 'assistant', '我先看一下。' + q),
          m('u2', 'user', '拆成三个任务'), m('a2', 'assistant', '那就拆成三个。'),
        ],
      },
    ])
    renderPane()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '消息' }), '这个需求怎么推进')
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    const group = await screen.findByRole('group', { name: '这个需求要不要拆成独立任务？' })
    // 流里一收到就显示
    expect(within(group).getByRole('button', { name: /拆成三个任务/ })).toBeInTheDocument()
    expect(within(group).getByText('按前端/后端/联调拆')).toBeInTheDocument()
    // 读回后按钮仍在（从落库的文字里解析），而且能点
    await waitFor(() => expect(screen.getAllByText('这个需求怎么推进')).toHaveLength(1))
    await waitFor(() => expect(within(screen.getByRole('group', { name: '这个需求要不要拆成独立任务？' })).getByRole('button', { name: /拆成三个任务/ })).toBeEnabled())
    await user.click(within(screen.getByRole('group', { name: '这个需求要不要拆成独立任务？' })).getByRole('button', { name: /拆成三个任务/ }))

    expect(chats[1]).toEqual({ session_id: 'ags_1', message: '拆成三个任务' })
    expect(await screen.findByText('那就拆成三个。')).toBeInTheDocument()
    // 回答过的提问不能再点
    await waitFor(() => expect(within(screen.getByRole('group', { name: '这个需求要不要拆成独立任务？' })).getByRole('button', { name: /先不拆/ })).toBeDisabled())
    // 回答是一条普通的人的消息
    const answer = screen.getByText('拆成三个任务', { selector: '.ai-user .ai-bubble' })
    expect(answer).toBeInTheDocument()
  })

  it('对话出错：在回复的位置显示原因和「重试」，人的消息保留', async () => {
    const chats = stub([
      { events: [{ type: 'error', message: '模型不可用' }], after: [m('u1', 'user', '你好')] },
      { events: [{ type: 'delta', text: '你好！' }, { type: 'done', session_id: 'ags_1', message_id: 'a1' }], after: [m('u1', 'user', '你好'), m('a1', 'assistant', '你好！')] },
    ])
    renderPane({ session: { ...session, title: '已有标题' } })
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '消息' }), '你好')
    await user.click(screen.getByRole('button', { name: '发送' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('回复失败：模型不可用')
    await waitFor(() => expect(screen.getAllByText('你好')).toHaveLength(1))
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(chats[1]).toEqual({ session_id: 'ags_1', message: '你好' })
    expect(await screen.findByText('你好！')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('服务商停用或删除后只能回看：发送、⌘Enter、示例问题都发不出去', async () => {
    const chats = stub([])
    renderPane({ provider: { ...provider, enabled: false } })
    const user = userEvent.setup()
    expect(await screen.findByText('这个服务商已停用，只能回看')).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: '消息' })
    expect(box).toHaveAttribute('placeholder', '只能回看，不能再发消息')
    await user.type(box, '还能发吗')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(screen.getByRole('button', { name: '我现在有哪些任务最急？' })).toBeDisabled()
    expect(chats).toEqual([])
  })

  it('已删除的服务商：提示删除', async () => {
    stub([])
    renderPane({ provider: undefined })
    expect(await screen.findByText('这个服务商已删除，只能回看')).toBeInTheDocument()
  })

  it('挂了 Agent：占位写 Agent 名，提示写操作按权限等确认', async () => {
    stub([])
    renderPane({ who: { kind: 'agent', agent } })
    const box = await screen.findByRole('textbox', { name: '消息' })
    expect(box).toHaveAttribute('placeholder', '和 周报助手 对话…')
    expect(screen.getByText('⌘Enter 发送；写操作按权限停下来等你确认')).toBeInTheDocument()
  })

  it('Agent 停用后只能回看：发送、⌘Enter、示例问题都发不出去（SPEC-sessions-1.26）', async () => {
    const chats = stub([])
    renderPane({ who: { kind: 'agent', agent: { ...agent, enabled: false } } })
    const user = userEvent.setup()
    expect(await screen.findByText('这个 Agent 已停用，只能回看')).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: '消息' })
    expect(box).toHaveAttribute('placeholder', '只能回看，不能再发消息')
    await user.type(box, '还能发吗')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '我现在有哪些任务最急？' }))
    expect(chats).toEqual([])
  })

  it('Agent 已删除：历史照常回看，提示已删除（SPEC-sessions-1.27）', async () => {
    const chats = stub([], [m('m1', 'user', '你好'), m('m2', 'assistant', '你好！')])
    renderPane({ who: { kind: 'gone' }, session: { ...session, title: '打过招呼', message_count: 2 } })
    expect(await screen.findByText('你好！')).toBeInTheDocument()
    expect(screen.getByText('这个 Agent 已删除，只能回看')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(chats).toEqual([])
  })
})

describe('移除历史消息（SPEC-sessions-1.43）', () => {
  it('悬停出「移除」，就地确认后按气泡的原始消息 id 调接口，读回后气泡没了；取消不调', async () => {
    let messages = [m('u1', 'user', '第一句'), m('t1', 'tool', '查到 3 条', { tool_name: 'search_objects', tool_args: '{}' }), m('a1', 'assistant', '回答一'), m('u2', 'user', '第二句')]
    const removed: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/agent/sessions/ags_1/messages/remove')) {
        const ids = JSON.parse(String(init?.body)).ids as string[]
        removed.push(ids)
        messages = messages.filter((x) => !ids.includes(x.id))
        return new Response(JSON.stringify({ data: { session_id: 'ags_1', removed: ids.length } }), { status: 200 })
      }
      if (/\/api\/agent\/sessions\/ags_1\/messages$/.test(url)) {
        return new Response(JSON.stringify({ data: messages, meta: { total: messages.length } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
    }))
    renderPane({ session: { ...session, message_count: 4 } })
    await screen.findByText('回答一')
    const btns = screen.getAllByRole('button', { name: '移除' })
    expect(btns).toHaveLength(3)
    await userEvent.click(btns[1])
    const ask = screen.getByRole('group', { name: '确认移除' })
    await userEvent.click(within(ask).getByRole('button', { name: '取消' }))
    expect(removed).toEqual([])
    await userEvent.click(screen.getAllByRole('button', { name: '移除' })[1])
    await userEvent.click(within(screen.getByRole('group', { name: '确认移除' })).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(screen.queryByText('回答一')).toBeNull())
    expect(removed).toEqual([['a1', 't1']])
    expect(screen.getByText('第一句')).toBeInTheDocument()
  })
})

// 页面刷新后历史里的等确认卡片没有调用 id：从等确认注意力接口补（P0-O3）
const ASKED_ARGS = '{"type_id":"task","title":"开通试点账号"}'
const ASKED: AgentMessage[] = [
  m('u1', 'user', '建一条任务：开通试点账号'),
  m('t1', 'tool', '等待确认：新建「开通试点账号」', { tool_name: 'create_object', tool_args: ASKED_ARGS }),
  m('a1', 'assistant', '我准备建这条任务。\n【等你确认】新建「开通试点账号」，确认后才会执行。\n'),
]

describe('刷新后恢复确认卡（P0-O3）', () => {
  it('attention 里有这个会话的 pending 调用：历史卡片补上 id，出现可点的确认按钮', async () => {
    stub([], ASKED, {
      total: 1,
      pending_calls: [{
        call_id: 'atc_7', session_id: 'ags_1', session_title: '新会话', agent_id: 'ag_1', agent_name: '周报助手',
        tool: 'create_object', args: ASKED_ARGS, summary: '新建「开通试点账号」', at: now,
      }],
      waiting_runs: [],
    })
    renderPane({ session: { ...session, message_count: 3 } })
    const btn = await screen.findByRole('button', { name: '确认执行' })
    await waitFor(() => expect(btn).toBeEnabled())
    expect(document.querySelector('[data-call="atc_7"]')).not.toBeNull()
    expect(screen.queryByText(/页面刷新过，这里确认不了/)).toBeNull()
  })

  it('attention 里没有这个会话的 pending：仍是刷新过的样子，说明点不了', async () => {
    stub([], ASKED)
    renderPane({ session: { ...session, message_count: 3 } })
    expect(await screen.findByText(/页面刷新过，这里确认不了/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull()
  })
})

// 会话上下文面板（P0-S2）：GET .../context 和 PATCH instruction 另打桩；messages/attention 也照旧回。
function stubContext(opts: { context: unknown; messages?: AgentMessage[]; attention?: unknown }) {
  const patches: { instruction: string }[] = []
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    urls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/api/agent/sessions/ags_1/context')) {
      return new Response(JSON.stringify({ data: opts.context }), { status: 200 })
    }
    if (url.endsWith('/api/agent/sessions/ags_1') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { instruction: string }
      patches.push(body)
      return new Response(JSON.stringify({ data: { ...session, instruction: body.instruction } }), { status: 200 })
    }
    if (url.includes('/api/agent/attention')) {
      return new Response(JSON.stringify({ data: opts.attention ?? { total: 0, pending_calls: [], waiting_runs: [] }, meta: {} }), { status: 200 })
    }
    if (/\/api\/agent\/sessions\/ags_1\/messages$/.test(url)) {
      const messages = opts.messages ?? []
      return new Response(JSON.stringify({ data: messages, meta: { total: messages.length } }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
  }))
  return { patches, urls }
}

const CONTEXT = {
  session_id: 'ags_1', history_limit: 40, total_messages: 45, dropped_count: 5, sent_chars: 1200, approx_tokens: 800,
  instruction: '旧的追加要求',
  messages: [
    { id: 'c0', role: 'tool', content: '很老的工具结果', tool_name: 'create_object', tool_args: '{}', created_at: now, dropped: true },
    { id: 'c1', role: 'user', content: '会被发送的一句', created_at: now, dropped: false },
  ],
}

describe('会话上下文面板（P0-S2）', () => {
  it('打开才读上下文：显示统计、裁掉标记和消息预览，收起后不再请求', async () => {
    const { urls } = stubContext({ context: CONTEXT, messages: [m('u1', 'user', '随便聊聊')] })
    renderPane()
    const user = userEvent.setup()
    const open = await screen.findByRole('button', { name: '上下文' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    // 面板没开不请求
    expect(urls.some((u) => u.includes('/context'))).toBe(false)

    await user.click(open)
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText(/将发送最近 40 条（总 45 条，前 5 条已裁掉） · 约 800 tokens/)).toBeInTheDocument()
    expect(screen.getByText('会被发送的一句')).toBeInTheDocument()
    expect(screen.getByText('工具 create_object')).toBeInTheDocument()
    // 裁掉的那条置灰并标明不会发送
    const dropped = screen.getByText('很老的工具结果').closest('.chat-context-msg') as HTMLElement
    expect(dropped).toHaveClass('dropped')
    expect(within(dropped).getByText('已裁掉（不会发送）')).toBeInTheDocument()
    // 后端带回的当前追加要求初始化输入框
    expect(screen.getByRole('textbox', { name: '会话追加要求' })).toHaveValue('旧的追加要求')
    expect(screen.getByRole('textbox', { name: '会话追加要求' })).toHaveAttribute('maxlength', '2000')

    const before = urls.filter((u) => u.includes('/context')).length
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText(/将发送最近 40 条/)).toBeNull()
    expect(urls.filter((u) => u.includes('/context'))).toHaveLength(before)
  })

  it('保存追加要求：PATCH instruction，成功后显示已保存并重读上下文', async () => {
    const { patches, urls } = stubContext({ context: CONTEXT })
    renderPane()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '上下文' }))
    const ta = await screen.findByRole('textbox', { name: '会话追加要求' })
    await user.clear(ta)
    await user.type(ta, '回答尽量简短')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(patches).toEqual([{ instruction: '回答尽量简短' }]))
    expect(await screen.findByText('已保存')).toBeInTheDocument()
    // 保存后按会话失效，上下文重新读一遍（mock 里回的还是旧值）
    await waitFor(() => expect(urls.filter((u) => u.includes('/context')).length).toBeGreaterThanOrEqual(2))
    // refetch 不覆盖：以这次保存的值/用户正在写的为准，不回退成后端旧值
    expect(ta).toHaveValue('回答尽量简短')
  })
})
