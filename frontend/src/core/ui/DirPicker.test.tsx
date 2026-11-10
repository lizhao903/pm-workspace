// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fsCrumbs } from '../data'
import { DirPicker } from './DirPicker'

const tree: Record<string, string[]> = {
  '/Users/me': ['code', 'Desktop'],
  '/Volumes': ['project', 'docs'],
  '/Volumes/project': ['app'],
  '/Volumes/project/app': [],
}
const rootOf = (p: string) => (p.startsWith('/Volumes') ? '/Volumes' : '/Users/me')
const parentOf = (p: string) => (p === rootOf(p) ? '' : p.slice(0, p.lastIndexOf('/')))

function fakeBackend() {
  const browsed: string[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname === '/api/fs/shortcuts') {
      return json([
        { label: '主目录', path: '/Users/me' },
        { label: '外挂分区：project', path: '/Volumes/project' },
        { label: '外挂分区：docs', path: '/Volumes/docs' },
        { label: '/Volumes（全部分区）', path: '/Volumes' },
      ])
    }
    if (u.pathname === '/api/fs/browse') {
      const p = u.searchParams.get('path') || '/Users/me'
      browsed.push(p)
      if (!tree[p]) return json({ error: { code: 'validation', message: `${p} 不在可浏览范围内。请在「设置 - 本机目录」里把它加为可浏览目录。` } }, 400)
      return json({ path: p, parent: parentOf(p), root: rootOf(p), writable: true, entries: tree[p].map((n) => ({ name: n, path: `${p}/${n}`, is_dir: true, writable: true })) })
    }
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { browsed }
}

function renderPicker(start = '') {
  const onPick = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><DirPicker start={start} onPick={onPick} onClose={() => {}} /></QueryClientProvider>)
  return { onPick }
}

describe('选目录（FS-01）', () => {
  beforeEach(() => { fakeBackend() })
  afterEach(() => vi.unstubAllGlobals())

  it('侧边起跳点列出外挂分区，点了直接进', async () => {
    const { onPick } = renderPicker()
    const side = await screen.findByRole('list', { name: '起跳点' })
    await userEvent.click(within(side).getByRole('button', { name: '外挂分区：project' }))
    const subs = screen.getByRole('list', { name: '子目录' })
    await within(subs).findByRole('button', { name: 'app' })
    await userEvent.click(screen.getByRole('button', { name: '选这个目录' }))
    expect(onPick).toHaveBeenCalledWith('/Volumes/project')
  })

  it('输入路径回车跳转，面包屑能回到 /Volumes', async () => {
    renderPicker()
    const input = await screen.findByRole('textbox', { name: '目录路径' })
    await waitFor(() => expect(input).toHaveValue('/Users/me'))
    await userEvent.clear(input)
    await userEvent.type(input, '/Volumes/project/app{Enter}')
    const crumbs = screen.getByLabelText('所在位置')
    await within(crumbs).findByText('app')
    expect(input).toHaveValue('/Volumes/project/app')
    await userEvent.click(within(crumbs).getByRole('button', { name: '/Volumes' }))
    await within(screen.getByRole('list', { name: '子目录' })).findByRole('button', { name: 'docs' })
  })

  it('越界时显示后端的中文原因，起跳点还能用', async () => {
    renderPicker()
    const input = await screen.findByRole('textbox', { name: '目录路径' })
    await userEvent.clear(input)
    await userEvent.type(input, '/opt/data{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('不在可浏览范围内')
    expect(screen.getByRole('button', { name: '选这个目录' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '主目录' }))
    await within(await screen.findByRole('list', { name: '子目录' })).findByRole('button', { name: 'code' })
  })
})

describe('fsCrumbs', () => {
  it('从根一段段到当前目录', () => {
    expect(fsCrumbs('/Volumes/project/app', '/Volumes')).toEqual([
      { label: '/Volumes', path: '/Volumes' },
      { label: 'project', path: '/Volumes/project' },
      { label: 'app', path: '/Volumes/project/app' },
    ])
    expect(fsCrumbs('/Volumes', '/Volumes')).toEqual([{ label: '/Volumes', path: '/Volumes' }])
  })
  it('不在根里或没有根时只给自己；同前缀的兄弟不算在根里', () => {
    expect(fsCrumbs('/opt/x', '')).toEqual([{ label: '/opt/x', path: '/opt/x' }])
    expect(fsCrumbs('/Users/meee/a', '/Users/me')).toEqual([{ label: '/Users/meee/a', path: '/Users/meee/a' }])
  })
})
