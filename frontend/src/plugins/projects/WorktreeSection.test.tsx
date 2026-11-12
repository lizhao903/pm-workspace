// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkObject } from '../../core/data'
import { durationText, portRangeError, testShotUrl, testSummary, worktreeState, type TestRun, type TestStep, type Worktree } from '../../core/data'
import WorktreeSection from './WorktreeSection'

// 任务详情「工作区」（AUTO-07）：在用的显示目录、分支、端口；清理有改动被拒后换成强制清理；没有时按项目代码库给「准备工作区」
const wt = (over: Partial<Worktree> = {}): Worktree => ({
  id: 'wt_1', task_id: 'obj_t', task_ref: 'TSK-1', project_id: 'obj_p', repo_dir: '/src/app', sub_dir: '', root: '/data/worktrees/obj_p/TSK-1',
  path: '/data/worktrees/obj_p/TSK-1', branch: 'auto/TSK-1', base_commit: 'abcdef1234', port_start: 7900, port_end: 7909, port_count: 10,
  status: 'active', last_error: '', removed_reason: '', branch_deleted: false, exists: true, created_at: '', updated_at: '', removed_at: null, ...over,
})

const step = (over: Partial<TestStep> = {}): TestStep => ({
  key: 'test', label: '测试', command: 'go test ./...', dir: '/data/worktrees/obj_p/TSK-1', status: 'passed', exit_code: 0, duration_ms: 1500,
  timed_out: false, output: 'ok', error: '', started_at: '2026-11-04T10:00:00Z', finished_at: '2026-11-04T10:00:02Z', ...over,
})
const tr = (over: Partial<TestRun> = {}): TestRun => ({
  id: 'tr_1', task_id: 'obj_t', task_ref: 'TSK-1', project_id: 'obj_p', worktree_id: 'wt_1', workdir: '/data/worktrees/obj_p/TSK-1', port: 7900,
  port_start: 7900, port_end: 7909, url: '', status: 'passed', steps: [step()], failed_step: '', error: '', run_dir: '/data/test-reports/x',
  report_path: '/data/test-reports/x/report.md', artifact_ids: ['art_1'], shots: [], junit: null, source: 'api', sop_run_id: '',
  started_at: '2026-11-04T10:00:00Z', finished_at: '2026-11-04T10:00:02Z', updated_at: '',
  env_state: '', env_keep_until: null, env_released_at: null, env_release_reason: '', ...over,
})

type Backend = { rows: Worktree[]; codeDir?: string; tests?: TestRun[]; commands?: Record<string, unknown> }

