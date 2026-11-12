// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent, TaskRun, WorkObject } from '../../core/data'
import { RunsBlock } from './Runs'
import { RunStream } from './RunStream'

const at = new Date(Date.now() - 5 * 60_000).toISOString()
function run(p: Partial<TaskRun>): TaskRun {
  return {
    id: 'run_' + Math.random().toString(36).slice(2, 12), object_id: 'obj_1', workdir: '/tmp/w', prompt: '## 任务\n\n## 约束\n',
    status: 'done', exit_code: 0, output: '', error: '', started_at: at, finished_at: new Date().toISOString(), mode: 'stream', ...p,
  }
}
const task = { id: 'obj_1', ref: 'TSK-0001', title: '任务' } as WorkObject

// 打桩 fetch：列表、单条、取消；cancel 之后列表回已取消
function stub(rows: TaskRun[]) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push((init?.method ?? 'GET') + ' ' + url.replace(/^https?:\/\/[^/]+/, ''))
    const finish = /\/api\/runs\/([^/]+)\/finish$/.exec(url)
    if (finish) {
      const body = JSON.parse(String(init?.body)) as { status: TaskRun['status']; summary: string }
      calls.push('BODY ' + JSON.stringify(body))
      rows = rows.map((x) => (x.id === finish[1] ? { ...x, status: body.status, output: body.summary, finished_at: new Date().toISOString() } : x))
      return new Response(JSON.stringify({ data: rows.find((x) => x.id === finish[1]) }), { status: 200 })
    }
    const cancel = /\/api\/runs\/([^/]+)\/cancel$/.exec(url)
    if (cancel) {
      const r = rows.find((x) => x.id === cancel[1])!
      rows = rows.map((x) => (x.id === r.id ? { ...x, status: 'canceled', error: '执行已被取消', exit_code: -1, finished_at: new Date().toISOString() } : x))
      return new Response(JSON.stringify({ data: r }), { status: 200 })
    }
    const one = /\/api\/runs\/([^/?]+)$/.exec(url)
    if (one) return new Response(JSON.stringify({ data: rows.find((x) => x.id === one[1]) }), { status: 200 })
    return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }), { status: 200 })
  }))
  return calls
}

