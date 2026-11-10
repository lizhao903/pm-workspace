// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage } from '../../core/data'
import { AttachmentPanel } from './AttachmentPanel'

let calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
let projectsRunning = true
let mats: Record<string, { id: string; kind: string; value: string }[]> = {}
let fetchFails = false

const LINK = 'https://www.figma.com/design/roles-v4'
const LOCAL = '/d/attachments/slack/清单.xlsx'
const MSG: ImMessage = {
  id: 'msg_1', channel: 'slack', connector_id: '', external_id: 'x', conversation_id: 'cv_prod', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin', identity_id: null, stakeholder_id: null, contact_name: '',
  text: '', relevance: '', status: 'pending', read: false, snooze_until: null, at: '2026-10-29T01:00:00Z', received_at: '2026-10-29T01:00:00Z',
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0,
  attachments: [{ id: 'a1', name: '清单.xlsx', kind: 'file', size: 2048, fetch: 'idle' }, { id: 'a2', name: 'Figma', kind: 'link', url: LINK }],
}
const PROJECTS = [
  { id: 'obj_a', type_id: 'project', title: '甲项目', props: {}, deleted_at: null },
  { id: 'obj_b', type_id: 'project', title: '乙项目', props: {}, deleted_at: null },
]

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: Array.isArray(data) ? data.length : 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    const p = decodeURIComponent(u.pathname)
    calls.push({ method, path: p, body })
    if (p === '/api/plugins') return json([{ id: 'im', running: true }, { id: 'projects', running: projectsRunning }])
    if (p === '/api/objects') return json(PROJECTS)
    if (p.startsWith('/api/objects/')) return json({ ...PROJECTS[0], props: {} })
    let m = p.match(/^\/api\/projects\/(obj_\w)\/conversations$/)
    if (m) return json(m[1] === 'obj_b' ? [{ project_id: 'obj_b', conversation_id: 'cv_prod', conversation: {}, created_at: '' }] : [])
    m = p.match(/^\/api\/projects\/(obj_\w)\/materials$/)
    if (m && method === 'GET') return json(mats[m[1]] ?? [])
    if (m && method === 'POST') {
      const row = { id: 'mt', kind: String(body!.kind), value: String(body!.value) }
      mats[m[1]] = [...(mats[m[1]] ?? []), row]
      return json(row, 201)
    }
    if (p === '/api/im/messages/msg_1/attachments/a1/fetch') {
      if (fetchFails) return json({ error: { code: 'conflict', reason: 'no_storage', message: '没接数据目录，取不到附件' } }, 409)
      return json({ ...MSG, attachments: [{ ...MSG.attachments[0], fetch: 'done', local: LOCAL, download_url: '/api/im/attachments/slack/x' }, MSG.attachments[1]] })
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }))
}

function renderPanel(msg = MSG) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><AttachmentPanel msg={msg} /></QueryClientProvider>)
}
const rowOf = (name: string) => screen.getByText(name).closest('.im-att-row') as HTMLElement

beforeEach(() => {
  calls = []
  projectsRunning = true
  mats = {}
  fetchFails = false
  fakeBackend()
})
afterEach(() => vi.unstubAllGlobals())

describe('附件面板', () => {
  it('标题带个数；没获取的显示种类大小，按钮是获取和获取并加入；默认选消息所在的项目', async () => {
    renderPanel()
    expect(screen.getByText('附件 2')).toBeInTheDocument()
    expect(within(rowOf('清单.xlsx')).getByText('文件 · 2 KB · 还在平台上，没下载')).toBeInTheDocument()
    expect(within(rowOf('清单.xlsx')).getByRole('button', { name: '获取' })).toBeInTheDocument()
    expect(within(rowOf('Figma')).queryByRole('button', { name: '获取' })).not.toBeInTheDocument()
    await waitFor(() => expect(within(rowOf('Figma')).getByRole('button', { name: '加入资料' })).toBeEnabled())
    expect(within(rowOf('Figma')).getByRole('button', { name: '加进哪个项目的支持材料' })).toHaveTextContent('乙项目')
  })

  it('链接一键加进资料，加完显示已在哪个项目里，默认改选还没加过的', async () => {
    const user = userEvent.setup()
    renderPanel()
    const add = within(rowOf('Figma')).getByRole('button', { name: '加入资料' })
    await waitFor(() => expect(add).toBeEnabled())
    await user.click(add)
    await waitFor(() => expect(mats.obj_b).toEqual([{ id: 'mt', kind: 'link', value: LINK }]))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'link', value: LINK, name: 'Figma', tags: ['消息附件'] })
    expect(await within(rowOf('Figma')).findByText('已在 乙项目 的支持材料里')).toBeInTheDocument()
    expect(within(rowOf('Figma')).getByRole('button', { name: '加进哪个项目的支持材料' })).toHaveTextContent('甲项目')
  })

  it('文件获取并加入：先获取，value 是本地路径', async () => {
    const user = userEvent.setup()
    renderPanel()
    const add = within(rowOf('清单.xlsx')).getByRole('button', { name: '获取并加入' })
    await waitFor(() => expect(add).toBeEnabled())
    expect(add).toHaveAttribute('title', '会先获取到本地再加入')
    await user.click(add)
    await waitFor(() => expect(mats.obj_b?.[0]?.value).toBe(LOCAL))
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    // 加上后记出处（0009）：kind=attachment，带附件 id
    expect(posts).toEqual(['/api/im/messages/msg_1/attachments/a1/fetch', '/api/projects/obj_b/materials', '/api/im/materials'])
    expect(calls.find((c) => c.path === '/api/im/materials')?.body).toMatchObject({ project_id: 'obj_b', message_ids: ['msg_1'], kind: 'attachment', attachment_id: 'a1' })
  })

  it('获取被拦时显示原因、标红，不加', async () => {
    const user = userEvent.setup()
    fetchFails = true
    renderPanel()
    await user.click(within(rowOf('清单.xlsx')).getByRole('button', { name: '获取' }))
    expect(await within(rowOf('清单.xlsx')).findByText('没接数据目录，取不到附件')).toBeInTheDocument()
    expect(rowOf('清单.xlsx')).toHaveClass('im-att-bad')
  })

  it('项目插件没在跑时不能选项目、不能加，只能获取', async () => {
    projectsRunning = false
    renderPanel()
    await waitFor(() => expect(calls.some((c) => c.path === '/api/plugins')).toBe(true))
    await waitFor(() => expect(within(rowOf('Figma')).getByRole('button', { name: '加进哪个项目的支持材料' })).toBeDisabled())
    expect(within(rowOf('Figma')).getByRole('button', { name: '加入资料' })).toBeDisabled()
    expect(calls.some((c) => c.path === '/api/objects')).toBe(false)
  })
})
