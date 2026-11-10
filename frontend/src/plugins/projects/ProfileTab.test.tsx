// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileTab } from './ProfileTab'

// 档案标签（AUTO-04）：边改边存，目录单独存、存不上只在那一项下面说
const contacts = [
  { id: 'sh_1', name: '赵六', company: '', title: '', group: '', tags: [], photo: '' },
  { id: 'sh_2', name: '吴九', company: '', title: '', group: '', tags: [], photo: '' },
]

function fakeBackend() {
  const patches: Record<string, unknown>[] = []
  let profile: Record<string, unknown> = {
    project_id: 'obj_p', intro: '旧简介', keywords: ['工作台'], platforms: ['web'], code_dir: '', proto_dir: '', prd_dir: '',
    commands: {}, owner_ids: [], acceptor_ids: [], root: '/src/p', created_at: null, updated_at: null,
  }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (u.pathname === '/api/projects/obj_p/profile') {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>
        patches.push(body)
        if (typeof body.proto_dir === 'string' && body.proto_dir.includes('nope')) {
          return json({ error: { code: 'validation', message: `directory ${body.proto_dir} does not exist` } }, 400)
        }
        profile = { ...profile, ...body }
      }
      return json(profile)
    }
    if (u.pathname === '/api/stakeholders') return json(contacts)
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return patches
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // 末尾的「原型同步」块（AUTO-11）里有去 SOP 执行页的链接，要在路由里
  return render(<MemoryRouter><QueryClientProvider client={qc}><ProfileTab projectId="obj_p" /></QueryClientProvider></MemoryRouter>)
}

afterEach(() => vi.unstubAllGlobals())

describe('档案标签', () => {
  it('读出已有档案；改简介、关键词停手后合成一次存', async () => {
    const patches = fakeBackend()
    mount()
    const intro = await screen.findByDisplayValue('旧简介')
    expect(screen.getByRole('button', { name: 'web' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/不填时沿用项目目录 \/src\/p/)).toBeInTheDocument()
    await userEvent.clear(intro)
    await userEvent.type(intro, '新简介')
    const kw = screen.getByPlaceholderText('工作台，需求管理，原型')
    await userEvent.type(kw, '，原型')
    await waitFor(() => expect(patches.at(-1)).toEqual({ intro: '新简介', keywords: ['工作台', '原型'] }), { timeout: 2000 })
    await screen.findByText('已保存')
  })

  it('点平台立即存；命令超时填错时提示且先不存命令', async () => {
    const patches = fakeBackend()
    mount()
    await screen.findByDisplayValue('旧简介')
    await userEvent.click(screen.getByRole('button', { name: '桌面' }))
    await waitFor(() => expect(patches.at(-1)).toEqual({ platforms: ['web', '桌面'] }))
    await userEvent.type(screen.getByRole('textbox', { name: '构建命令' }), 'make build')
    await userEvent.type(screen.getByRole('textbox', { name: '构建超时' }), 'x')
    expect(await screen.findByText(/超时填整数秒/)).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 700))
    expect(patches.some((p) => 'commands' in p)).toBe(false)
    await userEvent.clear(screen.getByRole('textbox', { name: '构建超时' }))
    await userEvent.type(screen.getByRole('textbox', { name: '构建超时' }), '600')
    await waitFor(() => expect(patches.at(-1)).toEqual({ commands: { build: { command: 'make build', dir: '', timeout_sec: 600 } } }), { timeout: 2000 })
  })

  it('目录单独存：不存在的目录只在那一项下面报错，别的照存', async () => {
    const patches = fakeBackend()
    mount()
    await screen.findByDisplayValue('旧简介')
    await userEvent.type(screen.getByRole('textbox', { name: '原型库目录' }), '/nope')
    await userEvent.type(screen.getByRole('textbox', { name: '代码库目录' }), '/src/code')
    await waitFor(() => expect(patches).toContainEqual({ code_dir: '/src/code' }), { timeout: 2000 })
    expect(patches).toContainEqual({ proto_dir: '/nope' })
    const field = screen.getByRole('textbox', { name: '原型库目录' }).closest('.field') as HTMLElement
    expect(await within(field).findByRole('alert')).toHaveTextContent('/nope does not exist')
    expect(within(screen.getByRole('textbox', { name: '代码库目录' }).closest('.field') as HTMLElement).queryByRole('alert')).toBeNull()
  })

  it('挑负责人立即存', async () => {
    const patches = fakeBackend()
    mount()
    await screen.findByDisplayValue('旧简介')
    await userEvent.click(screen.getByRole('button', { name: '负责人' }))
    await userEvent.click(within(screen.getByRole('listbox')).getByText('赵六'))
    await waitFor(() => expect(patches.at(-1)).toEqual({ owner_ids: ['sh_1'] }))
  })
})
