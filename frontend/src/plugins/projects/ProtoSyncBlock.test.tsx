// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { protoSyncSummary, specStatuses, type ProtoSync, type ProtoSyncState } from '../../core/data'
import { ProtoSyncBlock } from './ProtoSyncBlock'

// 档案标签的「原型同步」（AUTO-11）：同步点和代码 HEAD、三种触发开关（默认关）、立即同步与设基线、
// 最近一次的差异清单按五类带规格实现状态、规格实现状态一览取最近一次、进行中能作废和去裁决
const sync = (over: Partial<ProtoSync> = {}): ProtoSync => ({
  id: 'psy_1', project_id: 'obj_p', trigger: 'release', trigger_ref: 'rel_1', status: 'done', code_dir: '/code', code_branch: 'main',
  base_commit: 'aaaaaaa1111', head_commit: 'bbbbbbb2222', files: ['web/export.tsx'], diff_stat: ' web/export.tsx | 3 ++', ui_changed: true,
  proto_dir: '/proto', proto_repo: '/proto', proto_branch: 'proto-sync/20261104', proto_base: 'ccc', proto_commit: 'ddddddd3333', proto_path: '',
  items: [
    { kind: 'added', title: '导出按钮', detail: '', spec: 'SPEC-home-1.2', page: '/home', status: 'implemented', decision: '' },
    { kind: 'unimplemented', title: '批量删除', detail: '', spec: 'SPEC-home-1.3', page: '', status: 'unimplemented', decision: '' },
    { kind: 'uncertain', title: '导出只有 CSV', detail: '原型是 CSV 和 Excel', spec: 'SPEC-home-1.4', page: '', status: 'deviation', decision: 'defect' },
  ],
  counts: { added: 1, changed: 0, unimplemented: 1, removed: 0, uncertain: 1, pending: 0 },
  decision: 'defect', decided_at: '2026-11-04T10:00:00Z', fix_task_id: 'obj_fix', summary: '补了导出按钮', run_dir: '', diff_path: '', run_id: 'run_1',
  sop_run_id: 'spr_1', error: '', started_at: '2026-11-04T10:00:00Z', finished_at: '2026-11-04T10:05:00Z', updated_at: '', ...over,
})

const stateOf = (over: Partial<ProtoSyncState> = {}): ProtoSyncState => ({
  project_id: 'obj_p', settings: { on_release: false, on_merge: false, daily: false, daily_at: '09:00', branch: '', updated_at: null },
  branch: 'main', head: 'eeeeeee4444', head_error: '',
  point: { commit: 'bbbbbbb2222', sync_id: 'psy_1', status: 'done', proto_branch: 'proto-sync/20261104', proto_commit: 'ddddddd3333', at: '2026-11-04T10:05:00Z' },
  last: sync(), active: null, ...over,
})

function backend(state: ProtoSyncState, history: ProtoSync[]) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
    if (u.pathname === '/api/projects/obj_p/proto-sync' && method === 'GET') return json(state)
    if (u.pathname === '/api/projects/obj_p/proto-sync' && method === 'PATCH') {
      state = { ...state, settings: { ...state.settings, ...body } }
      return json(state)
    }
    if (u.pathname === '/api/projects/obj_p/proto-syncs' && method === 'GET') return json(history)
    if (u.pathname === '/api/projects/obj_p/proto-syncs' && method === 'POST') {
      const p = sync({ id: 'psy_2', status: body.mode === 'baseline' ? 'baseline' : 'running', trigger: body.mode === 'baseline' ? 'baseline' : 'manual', items: [] })
      if (p.status === 'running') state = { ...state, active: p }
      return json(p, body.mode === 'baseline' ? 201 : 202)
    }
    if (u.pathname === '/api/projects/proto-syncs/runs/psy_2/cancel') {
      state = { ...state, active: null }
      return json(sync({ id: 'psy_2', status: 'cancelled' }))
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: u.pathname } }), { status: 404 })
  }))
  return calls
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={qc}><ProtoSyncBlock projectId="obj_p" /></QueryClientProvider></MemoryRouter>)
}

afterEach(() => vi.unstubAllGlobals())

