import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, WorkObject } from '../../core/data'
import { ArtifactsPanel } from './ArtifactsPanel'

const at = new Date().toISOString()
function art(p: Partial<Artifact>): Artifact {
  return {
    id: 'art_' + Math.random().toString(36).slice(2), object_id: 'obj_1', session_id: null, run_id: null, title: '', path: '',
    base_dir: '', url: '', platform: '', size: 0, source: 'mcp', note: '', created_at: at, updated_at: at, rel_path: '', kind: '', display_kind: 'other', ...p,
  }
}
const task = { id: 'obj_1', ref: 'TSK-0001', title: '任务' } as WorkObject

// 打桩 fetch：GET 回列表，POST 记下请求体并回一条 manual
function stub(rows: Artifact[]) {
  const posts: { body: Record<string, unknown>; headers: Headers }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ body, headers: new Headers(init.headers) })
      const created = art({ ...(body as Partial<Artifact>), id: 'art_new', source: 'manual', rel_path: String(body.path ?? '') })
      rows = [created, ...rows]
      return new Response(JSON.stringify({ data: created }), { status: 201 })
    }
    expect(url).toContain('object_id=obj_1')
    return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return posts
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ArtifactsPanel task={task} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('产出物面板', () => {
  it('按提交、分支、PR、文件分组；提交显示 7 位 sha 和分支；有链接的新窗口打开，只有路径的显示相对路径', async () => {
    stub([
      art({ title: '方案', path: '/repo/docs/a.md', base_dir: '/repo', rel_path: 'docs/a.md', note: 'v2', source: 'run' }),
      art({ title: 'PR https://github.com/a/b/pull/1', url: 'https://github.com/a/b/pull/1', note: '[pr] branch=feat/x' }),
      art({ title: 'branch feat/x', path: '/repo', rel_path: '/repo', note: '[branch] branch=feat/x repo=/repo' }),
      art({ title: 'commit a1b2c3d4e5', url: 'https://github.com/a/b/commit/a1b2c3d4e5f6', note: '[commit] sha=a1b2c3d4e5f6 branch=feat/x 修排序' }),
    ])
    renderPanel()
    const commit = await screen.findByRole('group', { name: '提交' })
    const names = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(names).toEqual(['提交', '分支', 'PR', '文件'])

    expect(within(commit).getByText('a1b2c3d')).toBeInTheDocument()
    expect(within(commit).getByText('feat/x')).toBeInTheDocument()
    const link = within(commit).getByRole('link', { name: '修排序' })
    expect(link).toHaveAttribute('href', 'https://github.com/a/b/commit/a1b2c3d4e5f6')
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(commit).getByText('MCP 回写')).toBeInTheDocument()

    const file = screen.getByRole('group', { name: '文件' })
    expect(within(file).getByText('docs/a.md')).toHaveAttribute('title', '/repo/docs/a.md')
    expect(within(file).queryByRole('link')).toBeNull()
    expect(within(file).getByRole('button', { name: '复制路径' })).toBeInTheDocument()
    expect(within(file).getByText('执行扫描')).toBeInTheDocument()
  })

  it('没有产出物时显示空状态', async () => {
    stub([])
    renderPanel()
    expect(await screen.findByText('还没有产出物')).toBeInTheDocument()
  })

  it('手工登记一条：路径不合法不让登记，登记后列表里来源是手动登记', async () => {
    const posts = stub([])
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: '登记产出物' }))
    const loc = screen.getByRole('textbox', { name: '链接或本机绝对路径' })
    await user.type(loc, 'docs/a.md')
    expect(screen.getByText('链接以 http 开头，路径要写绝对路径')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登记' })).toBeDisabled()

    await user.clear(loc)
    await user.type(loc, '/tmp/x/plan.md')
    await user.type(screen.getByRole('textbox', { name: '备注' }), '初稿')
    await user.click(screen.getByRole('button', { name: '登记' }))

    const file = await screen.findByRole('group', { name: '文件' })
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ path: '/tmp/x/plan.md', note: '初稿', object_id: 'obj_1' })
    expect(posts[0].headers.get('X-Actor-Source')).toBe('ui')
    expect(within(file).getByText('手动登记')).toHaveAttribute('data-source', 'manual')
    expect(screen.queryByRole('form', { name: '登记产出物' })).toBeNull()
  })
})
