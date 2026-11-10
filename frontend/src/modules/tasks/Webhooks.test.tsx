// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Delivery, ObjectStatus, Webhook, WorkObject } from '../../core/data'
import Page from './Page'
import { hmacHex } from './webhookModel'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

function hook(id: string, name: string, p: Partial<Webhook> = {}): Webhook {
  return {
    id, name, token: `tok${id}`, enabled: true,
    mapping: { title: 'title', desc: 'description', priority: 'priority', assignee: '', due: '' },
    filter: '', dedupe: '', defaults: { priority: 'P2', assignee: '' }, sample: '{"title":"示例"}',
    secret_hint: 'whsec_Ab', secret_version: 1, secret_rotated_at: null, created_at: '', updated_at: '', ...p,
  }
}
function dl(hookId: string, result: Delivery['result'], at: string, p: Partial<Delivery> = {}): Delivery {
  return {
    id: `dl_${hookId}_${at}`, hook_id: hookId, at, payload: { title: 'x' }, result, reason: result === 'failed' ? '标题路径 title 取不到值' : '',
    task_id: null, external_id: '', dedupe_key: '', mapped: { title: '', desc: '', priority: '', assignee: '', due: '' }, task_ref: '', task_deleted: false, ...p,
  }
}
function task(id: string, title: string, source: string, ref?: Record<string, unknown>): WorkObject {
  return {
    id, type_id: 'task', ref: `TSK-${id.slice(-4)}`, title, body: '', status: 'todo', priority: '', owner: '', owner_id: null,
    category_id: null, project_id: null, source, props: ref ? { source_ref: ref } : null, workdir: '', due_at: null, started_at: null,
    completed_at: null, archived_at: null, deleted_at: null, created_at: ago(5), updated_at: ago(5), tags: [], link_count: 0, participants: [],
  }
}

const SECRET = 'whsec_test_secret_value'

// 内存里的后端：Webhook、投递记录、任务；收件地址按真规则验签，签名不对回 401
function fakeBackend(hooks: Webhook[], deliveries: Delivery[] = [], tasks: WorkObject[] = []) {
  const json = (data: unknown, meta?: unknown, status = 200) => new Response(JSON.stringify({ data, meta }), { status })
  const calls: string[] = []
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const raw = init?.body ? String(init.body) : ''
    const body = raw ? JSON.parse(raw) : undefined
    calls.push(`${method} ${u.pathname}${u.searchParams.get('source') ? `?source=${u.searchParams.get('source')}` : ''}`)
    if (u.pathname === '/api/object-types') return json([{ id: 'task', name: '任务', statuses }])
    if (u.pathname === '/api/counts') return json({ overdue: 0, by_type: {}, total: 0 })
    if (u.pathname === '/api/objects') {
      const src = u.searchParams.get('source')?.split(',')
      const rows = tasks.filter((t) => u.searchParams.get('type') !== 'task' || t.type_id === 'task').filter((t) => !src || src.includes(t.source))
      const limit = Number(u.searchParams.get('limit') ?? 200)
      return json(rows.slice(0, limit), { total: rows.length, limit, offset: 0 })
    }
    if (u.pathname === '/api/webhooks' && method === 'POST') {
      const h = hook(`wh_new${++n}`, body.name, { ...body })
      hooks.unshift(h)
      return json({ ...h, secret: SECRET }, undefined, 201)
    }
    if (u.pathname === '/api/webhooks') return json(hooks, { total: hooks.length })
    const hm = u.pathname.match(/^\/api\/hooks\/([^/]+)$/)
    if (hm) {
      const h = hooks.find((x) => x.token === hm[1])!
      const sig = new Headers(init?.headers).get('X-PMW-Signature')
      if (sig !== await hmacHex(SECRET, raw)) return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'webhook signature mismatch' } }), { status: 401 })
      const t = task(`obj_t00${++n}`, body.title, 'webhook', { hook_id: h.id, delivery_id: `dl_p${n}` })
      tasks.unshift(t)
      const d = dl(h.id, 'created', new Date().toISOString(), { id: `dl_p${n}`, payload: body, task_id: t.id, task_ref: t.ref, mapped: { title: body.title, desc: '', priority: '', assignee: '', due: '' } })
      deliveries.unshift(d)
      return json(d, undefined, 201)
    }
    const m = u.pathname.match(/^\/api\/webhooks\/([^/]+)(\/deliveries|\/usage)?$/)
    if (m) {
      const h = hooks.find((x) => x.id === m[1])!
      if (m[2] === '/deliveries') {
        const mine = deliveries.filter((d) => d.hook_id === h.id)
        return json(mine.slice(0, Number(u.searchParams.get('limit') ?? 50)), { total: mine.length })
      }
      if (m[2] === '/usage') return json({ tasks: tasks.filter((t) => (t.props?.source_ref as { hook_id?: string })?.hook_id === h.id).length, open_tasks: 0 })
      if (method === 'PATCH') { Object.assign(h, body); return json(h) }
      return json(h)
    }
    const om = u.pathname.match(/^\/api\/objects\/([^/]+)$/)
    if (om) return json(tasks.find((t) => t.id === om[1]))
    if (u.pathname === '/api/artifacts/by-object') return json({ objects: [], total: 0, by_kind: {}, by_source: {} })
    return json([], { total: 0 })
  }))
  return calls
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/tasks/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