function renderBlock() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><RunsBlock task={task} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('执行记录', () => {
  it('没有记录时显示「还没有执行过」', async () => {
    stub([])
    renderBlock()
    expect(await screen.findByText('还没有执行过')).toBeInTheDocument()
  })

  it('按 status 显示：exit 0 但 failed 显示失败和红字原因；完成带 error 显示保留意见；附加说明从提示词取', async () => {
    stub([
      run({ id: 'run_aaaaaaaa1', status: 'failed', exit_code: 0, error: '有 1 次工具调用被权限挡下，任务没有真正完成。' }),
      run({ id: 'run_bbbbbbbb2', status: 'done', error: '其余步骤已执行', prompt: '## 本次执行的补充要求\n只读 a.md\n\n## 约束\n' }),
    ])
    renderBlock()
    const failed = (await screen.findByText('有 1 次工具调用被权限挡下，任务没有真正完成。')).closest('[data-run]') as HTMLElement
    expect(failed).toHaveAttribute('data-status', 'failed')
    expect(within(failed).getByText('失败')).toHaveClass('run-st-bad')
    expect(within(failed).getByText('有 1 次工具调用被权限挡下，任务没有真正完成。')).toHaveClass('run-note-danger')
    expect(within(failed).getByText('没有附加说明')).toBeInTheDocument()
    const done = screen.getByText('保留意见：其余步骤已执行').closest('[data-run]') as HTMLElement
    expect(within(done).getByText('完成')).toBeInTheDocument()
    expect(within(done).getByText('只读 a.md')).toBeInTheDocument()
  })

  it('点开取单条完整输出，工具调用成卡片，失败的标红', async () => {
    const r = run({ id: 'run_cccccccc3', output: '先读。\n[工具] Read · /tmp/w/a.md\n[工具] Write · /tmp/w/b.md\n[工具失败] Write · 权限不足\n读完了。' })
    const calls = stub([r])
    renderBlock()
    const user = userEvent.setup()
    const head = await screen.findByRole('button', { name: /完成/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    await user.click(head)
    expect(await screen.findByText('读完了。')).toBeInTheDocument()
    expect(calls).toContain('GET /api/runs/run_cccccccc3')
    const item = head.closest('[data-run]') as HTMLElement
    expect(within(item).getByText('/tmp/w · 记录 ccccccc3 · exit 0')).toBeInTheDocument()
    const bad = item.querySelector('[data-state="failed"]') as HTMLElement
    expect(bad).toHaveClass('run-tool-failed')
    expect(within(bad).getByText('失败')).toBeInTheDocument()
    expect(within(bad).getByText('权限不足')).toBeInTheDocument()
    expect(item.querySelector('[data-state="ok"]')).toHaveTextContent('Read')
  })

  it('运行中的一直展开，点取消调接口，状态以后端读回的为准', async () => {
    const r = run({ id: 'run_dddddddd4', status: 'running', finished_at: null })
    const calls = stub([r])
    renderBlock()
    const user = userEvent.setup()
    const btn = await screen.findByRole('button', { name: '取消执行' })
    expect(screen.getByText('运行中')).toBeInTheDocument()
    await user.click(btn)
    expect(calls).toContain('POST /api/runs/run_dddddddd4/cancel')
    await waitFor(() => expect(screen.getByText('已取消')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /取消执行|正在取消/ })).not.toBeInTheDocument()
    expect(screen.getByText('执行已被取消')).toBeInTheDocument()
  })

  it('有缓存 token 时显示缓存命中标签和模块键，没有数据不显示（模块前缀复用 P0）', async () => {
    stub([
      run({ id: 'run_cache01', harness: 'deepseek', cache_read_tokens: 8700, uncached_input_tokens: 1300, module_key: 'project:obj_x' }),
      run({ id: 'run_plain02', harness: 'deepseek' }),
    ])
    renderBlock()
    const tag = await screen.findByText('缓存 87%')
    const cached = tag.closest('[data-run]') as HTMLElement
    expect(cached).toHaveAttribute('data-run', 'run_cache01')
    expect(within(cached).getByText('模块 项目 obj_x')).toBeInTheDocument()
    expect(tag.getAttribute('title')).toContain('命中缓存 8700 tokens / 未命中 1300 tokens')
    expect(tag.getAttribute('title')).toContain('模块前缀复用')
    await waitFor(() => expect(document.querySelector('[data-run="run_plain02"]')).not.toBeNull())
    const plain = document.querySelector('[data-run="run_plain02"]') as HTMLElement
    expect(within(plain).queryByText(/缓存 \d+%/)).not.toBeInTheDocument()
    expect(within(plain).queryByText(/^模块 /)).not.toBeInTheDocument()
  })
})

describe('流式输出', () => {
  it('tool 和 tool_result 按 id 配成卡片，失败的红边并显示原因，运行中有光标', () => {
    const ev: RunEvent[] = [
      { type: 'delta', text: '开始' },
      { type: 'tool', id: 't1', name: 'Read', detail: 'a.md' },
      { type: 'tool', id: 't2', name: 'Bash', detail: 'rm -rf x' },
      { type: 'tool_result', id: 't2', name: 'Bash', ok: false, error: '被权限挡下' },
      { type: 'tool_result', id: 't1', name: 'Read', ok: true, error: '' },
      { type: 'tool', id: 't3', name: 'Grep', detail: 'foo' },
    ]
    const { container } = render(<RunStream events={ev} live />)
    const t1 = container.querySelector('[data-tool-id="t1"]') as HTMLElement
    const t2 = container.querySelector('[data-tool-id="t2"]') as HTMLElement
    const t3 = container.querySelector('[data-tool-id="t3"]') as HTMLElement
    expect(within(t1).getByText('成功')).toBeInTheDocument()
    expect(t2).toHaveClass('run-tool-failed')
    expect(within(t2).getByText('被权限挡下')).toBeInTheDocument()
    expect(within(t3).getByText('执行中')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '输出中' })).toBeInTheDocument()
  })

  it('标方式：流式和终端；终端执行的结论按 Markdown 显示', async () => {
    stub([
      run({ id: 'run_term00001', mode: 'terminal', output: '写完了 PRD，放在 **acme-project/需求**' }),
      run({ id: 'run_strm00002' }),
    ])
    renderBlock()
    const user = userEvent.setup()
    const term = (await screen.findByText('终端')).closest('[data-run]') as HTMLElement
    expect(term).toHaveAttribute('data-mode', 'terminal')
    expect(within(screen.getByText('流式').closest('[data-run]') as HTMLElement).getByText('完成')).toBeInTheDocument()
    await user.click(within(term).getByRole('button', { name: /完成/ }))
    expect(within(term).getByText('acme-project/需求')).toBeInTheDocument()
  })

  it('进行中的终端执行：没有取消，有「标记结束」，选结果写结论后收尾', async () => {
    const calls = stub([run({ id: 'run_term00003', mode: 'terminal', status: 'running', finished_at: null })])
    renderBlock()
    const user = userEvent.setup()
    const item = (await screen.findByText('终端')).closest('[data-run]') as HTMLElement
    expect(within(item).queryByRole('button', { name: '取消执行' })).not.toBeInTheDocument()
    expect(within(item).getByText(/结束和结论由终端里的 Claude Code 经工作台 MCP 回写/)).toBeInTheDocument()
    await user.click(within(item).getByRole('button', { name: '标记结束' }))
    const dlg = await screen.findByRole('alertdialog', { name: '标记结束' })
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '结果' }), 'failed')
    await user.type(within(dlg).getByRole('textbox'), '卡在权限')
    await user.click(within(dlg).getByRole('button', { name: '标记结束' }))
    await waitFor(() => expect(calls).toContain('POST /api/runs/run_term00003/finish'))
    expect(calls).toContain('BODY {"status":"failed","summary":"卡在权限"}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(await screen.findByText('失败')).toBeInTheDocument()
  })
})
