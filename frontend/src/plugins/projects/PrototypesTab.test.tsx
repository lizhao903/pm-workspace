import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectPrototype } from '../../core/data'
import { PrototypesTab } from './PrototypesTab'

const ROOT = '/p/app'

function pt(p: Partial<ProjectPrototype>): ProjectPrototype {
  return {
    id: 'pt_1', project_id: 'obj_p', name: '看板', dir: `${ROOT}/web`, command: 'python3 -m http.server', argv: [], port: 8101,
    url: 'http://127.0.0.1:8101', status: 'stopped', error: '', pid: 0, started_at: null, last_crash: null,
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
  }
}

type Call = { method: string; path: string; body?: unknown; query: string }

function fakeBackend(rows: ProjectPrototype[], opts: { startErr?: string; logs?: string[] } = {}) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body, query: u.search })
    const base = '/api/projects/obj_p/prototypes'
    if (u.pathname === base && method === 'GET') return json(rows, 200, { total: rows.length })
    if (u.pathname === base && method === 'POST') { const x = pt({ id: 'pt_new', ...body }); rows.push(x); return json(x, 201) }
    const m = u.pathname.match(/^\/api\/projects\/obj_p\/prototypes\/([^/]+)(?:\/(start|stop|logs))?$/)
    if (m) {
      const x = rows.find((r) => r.id === m[1])!
      if (m[2] === 'start') {
        if (opts.startErr) return json({ error: { code: 'conflict', message: opts.startErr } }, 409)
        x.status = 'starting'
        return json(x)
      }
      if (m[2] === 'stop') { x.status = 'stopped'; return json(x) }
      if (m[2] === 'logs') {
        const lines = (opts.logs ?? []).map((text, i) => ({ seq: i + 1, at: '', text }))
        const after = Number(u.searchParams.get('after') ?? 0)
        return json(lines.filter((l) => l.seq > after), 200, { last_seq: lines.length, status: x.status })
      }
      if (method === 'PATCH') { Object.assign(x, body); return json(x) }
    }
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function mount(props: Partial<Parameters<typeof PrototypesTab>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onAdding = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <PrototypesTab projectId="obj_p" projectName="工作台" root={ROOT} adding={false} onAdding={onAdding} {...props} />
    </QueryClientProvider>,
  )
  return onAdding
}

afterEach(() => vi.unstubAllGlobals())

