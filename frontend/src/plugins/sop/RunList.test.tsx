// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSopRuns, type SopFlow, type SopRunBrief, type SopRunStatus } from '../../core/data'
import { RunList } from './RunList'

const FLOW: SopFlow = {
  id: 'sop_a', name: '写纪要', desc: '', trigger: 'manual', version: 2, created_at: '', updated_at: '',
  fields: [], steps: [{ key: 'ai', name: 'AI 起草', kind: 'ai' }],
}
const t0 = Date.parse('2026-11-02T10:00:00Z')

const run = (i: number, status: SopRunStatus, flowVersion = 2): SopRunBrief => ({
  id: `spr_${i}`, flow_id: FLOW.id, flow_name: FLOW.name, flow_version: flowVersion, title: `写纪要 · ${i}`, step_through: false, stopped: false,
  status, source: 'manual', started_at: new Date(t0 - i * 1000).toISOString(), updated_at: new Date(t0).toISOString(), focus: 0,
  steps: [{ key: 'ai', name: 'AI 起草', kind: 'ai', status: status === 'failed' ? 'failed' : 'running' }],
})

function stub() {
  const calls: { path: string; body?: { run_ids: string[]; action: string } }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: u.pathname, body })
    if (u.pathname === '/api/sop/runs/batch-actions') {
      const done = body.run_ids.slice(0, -1).map((id: string) => ({ run_id: id, ...(body.action === 'relaunch' ? { new_run_id: `n_${id}` } : { steps: ['ai'] }) }))
      const data = { done, skipped: [{ run_id: body.run_ids.at(-1), reason: '不是失败状态（执行中）' }], failed: [] }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
  }))
  return calls
}

