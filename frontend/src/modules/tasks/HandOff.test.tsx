import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunPermissions, RunPreset, TaskRun, WorkObject } from '../../core/data'
import { terminalLauncherRegistry, terminalLauncherStore, type TerminalLaunchRequest } from '../../core/plugin'
import { HandOffButton } from './HandOff'
import { resetLiveRuns } from './runLive'

const task = { id: 'obj_1', ref: 'TSK-0001', title: '任务' } as WorkObject

// 打桩 fetch：执行记录、目录校验（/ok 开头的可用）、发起执行（回一段 SSE）
function stub(rows: TaskRun[] = [], presets: RunPreset[] = [], perms?: Partial<RunPermissions>) {
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/api/agent/workdir/check')) {
      const { path } = JSON.parse(String(init?.body)) as { path: string }
      const ok = path.startsWith('/ok')
      return json({ path, exists: ok, is_dir: ok, writable: ok, message: ok ? '' : '目录不存在' })
    }
    if (url.endsWith('/api/objects/obj_1/run')) {
      bodies.push(JSON.parse(String(init?.body)))
      const sse = [
        { type: 'start', run_id: 'run_x1', workdir: '/ok/w' },
        { type: 'delta', text: '读完了' },
        { type: 'done', run_id: 'run_x1', exit_code: 0 },
      ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.includes('/api/objects/obj_1/run/prompt')) {
      const q = new URL(url, 'http://x').searchParams
      return json({ prompt: `预览 mode=${q.get('mode')} extra=${q.get('extra_prompt') ?? ''} preset=${q.get('preset_id') ?? ''}`, workdir: q.get('workdir') ?? '' })
    }
    if (url.endsWith('/api/objects/obj_1/run/terminal')) {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ data: {
        run: { id: 'run_t1', object_id: 'obj_1', status: 'running', mode: 'terminal' }, workdir: '/ok/w',
        prompt_file: '/data/tmp/handoff/run_t1/prompt.md', mcp_config: '/data/tmp/handoff/run_t1/mcp.json',
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    const fin = /\/api\/runs\/([^/]+)\/finish$/.exec(url)
    if (fin) {
      bodies.push({ finish: fin[1], ...JSON.parse(String(init?.body)) })
      return json({ id: fin[1], status: 'failed', mode: 'terminal' })
    }
    if (url.endsWith('/api/run-prompts')) return json(presets)
    if (url.endsWith('/api/run-permissions')) return json({ write_profile: 'accept_edits', custom: [], profiles: [], mcp_server: 'pmw-run', ...perms })
    if (url.includes('/api/objects/obj_1/runs')) return json(rows)
    return json([])
  }))
  return bodies
}

function renderButton(workdir = '/ok/w') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<HandOffButton task={task} workdir={workdir} />} />
          <Route path="/terminal" element={<div>终端页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// 终端插件登记的入口：记下请求，fail 时抛错
function fakeLauncher(fail = false) {
  const reqs: TerminalLaunchRequest[] = []
  terminalLauncherRegistry('terminal').register({
    page: '/terminal',
    launch: async (req) => {
      reqs.push(req)
      if (fail) throw new Error('最多同时开 16 个终端')
      return { command: 'gogogo' }
    },
  })
  return reqs
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetLiveRuns()
  terminalLauncherStore.removeOwner('terminal')
})