describe('原型标签', () => {
  it('没有原型时显示空状态和「加原型」', async () => {
    fakeBackend([])
    const onAdding = mount()
    expect(await screen.findByText('还没有原型')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '加原型' }))
    expect(onAdding).toHaveBeenCalledWith(true)
  })

  it('加原型：目录相对项目目录，拼成绝对路径再发', async () => {
    const calls = fakeBackend([])
    mount({ adding: true })
    const form = await screen.findByRole('group', { name: '加原型' })
    await userEvent.type(within(form).getByLabelText('名称'), '新原型')
    await userEvent.type(within(form).getByLabelText('目录'), 'proto')
    await userEvent.click(within(form).getByRole('button', { name: '加上' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: '新原型', dir: `${ROOT}/proto`, command: 'npm run dev', port: 7781 })
  })

  it('启动后变启动中；后端拒绝的原因原样显示', async () => {
    const calls = fakeBackend([pt({})], { startErr: '8101 端口已经被本机别的程序占着，先关掉它或换一个端口' })
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    await userEvent.click(within(card).getByRole('button', { name: '启动' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('8101 端口已经被本机别的程序占着，先关掉它或换一个端口')
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/start'))).toBe(true)
  })

  it('启动成功后显示启动中，日志框显示输出', async () => {
    fakeBackend([pt({})], { logs: ['$ cd /p/app/web', '$ python3 -m http.server'] })
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    await userEvent.click(within(card).getByRole('button', { name: '启动' }))
    expect(await within(card).findByText('启动中')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: '看日志' }))
    expect(await within(card).findByLabelText('日志')).toHaveTextContent('$ python3 -m http.server')
  })

  it('运行中：打开、停止，修改和移除置灰，显示已运行', async () => {
    fakeBackend([pt({ status: 'running', started_at: new Date(Date.now() - 5 * 60000).toISOString(), pid: 9 })])
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    expect(within(card).getByRole('link', { name: '打开 :8101' })).toHaveAttribute('href', 'http://127.0.0.1:8101')
    expect(within(card).getByRole('button', { name: '修改' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '移除' })).toBeDisabled()
    expect(within(card).getByText('5 分钟')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '停止' })).toBeEnabled()
  })

  it('外部启动：显示「运行中（外部启动）」，能打开，启动和停止置灰并说明，修改和移除可用', async () => {
    const calls = fakeBackend([pt({ status: 'external', port: 7778, url: 'http://127.0.0.1:7778' })])
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    expect(within(card).getByText('运行中（外部启动）')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: '打开 :7778' })).toHaveAttribute('href', 'http://127.0.0.1:7778')
    const start = within(card).getByRole('button', { name: '启动' })
    const stop = within(card).getByRole('button', { name: '停止' })
    expect(start).toBeDisabled()
    expect(start).toHaveAttribute('title', expect.stringContaining('不是这里启动的'))
    expect(stop).toBeDisabled()
    expect(stop).toHaveAttribute('title', expect.stringContaining('这里停不了'))
    expect(within(card).getByRole('button', { name: '修改' })).toBeEnabled()
    expect(within(card).getByRole('button', { name: '移除' })).toBeEnabled()
    expect(calls.some((c) => c.path.endsWith('/start') || c.path.endsWith('/stop'))).toBe(false)
  })

  it('崩溃：显示原因、退出码和最后的输出，按钮是「重新启动」', async () => {
    const crash = { id: 1, prototype_id: 'pt_1', project_id: 'obj_p', exit_code: 3, signal: '', reason: '进程意外退出：退出码 3', log: ['boom'], started_at: '', exited_at: new Date().toISOString() }
    fakeBackend([pt({ status: 'crashed', error: '进程意外退出：退出码 3', last_crash: crash })])
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    expect(within(card).getByText('进程意外退出：退出码 3')).toBeInTheDocument()
    expect(within(card).getByLabelText('崩溃时的输出')).toHaveTextContent('退出码 3')
    expect(within(card).getByLabelText('崩溃时的输出')).toHaveTextContent('boom')
    expect(within(card).getByRole('button', { name: '重新启动' })).toBeEnabled()
  })

  it('本项目另一个在跑的原型占着端口时，启动置灰并说明', async () => {
    fakeBackend([pt({ id: 'pt_1', name: '甲', status: 'running' }), pt({ id: 'pt_2', name: '乙' })])
    mount()
    const card = await screen.findByRole('group', { name: '乙' })
    expect(within(card).getByRole('button', { name: '启动' })).toBeDisabled()
    expect(within(card).getByText('8101 端口被「工作台 / 甲」占着，换一个端口再启动')).toBeInTheDocument()
  })

  it('修改：只发改了的字段，目录换成绝对路径', async () => {
    const calls = fakeBackend([pt({})])
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    await userEvent.click(within(card).getByRole('button', { name: '修改' }))
    const form = within(card).getByRole('group', { name: '修改原型' })
    const dir = within(form).getByLabelText(/^目录/)
    expect(dir).toHaveValue('web')
    await userEvent.clear(dir)
    await userEvent.type(dir, 'site')
    const port = within(form).getByLabelText('端口')
    await userEvent.clear(port)
    await userEvent.type(port, '8200')
    await userEvent.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ dir: `${ROOT}/site`, port: 8200 })
  })

  it('停着且没有日志时「看日志」置灰；有日志就能点', async () => {
    fakeBackend([pt({})])
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    await waitFor(() => expect(within(card).getByRole('button', { name: '看日志' })).toBeDisabled())
  })

  it('停着但有上次的日志时「看日志」能点', async () => {
    const calls = fakeBackend([pt({})], { logs: ['上次的输出'] })
    mount()
    const card = await screen.findByRole('group', { name: '看板' })
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/logs'))).toBe(true))
    expect(within(card).getByRole('button', { name: '看日志' })).toBeEnabled()
    await userEvent.click(within(card).getByRole('button', { name: '看日志' }))
    expect(await within(card).findByLabelText('日志')).toHaveTextContent('上次的输出')
  })

  it('已停止多于 6 个时折叠成一行', async () => {
    fakeBackend(Array.from({ length: 7 }, (_, i) => pt({ id: `pt_${i}`, name: `原型${i}`, port: 8100 + i })))
    mount()
    const fold = await screen.findByRole('button', { name: /已停止 7 个/ })
    expect(screen.queryByRole('group', { name: '原型0' })).toBeNull()
    await userEvent.click(fold)
    expect(screen.getByRole('group', { name: '原型0' })).toBeInTheDocument()
  })
})