function renderList(runs: SopRunBrief[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunList runs={runs} flows={[FLOW]} view="runs" flow="" onFlow={() => undefined} onOpen={() => undefined} now={t0} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('失败页批量重跑', () => {
  it('只有「失败」分段有勾选框；勾选后按流程是否改过选默认做法，重跑后提示结果并清掉勾选', async () => {
    const calls = stub()
    const user = userEvent.setup()
    renderList([run(1, 'failed', 1), run(2, 'failed', 2), run(3, 'running')])
    expect(screen.queryByRole('checkbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: /^失败/ }))
    await user.click(screen.getByRole('checkbox', { name: '选中 写纪要 · 2' }))
    const bar = screen.getByRole('toolbar', { name: '批量重跑' })
    expect(within(bar).getByText('已选 1 条')).toBeTruthy()

    // 只选了流程没改过的：默认重试
    await user.click(within(bar).getByRole('button', { name: '批量重跑' }))
    expect((screen.getByRole('radio', { name: /重试失败的步骤/ }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '取消' }))

    // 全选当前筛选结果：有一条流程发起后改过，默认按最新流程
    await user.click(within(bar).getByRole('button', { name: '全选当前筛选结果 2 条' }))
    await user.click(within(bar).getByRole('button', { name: '批量重跑' }))
    expect((screen.getByRole('radio', { name: /按最新流程重新发起/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/其中 1 条的流程在发起后改过/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重新发起' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('新发起 1 条、跳过 1 条'))
    expect(screen.getByRole('status').textContent).toContain('排队')
    const req = calls.find((c) => c.path === '/api/sop/runs/batch-actions')!
    expect(req.body).toEqual({ run_ids: ['spr_1', 'spr_2'], action: 'relaunch' })
    expect(screen.queryByRole('toolbar', { name: '批量重跑' })).toBeNull()
  })

  it('全选最多 200 条，超出时提示', async () => {
    stub()
    const user = userEvent.setup()
    renderList(Array.from({ length: 205 }, (_, i) => run(i + 1, 'failed')))
    await user.click(screen.getByRole('button', { name: /^失败/ }))
    await user.click(screen.getByRole('checkbox', { name: '全选当前筛选结果（最多 200 条）' }))
    const bar = screen.getByRole('toolbar', { name: '批量重跑' })
    expect(within(bar).getByText('已选 200 条')).toBeTruthy()
    expect(within(bar).getByRole('note').textContent).toContain('当前筛选结果有 205 条，一次最多重跑 200 条')
  })
})

describe('失败行的「重试」按钮', () => {
  it('每条失败的执行都有，流程没改过在原执行里重试，改过就按最新流程重跑；不是失败的没有', async () => {
    const bodies: { run_ids: string[]; action: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input), 'http://x')
      if (u.pathname === '/api/sop/runs/batch-actions') {
        const body = JSON.parse(String(init!.body))
        bodies.push(body)
        const data = { done: [{ run_id: body.run_ids[0], ...(body.action === 'relaunch' ? { new_run_id: 'spr_new' } : { steps: ['ai'] }) }], skipped: [], failed: [] }
        return new Response(JSON.stringify({ data }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
    }))
    const user = userEvent.setup()
    renderList([run(1, 'failed', 1), run(2, 'failed', 2), run(3, 'running')])

    expect(screen.getByText('写纪要 · 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(重试|重跑) 写纪要 · 3/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: '重试 写纪要 · 2' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('重试了 1 条'))
    expect(bodies[0]).toEqual({ run_ids: ['spr_2'], action: 'retry' })

    await user.click(screen.getByRole('button', { name: '重跑 写纪要 · 1' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('新发起 1 条'))
    expect(bodies[1]).toEqual({ run_ids: ['spr_1'], action: 'relaunch' })
  })
})

describe('重跑后离开「失败」、幂等', () => {
  /** 照 Page 的用法：执行列表从缓存来（useSopRuns），重跑结果先写进缓存 */
  function Harness({ onOpen }: { onOpen: (id: string) => void }) {
    const q = useSopRuns()
    return <RunList runs={q.data ?? []} flows={[FLOW]} view="runs" flow="" onFlow={() => undefined} onOpen={onOpen} now={t0} />
  }

  it('单条重跑、重试成功后该行立即从「失败」里消失；「全部」里显示「已重跑」并能点到新执行', async () => {
    const initial = [run(1, 'failed', 1), run(2, 'failed', 2), run(3, 'done')]
    let rerunCalled = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input), 'http://x')
      if (u.pathname === '/api/sop/runs/batch-actions') {
        rerunCalled = true
        const body = JSON.parse(String(init!.body))
        const data = { done: [{ run_id: body.run_ids[0], ...(body.action === 'relaunch' ? { new_run_id: 'spr_new' } : { steps: ['ai'] }) }], skipped: [], failed: [] }
        return new Response(JSON.stringify({ data }), { status: 200 })
      }
      // 重跑之后的重新取一直不回：列表的变化只能来自乐观更新
      if (rerunCalled) return new Promise<Response>(() => undefined)
      return new Response(JSON.stringify({ data: initial, meta: { total: initial.length } }), { status: 200 })
    }))
    const onOpen = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><Harness onOpen={onOpen} /></QueryClientProvider>)
    const user = userEvent.setup()
    await screen.findByText('写纪要 · 1')
    await user.click(screen.getByRole('button', { name: /^失败/ }))
    expect(screen.getByRole('button', { name: /^失败/ }).textContent).toBe('失败2')

    await user.click(screen.getByRole('button', { name: '重跑 写纪要 · 1' }))
    await waitFor(() => expect(screen.queryByText('写纪要 · 1')).toBeNull())
    expect(screen.getByRole('button', { name: /^失败/ }).textContent).toBe('失败1')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('新发起 1 条'))

    await user.click(screen.getByRole('button', { name: '重试 写纪要 · 2' }))
    await waitFor(() => expect(screen.queryByText('写纪要 · 2')).toBeNull())
    expect(screen.getByRole('button', { name: /^失败/ }).textContent).toBe('失败0')

    await user.click(screen.getByRole('button', { name: /^全部\d/ }))
    const row = screen.getByText('写纪要 · 1').closest('.sop-run-pick') as HTMLElement
    expect(within(row).getByText('已重跑')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /^(重试|重跑) / })).toBeNull()
    await user.click(within(row).getByRole('button', { name: '看 写纪要 · 1 重跑出来的新执行' }))
    expect(onOpen).toHaveBeenCalledWith('spr_new')
    // 重试的那条变执行中
    const r2 = screen.getByText('写纪要 · 2').closest('.sop-run-pick') as HTMLElement
    expect(within(r2).getByText('执行中')).toBeTruthy()
  })

  it('已重跑的不在「失败」「待我处理」里，在「全部」里', async () => {
    const relaunched = { ...run(1, 'failed'), relaunched_to: 'spr_new' }
    const user = userEvent.setup()
    const { unmount } = renderList([relaunched, run(2, 'failed')])
    expect(screen.getByRole('button', { name: /^失败/ }).textContent).toBe('失败1')
    expect(screen.getByText('写纪要 · 1')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^失败/ }))
    expect(screen.queryByText('写纪要 · 1')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '选中 写纪要 · 1' })).toBeNull()
    unmount()
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <RunList runs={[relaunched, run(2, 'failed')]} flows={[FLOW]} view="waiting" flow="" onFlow={() => undefined} onOpen={() => undefined} now={t0} />
      </QueryClientProvider>,
    )
    expect(screen.queryByText('写纪要 · 1')).toBeNull()
    expect(screen.getByText('写纪要 · 2')).toBeTruthy()
  })

  it('单条按钮连点两下只发一次请求；批量确认框连点也只发一次', async () => {
    const calls = stub()
    renderList([run(1, 'failed', 2), run(2, 'failed', 2)])
    const btn = screen.getByRole('button', { name: '重试 写纪要 · 1' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(calls.filter((c) => c.path === '/api/sop/runs/batch-actions')).toHaveLength(1)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^失败/ }))
    await user.click(screen.getByRole('checkbox', { name: '选中 写纪要 · 2' }))
    await user.click(within(screen.getByRole('toolbar', { name: '批量重跑' })).getByRole('button', { name: '批量重跑' }))
    const ok = screen.getByRole('button', { name: '重试 1 条' })
    fireEvent.click(ok)
    fireEvent.click(ok)
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试 1 条' })).toBeNull())
    expect(calls.filter((c) => c.path === '/api/sop/runs/batch-actions')).toHaveLength(2)
  })
})