describe('Webhook 页（TASK-04b）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('列表：最近失败的排在前面，二级菜单「Webhook 接入」带失败数和红点，「最近推送」列出推送过的', async () => {
    fakeBackend(
      [hook('wh_a', 'Sentry 线上告警'), hook('wh_b', '官网需求表单'), hook('wh_c', '没推过的')],
      [dl('wh_a', 'created', ago(3), { task_ref: 'TSK-0001', mapped: { title: '导出超时', desc: '', priority: '', assignee: '', due: '' } }), dl('wh_b', 'failed', ago(30))],
    )
    renderPage('/tasks/webhooks')
    const nav = screen.getByRole('navigation', { name: '任务' })
    expect(await within(nav).findByText('3 个，1 个最近推送失败')).toBeInTheDocument()
    const rows = await screen.findAllByRole('button', { name: /Sentry 线上告警|官网需求表单|没推过的/ })
    const inTable = rows.filter((r) => r.classList.contains('hook-row'))
    await waitFor(() => expect(inTable.map((r) => r.getAttribute('aria-label'))).toEqual(['官网需求表单', 'Sentry 线上告警', '没推过的']))
    expect(await screen.findByText('TSK-0001 导出超时')).toBeInTheDocument()
    expect(screen.getByText('还没收到推送')).toBeInTheDocument()
    // 最近推送组：新的在前，没推过的不出现
    expect(within(nav).getByText('3 分钟前推送')).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: /没推过的/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /最近失败/ }))
    expect(screen.getAllByRole('button', { name: /Sentry 线上告警|官网需求表单|没推过的/ }).filter((r) => r.classList.contains('hook-row'))).toHaveLength(1)
  })

  it('新建后拿到 Secret 明文，测试推送按签名推到收件地址，推送记录多一条，任务带 Webhook 来源标签', async () => {
    const calls = fakeBackend([])
    const router = renderPage('/tasks/webhooks/new')
    expect(await screen.findByText('先保存再测试')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '创建 Webhook' }))
    expect(screen.getAllByText('还没有名称').length).toBeGreaterThan(0)
    expect(calls).not.toContain('POST /api/webhooks')

    await userEvent.type(screen.getByPlaceholderText('比如：Sentry 线上告警'), '表单推送')
    await userEvent.click(screen.getByRole('button', { name: '创建 Webhook' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/webhooks/wh_new1'))
    expect(await screen.findByText(/明文只在这次打开里看得到/)).toBeInTheDocument()
    expect(await screen.findByText('还没有收到推送')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '发送测试推送' }))
    const testSec = screen.getByRole('region', { name: '测试推送' })
    expect(await within(testSec).findByRole('button', { name: /示例：客户要求导出支持 Excel/ })).toBeInTheDocument()
    expect(within(testSec).getByText('已建任务')).toBeInTheDocument()
    expect(calls).toContain('POST /api/hooks/tokwh_new1')
    // 推送记录多一条
    expect(await screen.findByText('1 次')).toBeInTheDocument()

    // 全部任务里这条带「Webhook · 名称」来源标签（来源分类视图已去掉）
    router.navigate('/tasks')
    expect(await screen.findByText('Webhook · 表单推送')).toBeInTheDocument()
  })

  it('没有 Secret 明文时测试推送不可用；粘贴错的 Secret 推送被拒收，给出说明', async () => {
    const calls = fakeBackend([hook('wh_a', 'Sentry 线上告警')])
    renderPage('/tasks/webhooks/wh_a')
    const btn = await screen.findByRole('button', { name: '发送测试推送' })
    expect(btn).toBeDisabled()
    expect(screen.getByText(/要用 Secret 明文签名/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/测试用的 Secret/), 'whsec_wrong')
    await userEvent.click(btn)
    expect(await screen.findByText(/签名对不上，推送被拒收了/)).toBeInTheDocument()
    expect(calls).toContain('POST /api/hooks/tokwh_a')
  })

  it('有没保存的改动时先保存再推送', async () => {
    const calls = fakeBackend([hook('wh_a', 'Sentry 线上告警')])
    renderPage('/tasks/webhooks/wh_a')
    await userEvent.type(await screen.findByLabelText(/测试用的 Secret/), SECRET)
    await userEvent.type(screen.getByPlaceholderText('action == created'), 'title == 示例')
    expect(screen.getByText('示例推送：满足，会建任务')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '发送测试推送' }))
    await waitFor(() => expect(calls).toContain('POST /api/hooks/tokwh_a'))
    expect(calls.indexOf('PATCH /api/webhooks/wh_a')).toBeGreaterThan(-1)
    expect(calls.indexOf('PATCH /api/webhooks/wh_a')).toBeLessThan(calls.indexOf('POST /api/hooks/tokwh_a'))
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled()
  })

  it('打开的 Webhook 不存在时说明已删除', async () => {
    fakeBackend([])
    renderPage('/tasks/webhooks/wh_gone')
    expect(await screen.findByText('这个 Webhook 已删除')).toBeInTheDocument()
  })

  it('二级菜单没有「来源」分类，旧的来源视图地址回到全部任务，列表照样显示来源标签', async () => {
    fakeBackend([], [], [task('obj_0001', '导入的任务', 'import'), task('obj_0002', '手建的', 'manual')])
    const router = renderPage('/tasks/source/manual')
    expect(await screen.findByText('导入的任务')).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    expect(screen.getAllByText('人工').map((el) => el.getAttribute('title')).sort()).toEqual(['人工', '导入：导入脚本建的任务'].sort())
    const nav = screen.getByRole('navigation', { name: '任务' })
    expect(within(nav).queryByText('来源')).not.toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: /^人工/ })).not.toBeInTheDocument()
  })
})