function fakeBackend(rows: Worktree[], codeDir = '/src/app', more: Omit<Backend, 'rows' | 'codeDir'> = {}) {
  let tests = more.tests ?? []
  const calls: { method: string; path: string; body?: unknown }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/projects/worktrees' && method === 'GET') return json(rows)
    if (u.pathname === '/api/projects/worktrees' && method === 'POST') {
      rows = [wt()]
      return json(rows[0], 201)
    }
    if (u.pathname === '/api/projects/worktrees/wt_1/cleanup') {
      if (!body?.force) {
        rows = [wt({ last_error: '工作区里有没提交的改动，没有删' })]
        return json({ error: { code: 'conflict', message: '工作区里有没提交的改动，没有删' } }, 409)
      }
      rows = [wt({ status: 'removed', removed_reason: 'manual', branch_deleted: true })]
      return json(rows[0])
    }
    if (u.pathname === '/api/projects/tests' && method === 'GET') return json(tests)
    if (u.pathname === '/api/projects/tests' && method === 'POST') {
      tests = [tr({ id: 'tr_2', status: 'running', report_path: '', url: 'http://127.0.0.1:7900',
        steps: [step({ key: 'build', label: '构建', status: 'running', exit_code: null, finished_at: null })] }), ...tests]
      return json(tests[0], 202)
    }
    if (u.pathname === '/api/projects/tests/runs/tr_2/stop') {
      tests = [tr({ id: 'tr_2', status: 'stopped', error: '手动停止', steps: [step({ key: 'build', label: '构建', status: 'stopped', exit_code: null, error: '手动停止' })] })]
      return json(tests[0])
    }
    if (u.pathname === '/api/projects/tests/runs/tr_1/release') {
      tests = tests.map((x) => (x.id === 'tr_1' ? { ...x, env_state: 'released', env_release_reason: 'manual', env_released_at: '2026-11-04T11:00:00Z' } : x))
      return json(tests[0])
    }
    if (u.pathname === '/api/projects/obj_p/profile') {
      return json({ project_id: 'obj_p', intro: '', keywords: [], platforms: [], code_dir: codeDir, proto_dir: '', prd_dir: '', commands: more.commands ?? {},
        owner_ids: [], acceptor_ids: [], root: '', created_at: null, updated_at: null })
    }
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

const task = { id: 'obj_t', type_id: 'task', project_id: 'obj_p', title: '任务' } as unknown as WorkObject

function mount(object: WorkObject = task) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><WorktreeSection object={object} /></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('任务详情的工作区', () => {
  it('在用的工作区：目录、分支、端口；清理遇到改动被拒后换成强制清理', async () => {
    const calls = fakeBackend([wt()])
    mount()
    const sec = await screen.findByRole('region', { name: '工作区' })
    expect(within(sec).getByText('/data/worktrees/obj_p/TSK-1')).toBeInTheDocument()
    expect(within(sec).getByText('auto/TSK-1')).toBeInTheDocument()
    expect(within(sec).getByText(/从 abcdef1 拉出/)).toBeInTheDocument()
    expect(within(sec).getByText(/7900–7909/)).toBeInTheDocument()
    await userEvent.click(within(sec).getByRole('button', { name: '清理工作区' }))
    await userEvent.click(screen.getByRole('button', { name: '清理' }))
    await screen.findByText(/清理没成功：工作区里有没提交的改动/, { selector: '.wt-err' })
    await userEvent.click(await screen.findByRole('button', { name: '强制清理' }))
    const dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByText(/没提交的改动会丢掉/)).toBeInTheDocument()
    await userEvent.click(within(dlg).getByRole('button', { name: '强制清理' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/cleanup') && (c.body as { force: boolean }).force)).toBe(true))
    await screen.findByText('手动清理，分支已合并、一起删了')
  })

  it('没有工作区、项目设了代码库：给「准备工作区」', async () => {
    const calls = fakeBackend([])
    mount()
    await screen.findByText('/src/app')
    await userEvent.click(screen.getByRole('button', { name: '准备工作区' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/worktrees')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ task_id: 'obj_t' })
    await screen.findByText('auto/TSK-1')
  })

  it('没挂项目又没有工作区：整块不显示', async () => {
    const calls = fakeBackend([])
    const { container } = mount({ ...task, project_id: null } as WorkObject)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    expect(container).toBeEmptyDOMElement()
  })
})

describe('最近一次测试', () => {
  it('没跑过、档案有命令：运行测试，跑着时显示在哪一步、测试环境地址和停止；停了显示原因', async () => {
    const calls = fakeBackend([wt()], '/src/app', { commands: { test: { command: 'go test ./...', dir: '', timeout_sec: 0 } } })
    mount()
    const grp = await screen.findByRole('group', { name: '最近一次测试' })
    await within(grp).findByText(/还没跑过/)
    await userEvent.click(within(grp).getByRole('button', { name: '运行测试' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/tests')).toBe(true))
    expect(calls.find((c) => c.path === '/api/projects/tests' && c.method === 'POST')?.body).toEqual({ task_id: 'obj_t' })
    await within(grp).findByText('正在构建')
    expect(within(grp).getByRole('link', { name: 'http://127.0.0.1:7900' })).toBeInTheDocument()
    expect(within(grp).queryByRole('button', { name: /运行测试|再跑一次/ })).toBeNull()
    await userEvent.click(within(grp).getByRole('button', { name: '停止' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/projects/tests/runs/tr_2/stop')).toBe(true))
    await within(grp).findByText('已停止', { selector: '.wtt-badge' })
    expect(within(grp).getAllByText('手动停止').length).toBeGreaterThan(0)
  })

  it('没通过：红字原因、各步退出码和用时、报告链接、截图、没通过的用例', async () => {
    fakeBackend([wt()], '/src/app', {
      commands: { test: { command: 'go test ./...', dir: '', timeout_sec: 0 } },
      tests: [tr({
        status: 'failed', failed_step: 'test', error: '测试：退出码 1', shots: ['shots/home.png'],
        junit: { files: 1, tests: 3, failures: 1, errors: 0, skipped: 0, failed: ['a › 登录'] },
        steps: [step({ key: 'build', label: '构建' }), step({ status: 'failed', exit_code: 1, error: '退出码 1', output: 'FAIL x' }),
          step({ key: 'smoke', label: '冒烟', status: 'skipped', exit_code: null, started_at: null, finished_at: null, duration_ms: 0, output: '' })],
      })],
    })
    mount()
    const grp = await screen.findByRole('group', { name: '最近一次测试' })
    await within(grp).findByText('测试：退出码 1，3 个用例、1 个没通过')
    expect(within(grp).getByText('没通过', { selector: '.wtt-badge' })).toBeInTheDocument()
    expect(within(grp).getByText('跳过')).toBeInTheDocument()
    expect(within(grp).getByText('退出码 1，1.5 秒')).toBeInTheDocument()
    expect(within(grp).getByRole('link', { name: '看报告' })).toHaveAttribute('href', '/api/projects/tests/runs/tr_1/report')
    expect(within(grp).getByRole('link', { name: 'shots/home.png' })).toHaveAttribute('href', '/api/projects/tests/runs/tr_1/shots/shots/home.png')
    expect(within(grp).getByText('a › 登录')).toBeInTheDocument()
    expect(within(grp).getByRole('button', { name: '再跑一次' })).toBeInTheDocument()
    expect(within(grp).getByText('FAIL x')).toBeInTheDocument()
  })

  it('保留给人工验收的测试环境：保留到几点、可点开、能手动回收；回收后写原因', async () => {
    const calls = fakeBackend([wt()], '/src/app', {
      commands: { test: { command: 'go test ./...', dir: '', timeout_sec: 0 } },
      tests: [tr({ url: 'http://127.0.0.1:7900', source: 'sop', env_state: 'kept', env_keep_until: '2026-11-05T10:00:00Z' })],
    })
    mount()
    const env = await screen.findByRole('status', { name: '保留的测试环境' })
    const until = new Date('2026-11-05T10:00:00Z').toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    expect(within(env).getByText(`测试环境保留到 ${until}，可访问：`, { exact: false })).toBeInTheDocument()
    expect(within(env).getByRole('link', { name: 'http://127.0.0.1:7900' })).toHaveAttribute('href', 'http://127.0.0.1:7900')
    await userEvent.click(within(env).getByRole('button', { name: '回收' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/tests/runs/tr_1/release')).toBe(true))
    await screen.findByText('（已回收：手动回收）', { exact: false })
    expect(screen.queryByRole('status', { name: '保留的测试环境' })).toBeNull()
  })

  it('档案里没有测试命令：不给按钮，提示去档案里填', async () => {
    fakeBackend([wt()])
    mount()
    const grp = await screen.findByRole('group', { name: '最近一次测试' })
    await within(grp).findByText(/项目档案里还没填/)
    expect(within(grp).queryByRole('button')).toBeNull()
  })

  it('纯函数：一句话、用时、截图地址', () => {
    expect(testSummary(tr())).toBe('全部通过')
    expect(testSummary(tr({ status: 'running', steps: [step({ status: 'running', label: '起测试环境' })] }))).toBe('正在起测试环境')
    expect(testSummary(tr({ status: 'interrupted', error: '工作台重启过' }))).toBe('工作台重启过')
    expect(durationText(800)).toBe('800 毫秒')
    expect(durationText(61_500)).toBe('1 分 1 秒')
    expect(testShotUrl('tr_1', 'a b/c.png')).toBe('/api/projects/tests/runs/tr_1/shots/a%20b/c.png')
  })
})

describe('工作区的纯函数', () => {
  it('状态说明', () => {
    expect(worktreeState(wt())).toEqual({ tone: 'ok', text: '在用' })
    expect(worktreeState(wt({ last_error: '有改动' })).tone).toBe('warn')
    expect(worktreeState(wt({ exists: false })).text).toMatch(/目录不在了/)
    expect(worktreeState(wt({ status: 'removed', removed_reason: 'released' })).text).toBe('上线后自动清理，分支保留')
  })
  it('端口范围检查', () => {
    const r = [7700, 7899] as const
    expect(portRangeError(7900, 8899, 10, r)).toBeUndefined()
    expect(portRangeError(7800, 8899, 10, r)).toMatch(/重叠/)
    expect(portRangeError(9000, 9003, 5, r)).toMatch(/放不下/)
    expect(portRangeError(80, 9000, 10, r)).toMatch(/1024/)
    expect(portRangeError(9000, 9100, 0, r)).toMatch(/每段/)
  })
})