function stubStop() {
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: u.pathname, body })
    if (u.pathname === '/api/sop/runs/batch-actions') {
      const data = { done: body.run_ids.map((id: string) => ({ run_id: id })), skipped: [], failed: [] }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }
    if (u.pathname === '/api/sop/runs/stop') {
      const summary = { running: 7, waiting: 2, done: 0, failed: 0, stopped: 0 }
      const data = body.dry_run
        ? { matched: 9, stopped: [], skipped: [], failed: [], summary, dry_run: true }
        : { matched: 9, stopped: Array.from({ length: 9 }, (_, i) => `spr_${i}`), skipped: [], failed: [], summary: { ...summary, running: 0, waiting: 0, stopped: 9 }, dry_run: false }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
  }))
  return calls
}

describe('停止（TSK-0717）', () => {
  it('执行中、待我处理的行有「停止」，确认后按 id 停；已完成、失败的没有', async () => {
    const calls = stubStop()
    const user = userEvent.setup()
    renderList([run(1, 'running'), run(2, 'waiting'), run(3, 'done'), run(4, 'failed')])
    expect(screen.getByRole('button', { name: '停止 写纪要 · 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止 写纪要 · 2' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '停止 写纪要 · 3' })).toBeNull()
    expect(screen.queryByRole('button', { name: '停止 写纪要 · 4' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '停止 写纪要 · 1' }))
    const dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByText(/已经建出的任务、写出的文档、发出的消息不会撤回/)).toBeTruthy()
    await user.click(within(dlg).getByRole('button', { name: '停止 1 条' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止 1 条'))
    expect(calls.find((c) => c.path === '/api/sop/runs/batch-actions')!.body).toEqual({ run_ids: ['spr_1'], action: 'stop' })
  })

  it('「执行中」分段能勾选批量停止，只有能停的行有勾选框；「全部」分段没有勾选框', async () => {
    const calls = stubStop()
    const user = userEvent.setup()
    renderList([run(1, 'running'), run(2, 'running'), run(3, 'done')])
    expect(screen.queryByRole('checkbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: /^执行中/ }))
    await user.click(screen.getByRole('checkbox', { name: '选中 写纪要 · 1' }))
    const bar = screen.getByRole('toolbar', { name: '批量停止' })
    await user.click(within(bar).getByRole('button', { name: '全选当前筛选结果 2 条' }))
    await user.click(within(bar).getByRole('button', { name: '批量停止' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '停止 2 条' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止 2 条'))
    expect(calls.find((c) => c.path === '/api/sop/runs/batch-actions')!.body).toEqual({ run_ids: ['spr_1', 'spr_2'], action: 'stop' })
    expect(screen.queryByRole('toolbar', { name: '批量停止' })).toBeNull()
  })

  it('「停止全部运行中」先数出将停几条，确认后按条件停，回报停了多少', async () => {
    const calls = stubStop()
    const user = userEvent.setup()
    renderList([run(1, 'running'), run(2, 'done')])
    await user.click(screen.getByRole('button', { name: '停止全部运行中' }))
    const dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByText('停止全部流程运行中的执行')).toBeTruthy()
    await within(dlg).findByText(/全部流程现在有 9 条执行中或等你处理的执行/)
    expect(within(dlg).getByText(/其中 2 条在等你处理/)).toBeTruthy()
    await user.click(within(dlg).getByRole('button', { name: '停止 9 条' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止 9 条'))
    expect(calls.filter((c) => c.path === '/api/sop/runs/stop').map((c) => c.body).slice(0, 2)).toEqual([{ all_running: true, dry_run: true }, { all_running: true }])
  })
})