describe('protoSyncSummary / specStatuses', () => {
  it('已同步写明同步分支和裁决，等裁决写明去哪定', () => {
    expect(protoSyncSummary(sync())).toBe('代码 aaaaaaa → bbbbbbb：新增 1、不一致 0、未实现 1、已下线 0、不确定 1；拿不准的当作缺陷。改动在 proto-sync/20261104（ddddddd），看过差异清单后再合并')
    expect(protoSyncSummary(sync({ status: 'reviewing', decision: '', counts: { added: 0, changed: 0, unimplemented: 0, removed: 0, uncertain: 2, pending: 2 } })))
      .toContain('2 条拿不准，到 SOP 执行页的「产品裁决」里定')
    expect(protoSyncSummary(sync({ status: 'no_change', trigger: 'daily', base_commit: 'x', head_commit: 'x' }))).toBe('自上次同步后生产分支没有新提交')
    expect(protoSyncSummary(sync({ base_commit: '', proto_commit: '', decision: '' }))).toContain('首次 → bbbbbbb')
  })
  it('规格实现状态按编号取最近一次，作废和失败的不算', () => {
    const older = sync({ id: 'psy_0', items: [{ kind: 'unimplemented', title: '导出按钮', detail: '', spec: 'SPEC-home-1.2', page: '', status: 'unimplemented', decision: '' }] })
    const cancelled = sync({ id: 'psy_c', status: 'cancelled', items: [{ kind: 'removed', title: '导出按钮', detail: '', spec: 'SPEC-home-1.2', page: '', status: 'offline', decision: '' }] })
    const rows = specStatuses([cancelled, sync(), older])
    expect(rows.map((r) => `${r.spec}:${r.status}`)).toEqual(['SPEC-home-1.2:implemented', 'SPEC-home-1.3:unimplemented', 'SPEC-home-1.4:deviation'])
  })
})

describe('ProtoSyncBlock', () => {
  it('同步点、开关默认关，最近一次的差异清单和规格实现状态', async () => {
    backend(stateOf(), [sync(), sync({ id: 'psy_0', status: 'baseline', items: [] })])
    mount()
    const block = await screen.findByRole('region', { name: '原型同步' })
    expect(within(block).getByRole('group', { name: '同步点' }).textContent).toContain('同步点：代码 bbbbbbb，对应原型 proto-sync/20261104 ddddddd')
    expect(block.textContent).toContain('生产分支 main 现在是 eeeeeee，比同步点新')
    for (const name of ['发布成功后同步', /生产分支有新提交时同步/, '每日巡检']) {
      expect(within(block).getByRole('switch', { name })).not.toBeChecked()
    }
    const diff = within(block).getByRole('table', { name: '差异清单' })
    expect(within(diff).getAllByRole('row').map((r) => r.textContent)).toEqual([
      '分类差异规格条目实现状态', '新增导出按钮SPEC-home-1.2已实现', '未实现批量删除SPEC-home-1.3未实现', '不确定导出只有 CSV原型是 CSV 和 Excel裁决：当作缺陷SPEC-home-1.4实现有偏差',
    ])
    expect(block.textContent).toContain('已建修复任务（obj_fix）')
    const specs = await within(block).findByRole('group', { name: '规格实现状态' })
    expect(within(specs).getAllByRole('row')).toHaveLength(4)
    expect(within(block).getByText('同步历史（2）')).toBeInTheDocument()
  })

  it('开关立即保存；巡检时间写错不保存', async () => {
    const calls = backend(stateOf(), [])
    mount()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('switch', { name: '发布成功后同步' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === '{"on_release":true}')).toBe(true))
    await waitFor(() => expect(screen.getByRole('switch', { name: '发布成功后同步' })).toBeChecked())
    const time = screen.getByRole('textbox', { name: '巡检时间' })
    await user.clear(time)
    await user.type(time, '9:3')
    await user.tab()
    expect(screen.getByText('时间写成 HH:MM，改好前不保存')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    await user.clear(time)
    await user.type(time, '21:30')
    await user.tab()
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === '{"daily_at":"21:30"}')).toBe(true))
  })

  it('立即同步后显示进行中，能作废；设为基线先确认', async () => {
    const calls = backend(stateOf(), [])
    mount()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '设为基线' }))
    expect(screen.getByText(/不对比、不改原型/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '设为基线' }).at(-1)!)
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && JSON.stringify(c.body) === '{"mode":"baseline"}')).toBe(true))
    await user.click(screen.getByRole('button', { name: '立即同步' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && JSON.stringify(c.body) === '{"mode":"sync"}')).toBe(true))
    const point = await screen.findByRole('group', { name: '同步点' })
    await waitFor(() => expect(within(point).getByText('进行中')).toBeInTheDocument())
    expect(within(point).getByRole('button', { name: '查看执行' })).toBeInTheDocument()
    await user.click(within(point).getByRole('button', { name: '作废' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/projects/proto-syncs/runs/psy_2/cancel')).toBe(true))
    await waitFor(() => expect(within(point).getByRole('button', { name: '立即同步' })).toBeInTheDocument())
  })

  it('没有同步点、取不到 HEAD：说明原因，不能发起', async () => {
    backend(stateOf({ point: null, last: null, head: '', branch: '', head_error: '项目没有代码库目录：先到项目的档案里填「代码库目录」' }), [])
    mount()
    const block = await screen.findByRole('region', { name: '原型同步' })
    expect(block.textContent).toContain('还没有同步点：第一次同步会对比整个代码库')
    expect(block.textContent).toContain('项目没有代码库目录')
    expect(within(block).getByRole('button', { name: '立即同步' })).toBeDisabled()
    expect(within(block).getByText('还没有同步过')).toBeInTheDocument()
  })
})
