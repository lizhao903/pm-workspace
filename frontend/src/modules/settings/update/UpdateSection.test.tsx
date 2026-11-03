// 版本更新（SYS-UPD）：显示正在跑和源码目录的版本、新提交；点更新先确认，进度轮询，重启后新进程起来自动刷新；失败写清楚、旧版本不动
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateJob, UpdateStatus } from '../../../core/data'
import { UpdateSection } from './UpdateSection'

const base: UpdateStatus = {
  running: { version: 'dev', commit: '8d9ff0cd7c464b52', modified: true, commit_at: '2026-10-31T15:27:43Z', binary: '/repo/bin/pmw-dev' },
  source: {
    repo: '/repo', branch: 'main', head: { sha: '440999e0000', subject: 'chore: 工作台 MCP 指向 7796', at: '2026-11-03T01:00:00Z' }, dirty: 3,
    ahead: [{ sha: '440999e0000', subject: 'chore: 工作台 MCP 指向 7796', at: '2026-11-03T01:00:00Z' }, { sha: '3fb77ce0000', subject: 'chore(release): 版本号升到 0.2.0', at: '2026-11-02T01:00:00Z' }],
    ahead_total: 2, diverged: false,
  },
  available: true,
  job: null,
}
const steps = (states: string[]): UpdateJob['steps'] =>
  ['备份数据库', '构建前端', '构建后端和 MCP', '自检新版本', '替换并重启'].map((label, i) => ({ key: `s${i}`, label, state: states[i] as UpdateJob['steps'][0]['state'] }))

/** 按顺序回状态；'down' 表示这次请求失败（重启中） */
function backend(seq: (UpdateStatus | 'down')[], onStart?: () => UpdateStatus) {
  let i = 0
  const posts: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/admin/update') && init?.method === 'POST') {
      posts.push(1)
      return new Response(JSON.stringify({ data: onStart!() }), { status: 202 })
    }
    if (url.endsWith('/api/admin/update')) {
      const s = seq[Math.min(i++, seq.length - 1)]
      if (s === 'down') throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ data: s }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }))
  return posts
}

function mount(reload = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><UpdateSection reload={reload} /></QueryClientProvider>)
  return reload
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('版本更新', () => {
  it('显示正在跑的版本、源码目录和新提交；已经是最新时按钮置灰', async () => {
    backend([base])
    mount()
    const run = await screen.findByRole('region', { name: '正在运行' })
    expect(run).toHaveTextContent('8d9ff0c')
    expect(run).toHaveTextContent('编译时带未提交改动')
    const src = screen.getByRole('region', { name: '源码目录' })
    expect(src).toHaveTextContent('440999e')
    expect(src).toHaveTextContent('3 个文件有未提交的改动')
    expect(within(screen.getByRole('region', { name: '新提交' })).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '更新到最新版本' })).toBeEnabled()
  })

  it('不能更新时写原因，按钮置灰；已经是最新写「已经是最新版本」', async () => {
    backend([{ ...base, available: false, source: { ...base.source!, ahead: [], ahead_total: 0, dirty: 0 } }])
    mount()
    expect(await screen.findByText('已经是最新版本')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新到最新版本' })).toBeDisabled()
  })

  it('点更新先确认；进度走完、重启时请求失败照样等，新进程起来后自动刷新', async () => {
    const running = { ...base, job: { state: 'running', steps: steps(['done', 'running', 'pending', 'pending', 'pending']), log: '$ make frontend\n', started_at: '' } } as UpdateStatus
    const restarting = { ...base, job: { state: 'restarting', steps: steps(['done', 'done', 'done', 'done', 'running']), log: '', started_at: '' } } as UpdateStatus
    const fresh = { ...base, running: { ...base.running, commit: '440999e0000', modified: true }, available: true, job: null }
    const posts = backend([base, running, restarting, 'down', 'down', fresh], () => running)
    const reload = mount()
    await userEvent.click(await screen.findByRole('button', { name: '更新到最新版本' }))
    const dlg = screen.getByRole('alertdialog')
    expect(dlg).toHaveTextContent('先备份数据库')
    expect(dlg).toHaveTextContent('含 3 个文件的未提交改动')
    await userEvent.click(within(dlg).getByRole('button', { name: '开始更新' }))
    expect(posts).toHaveLength(1)
    const prog = await screen.findByRole('region', { name: '更新进度' })
    expect(within(prog).getByText('构建前端').parentElement).toHaveClass('up-running')
    await screen.findByText(/工作台正在重启/, {}, { timeout: 5000 })
    await screen.findByText(/已更新到 440999e/, {}, { timeout: 10000 })
    await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 4000 })
  }, 20000)

  it('失败写清哪一步，旧版本没动，能看日志', async () => {
    const failed = { ...base, job: { state: 'failed', steps: steps(['done', 'failed', 'pending', 'pending', 'pending']), error: 'make frontend 失败：exit status 2', log: 'npm ERR! 构建失败\n', started_at: '' } } as UpdateStatus
    backend([failed])
    const reload = mount()
    expect(await screen.findByRole('alert')).toHaveTextContent('更新没成：make frontend 失败：exit status 2。正在跑的旧版本没有动。')
    await userEvent.click(screen.getByRole('button', { name: '查看构建日志' }))
    expect(screen.getByLabelText('构建日志')).toHaveTextContent('npm ERR! 构建失败')
    expect(screen.getByRole('button', { name: '重新更新' })).toBeEnabled()
    expect(reload).not.toHaveBeenCalled()
  })
})
