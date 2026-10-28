import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRun, WorkObject } from '../../core/data'
import { HandOffButton } from './HandOff'
import { resetLiveRuns } from './runLive'

const task = { id: 'obj_1', ref: 'TSK-0001', title: '任务' } as WorkObject

// 打桩 fetch：执行记录、目录校验（/ok 开头的可用）、发起执行（回一段 SSE）
function stub(rows: TaskRun[] = []) {
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
    if (url.includes('/api/objects/obj_1/runs')) return json(rows)
    return json([])
  }))
  return bodies
}

function renderButton(workdir = '/ok/w') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><HandOffButton task={task} workdir={workdir} /></QueryClientProvider>)
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetLiveRuns()
})

describe('交给 Claude Code', () => {
  it('允许写入默认不勾；勾选先二次确认，取消后仍是只读，确认后才勾上', async () => {
    stub()
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给 Claude Code' }))
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
    await user.click(await screen.findByRole('button', { name: '交给 Claude Code' }))
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
    await user.click(await screen.findByRole('button', { name: '交给 Claude Code' }))
    await user.type(screen.getByRole('textbox', { name: '附加说明' }), '只读 a.txt')
    const go = screen.getByRole('button', { name: '开始执行（只读）' })
    await waitFor(() => expect(go).toBeEnabled())
    await user.click(go)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ workdir: '/ok/w', extra_prompt: '只读 a.txt', allow_writes: false })
    expect(screen.queryByRole('dialog', { name: '交给 Claude Code' })).not.toBeInTheDocument()
  })

  it('已有运行中的执行时按钮是「查看运行中」', async () => {
    stub([{ id: 'run_r1', object_id: 'obj_1', status: 'running' } as TaskRun])
    renderButton()
    expect(await screen.findByRole('button', { name: '查看运行中' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交给 Claude Code' })).not.toBeInTheDocument()
  })
})
