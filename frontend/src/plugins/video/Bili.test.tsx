import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeOf } from './routes'
import { curveOf, guardText, leftChars, msgTime } from './biliModel'
import Page from './Page'

const T = '2099-03-01T08:00:00Z'
type Call = { method: string; path: string; body?: Record<string, unknown> }

const account = (over: Record<string, unknown> = {}) => ({
  connector_id: 'cn_b1', name: 'B 站网页登录', status: 'connected', login: 'logged_in', mid: '4242', uname: '测试UP主', unread: 2, poll_sec: 60, ...over,
})

// 内存里的 B 站组件后端：账号、概览、会话、消息，发送按 client_msg_id 去重（同 internal/plugins/video/biliapi.go）
function fakeBackend(opts: { login?: string; guardOnSend?: boolean; noConnector?: boolean } = {}) {
  const calls: Call[] = []
  const acc = account({ login: opts.login ?? 'logged_in' })
  const msgs: Record<string, unknown>[] = [
    { id: 'bpm_1', talker_id: '777', direction: 'in', msg_type: 1, text: '请问合作怎么联系', at: T, status: 'received', created_at: T },
  ]
  const sentKeys = new Set<string>()
  let pollN = 0
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname + u.search, body })
    const p = u.pathname
    if (p === '/api/objects') return json([], 200, { total: 0 })
    if (['/api/video/series', '/api/video/topics', '/api/video/clips', '/api/video/videos'].includes(p)) return json([], 200, { total: 0 })
    if (p === '/api/video/bili/accounts') return json(opts.noConnector ? [] : [acc], 200, { total: 1 })
    if (p === '/api/connectors' && method === 'POST') return json({ id: 'cn_new', tool: 'bilibili_web', name: 'B 站网页登录', status: 'connecting', config: {}, secret_hints: {}, tools: [] })
    if (p === '/api/video/bili/cn_b1/login/qrcode') return json({ login_id: 'lg1', qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', expires_at: '2999-01-01T00:00:00Z' })
    if (p === '/api/video/bili/cn_b1/login/poll') {
      pollN++
      if (pollN < 2) return json({ state: 'scanned', message: '已扫码，在手机上确认登录' })
      acc.login = 'logged_in'
      return json({ state: 'done', message: '登录成功', account: acc })
    }
    if (p === '/api/video/bili/cn_b1/overview') {
      return json({
        account: acc, days: [{ date: '2099-02-28', source: 'web', followers: 3400, updated_at: T }, { date: '2099-03-01', source: 'open+web', followers: 3450, updated_at: T }],
        latest: { date: '2099-03-01', source: 'open+web', followers: 3450, following: 11, archives: 7, total_click: 120000, total_like: 8800, incr_fans: 21, incr_click: 1500, updated_at: T },
        trends: [{ metric: 'click', points: [{ date: '2099-02-28', value: 100 }, { date: '2099-03-01', value: 110 }] }],
      })
    }
    if (p === '/api/video/bili/cn_b1/sessions') {
      return json([{ talker_id: '777', talker_name: '热心观众', talker_face: '', unread: 2, last_text: '请问合作怎么联系', last_at: T, updated_at: T }], 200,
        { total: 1, unread: 2, account: acc })
    }
    if (p === '/api/video/bili/cn_b1/sessions/777/messages' && method === 'GET') {
      return json(msgs, 200, { total: msgs.length, has_more: false, session: { talker_id: '777', talker_name: '热心观众' } })
    }
    if (p === '/api/video/bili/cn_b1/sessions/777/messages' && method === 'POST') {
      if (opts.guardOnSend) {
        return json({ error: { code: 'bili_guarded', message: '暂停', guard: { until: '2999-01-01T00:00:00Z', reason: 'B 站网页接口返回 -412：请求被拦截', code: -412 }, message_id: 'bpm_x' } }, 429)
      }
      if (sentKeys.has(body.client_msg_id)) return json(msgs.find((m) => m.client_msg_id === body.client_msg_id), 200, { duplicate: true })
      sentKeys.add(body.client_msg_id)
      const m = { id: `bpm_${msgs.length + 1}`, talker_id: '777', direction: 'out', msg_type: 1, text: body.text, at: T, status: 'sent', client_msg_id: body.client_msg_id, created_at: T }
      msgs.push(m)
      return json(m, 201)
    }
    return json({ error: { code: 'not_found', message: '没有这个接口' } }, 404)
  }))
  return { calls, msgs }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { router }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('B 站组件', () => {
  it('路由和标签栏：/videos/bilibili 是 B 站页', async () => {
    expect(routeOf('bilibili')).toEqual({ kind: 'bilibili' })
    fakeBackend()
    show('/videos/bilibili')
    expect(await screen.findByRole('tab', { name: 'B 站', selected: true })).toBeInTheDocument()
  })

  it('账户概览：数字卡、昨日新增、开放平台来源说明、趋势', async () => {
    fakeBackend()
    show('/videos/bilibili')
    expect(await screen.findByText('3,450')).toBeInTheDocument()
    expect(screen.getByText('昨日 +21')).toBeInTheDocument()
    expect(screen.getByText(/粉丝、关注、过审稿件取开放平台/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /播放按天/ })).toHaveAttribute('aria-label', expect.stringContaining('2099-03-01 110'))
    // 页面上不出现任何凭证字段
    expect(document.body.textContent).not.toMatch(/SESSDATA|bili_jct|csrf/i)
  })

  it('没登录时扫码：生成二维码，轮询到成功', async () => {
    const be = fakeBackend({ login: 'logged_out' })
    show('/videos/bilibili')
    await userEvent.click(await screen.findByRole('button', { name: '生成二维码' }))
    expect(await screen.findByRole('img', { name: 'B 站登录二维码' })).toBeInTheDocument()
    await waitFor(() => expect(be.calls.filter((c) => c.path.endsWith('/login/poll')).length).toBeGreaterThanOrEqual(2), { timeout: 6000 })
    expect(be.calls.find((c) => c.path.endsWith('/login/poll'))?.body).toEqual({ login_id: 'lg1' })
  }, 10000)

  it('没有连接器时引导新建', async () => {
    const be = fakeBackend({ noConnector: true })
    show('/videos/bilibili')
    await userEvent.click(await screen.findByRole('button', { name: '新建并扫码登录' }))
    await waitFor(() => expect(be.calls.some((c) => c.method === 'POST' && c.path === '/api/connectors' && c.body?.tool === 'bilibili_web')).toBe(true))
  })

  it('私信：会话列表、消息记录，点发送才发，一次一条带 client_msg_id', async () => {
    const be = fakeBackend()
    show('/videos/bilibili?v=dm&t=777')
    expect(await screen.findByText('请问合作怎么联系', { selector: '.bl-bubble' })).toBeInTheDocument()
    const sessions = screen.getByRole('list', { name: '私信会话' })
    expect(within(sessions).getByText('热心观众')).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: '私信内容' })
    const send = screen.getByRole('button', { name: '发送' })
    expect(send).toBeDisabled()
    await userEvent.type(box, '您好，商务合作请发邮件')
    expect(be.calls.some((c) => c.method === 'POST' && c.path.endsWith('/messages'))).toBe(false)
    await userEvent.click(send)
    await waitFor(() => expect(be.msgs.length).toBe(2))
    const posts = be.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'))
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ client_msg_id: expect.stringMatching(/^cm-[A-Za-z0-9_-]{8,}$/), text: '您好，商务合作请发邮件' })
    await waitFor(() => expect(box).toHaveValue(''))
  })

  it('被限频：发送失败时显示退避原因，不自动重试', async () => {
    const be = fakeBackend({ guardOnSend: true })
    show('/videos/bilibili?v=dm&t=777')
    const box = await screen.findByRole('textbox', { name: '私信内容' })
    fireEvent.change(box, { target: { value: '在的' } })
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/B 站请求暂停中，原因和恢复时间见上方说明/)).toBeInTheDocument()
    expect(be.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'))).toHaveLength(1)
    expect(box).toHaveValue('在的')
  })
})

describe('biliModel', () => {
  it('趋势取点、退避文案、字数、消息时间', () => {
    expect(curveOf('followers', [], [{ date: '2099-03-01', source: 'web', followers: 5, updated_at: T }, { date: '2099-03-02', source: 'web', updated_at: T }]))
      .toEqual([{ date: '2099-03-01', value: 5 }])
    expect(curveOf('like', [{ metric: 'like', points: [{ date: 'b', value: 2 }, { date: 'a', value: 1 }] }], [])).toEqual([{ date: 'a', value: 1 }, { date: 'b', value: 2 }])
    expect(guardText({ until: '2000-01-01T00:00:00Z', reason: 'x', code: -412 })).toBeNull()
    expect(guardText({ until: '2999-01-01T00:00:00Z', reason: '请求被拦截', code: -412 })).toMatch(/暂停到 .*不发任何请求.*请求被拦截/)
    expect(leftChars('长'.repeat(501), 500)).toBe(-1)
    const now = new Date(2099, 2, 1, 12, 0)
    expect(msgTime(new Date(2099, 2, 1, 9, 5).toISOString(), now)).toBe('09:05')
    expect(msgTime(new Date(2099, 1, 27, 9, 5).toISOString(), now)).toBe('02-27 09:05')
  })
})