describe('交给 Claude Code', () => {
  it('允许写入默认不勾；勾选先二次确认，取消后仍是只读，确认后才勾上', async () => {
    stub()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    const box = screen.getByRole('checkbox', { name: '允许写入' })
    expect(box).not.toBeChecked()
    await user.click(box)
    expect(screen.getByRole('alertdialog', { name: '允许写入？' })).toHaveTextContent('acceptEdits')
    await user.click(screen.getByRole('button', { name: '算了，只读' }))
    expect(box).not.toBeChecked()
    await user.click(box)
    await user.click(screen.getByRole('button', { name: '确认允许写入' }))
    expect(box).toBeChecked()
    expect(await screen.findByRole('button', { name: '开始执行（允许写入）' })).toBeEnabled()
  })

  it('目录不存在时不能提交', async () => {
    const bodies = stub()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    const input = screen.getByRole('textbox', { name: '工作目录' })
    await user.clear(input)
    await user.type(input, '/nope')
    expect(await screen.findByText('不可用：目录不存在')).toBeInTheDocument()
    const go = screen.getByRole('button', { name: '开始执行（只读）' })
    expect(go).toBeDisabled()
    await user.click(go)
    expect(bodies).toHaveLength(0)
  })

  it('提交只读执行：请求体只有三个字段，弹窗关闭', async () => {
    const bodies = stub()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.type(screen.getByRole('textbox', { name: '附加说明' }), '只读 a.txt')
    const go = screen.getByRole('button', { name: '开始执行（只读）' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ workdir: '/ok/w', extra_prompt: '只读 a.txt', allow_writes: false, permission: 'read_only' })
    expect(screen.queryByRole('dialog', { name: '交给 Claude Code' })).not.toBeInTheDocument()
  })

  it('角色：打开时选上默认那个、显示内容，允许改文件的角色默认勾上写入，预览和请求都带 preset_id（SPEC-tasks-6.18）', async () => {
    const bodies = stub([], [
      { id: 'rp_pm', scene: '产品经理工作台', content: '请按用户要求输出 PRD 文档，更新产品原型，同步后回复用户消息。', default: true },
      { id: 'rp_dev', scene: '研发开发', content: '按验收标准改代码。', default: false },
    ])
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    const sel = screen.getByRole('combobox', { name: '角色' })
    await waitFor(() => expect(sel).toHaveValue('rp_pm'))
    expect(screen.getByText('请按用户要求输出 PRD 文档，更新产品原型，同步后回复用户消息。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '管理角色' })).toHaveAttribute('href', '/settings/run-prompts')
    expect(screen.getByRole('checkbox', { name: '允许写入' })).toBeChecked()
    expect(screen.getByText(/按角色「产品经理工作台」/)).toBeInTheDocument()
    await user.click(screen.getByText('提示词预览'))
    expect(await screen.findByLabelText('提示词预览')).toHaveTextContent('preset=rp_pm')
    const go = screen.getByRole('button', { name: '开始执行（允许写入）' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ workdir: '/ok/w', extra_prompt: '', allow_writes: true, permission: 'accept_edits', preset_id: 'rp_pm' })
  })

  it('只读角色锁成只读，显示输出要求；换回允许改文件的角色又勾上（AUTO-03）', async () => {
    const bodies = stub([], [
      { id: 'rp_pm', scene: '产品经理工作台', content: '出 PRD', default: true, permission: 'accept_edits' },
      { id: 'rp_review', scene: '研发评审', content: '只读评审', default: false, permission: 'read_only', output: '回报 verdict 和 issues' },
    ])
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    const sel = screen.getByRole('combobox', { name: '角色' })
    await waitFor(() => expect(sel).toHaveValue('rp_pm'))
    expect(screen.getByRole('option', { name: '研发评审（只读）' })).toBeInTheDocument()
    const box = screen.getByRole('checkbox', { name: '允许写入' })
    await user.click(box)
    expect(box).not.toBeChecked()
    await user.selectOptions(sel, 'rp_review')
    expect(box).not.toBeChecked()
    expect(box).toBeDisabled()
    expect(screen.getByText('输出要求：回报 verdict 和 issues')).toBeInTheDocument()
    expect(screen.getByText(/角色「研发评审」只读/)).toBeInTheDocument()
    await user.selectOptions(sel, 'rp_pm')
    expect(box).toBeChecked()
    await user.selectOptions(sel, 'rp_review')
    const go = screen.getByRole('button', { name: '开始执行（只读）' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ workdir: '/ok/w', extra_prompt: '', allow_writes: false, permission: 'read_only', preset_id: 'rp_review' })
  })

  it('角色选「不用」时请求不带 preset_id，回到默认只读', async () => {
    const bodies = stub([], [{ id: 'rp_pm', scene: '产品经理工作台', content: '出 PRD', default: true }])
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    const sel = screen.getByRole('combobox', { name: '角色' })
    await waitFor(() => expect(sel).toHaveValue('rp_pm'))
    await user.selectOptions(sel, '')
    expect(screen.getByText('不带角色的执行要求，只按任务内容和附加说明执行')).toBeInTheDocument()
    const go = screen.getByRole('button', { name: '开始执行（只读）' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ workdir: '/ok/w', extra_prompt: '', allow_writes: false, permission: 'read_only' })
  })

  it('已有运行中的执行时按钮是「查看运行中」', async () => {
    stub([{ id: 'run_r1', object_id: 'obj_1', status: 'running' } as TaskRun])
    renderButton()
    expect(await screen.findByRole('button', { name: '查看运行中' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交给执行' })).not.toBeInTheDocument()
  })

  it('终端插件没在跑：「切换到终端」置灰并说明', async () => {
    stub()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    expect(screen.getByRole('radio', { name: '流式执行' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '切换到终端' })).toBeDisabled()
    expect(screen.getByText(/终端插件没启用，到 设置 > 插件 里启用后可用/)).toBeInTheDocument()
  })

  it('切换到终端：不显示允许写入，发起后让终端插件开标签并跳到终端页', async () => {
    const bodies = stub()
    const reqs = fakeLauncher()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(screen.getByRole('radio', { name: '切换到终端' }))
    expect(screen.queryByRole('checkbox', { name: '允许写入' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '附加说明' }), '只改文档')
    const go = screen.getByRole('button', { name: '在终端中打开' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    expect(await screen.findByText('终端页')).toBeInTheDocument()
    expect(bodies).toEqual([{ workdir: '/ok/w', extra_prompt: '只改文档' }])
    expect(reqs).toEqual([{
      cwd: '/ok/w', title: 'TSK-0001',
      claude: { prompt_file: '/data/tmp/handoff/run_t1/prompt.md', mcp_config: '/data/tmp/handoff/run_t1/mcp.json', workdir: '/ok/w' },
    }])
  })

  it('终端没开出来：这次执行记成失败，弹窗留着说原因', async () => {
    const bodies = stub()
    fakeLauncher(true)
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(screen.getByRole('radio', { name: '切换到终端' }))
    const go = screen.getByRole('button', { name: '在终端中打开' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    expect(await screen.findByRole('alert')).toHaveTextContent('终端没打开：最多同时开 16 个终端')
    await waitFor(() => expect(bodies).toContainEqual({ finish: 'run_t1', status: 'failed', summary: '终端没打开：最多同时开 16 个终端' }))
    expect(screen.getByRole('dialog', { name: '交给 Claude Code' })).toBeInTheDocument()
  })

  it('提示词预览：展开才取，跟着方式变', async () => {
    stub()
    fakeLauncher()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    expect(screen.queryByLabelText('提示词预览')).not.toBeInTheDocument()
    await user.click(screen.getByText('提示词预览'))
    expect(await screen.findByLabelText('提示词预览')).toHaveTextContent('预览 mode=stream')
    await user.click(screen.getByRole('radio', { name: '切换到终端' }))
    await waitFor(() => expect(screen.getByLabelText('提示词预览')).toHaveTextContent('预览 mode=terminal'))
  })

  // TSK-0499：勾了允许写入才出写入档位，默认跟设置「执行权限」，选的档位进请求体
  it('写入档位：默认跟设置，可改，发起时带 permission', async () => {
    const bodies = stub([], [], { write_profile: 'edits_and_tests', custom: ['Bash(git commit:*)'] })
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    expect(screen.queryByRole('combobox', { name: '写入档位' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: '允许写入' }))
    await user.click(screen.getByRole('button', { name: '确认允许写入' }))
    const sel = await screen.findByRole('combobox', { name: '写入档位' })
    await waitFor(() => expect(sel).toHaveValue('edits_and_tests'))
    expect(screen.getByRole('link', { name: '管理执行权限' })).toHaveAttribute('href', '/settings/run-permissions')
    await user.selectOptions(sel, 'custom')
    expect(screen.getByText(/自定义白名单（1 条）/)).toBeInTheDocument()
    const go = screen.getByRole('button', { name: '开始执行（允许写入）' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ workdir: '/ok/w', extra_prompt: '', allow_writes: true, permission: 'custom' })
  })
})
