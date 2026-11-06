import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow, SopRun, SopStepDef } from '../../core/data'
import { checkDraft, catalogOf, changeKind, claudeTimeoutMs, loopRounds, makeStep, newDraft, upstreamSteps, type Draft } from './edit'
import { EMPTY_CTX, nodeInfo } from './nodes'
import Page from './Page'

// Claude Code 执行节点（AUTO-01）、条件回退节点（AUTO-02）：编辑器配置、保存前检查、执行详情的轮次和跳转

const cat = catalogOf([
  { kind: 'template', group: '知识与数据', branching: false, required: [] },
  { kind: 'loopback', group: '逻辑', branching: true, default_cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }], required: [{ key: 'target', label: '退回到哪一步' }] },
  { kind: 'decide', group: '逻辑', branching: true, default_cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], required: [] },
  { kind: 'claude_code', group: '外部', branching: false, required: [{ key: 'workdir', label: '工作目录' }, { key: 'prompt', label: '提示词' }] },
])
const st = (key: string, kind: string, after: string[] = [], extra: Partial<SopStepDef> = {}): SopStepDef => ({ key, name: key, kind, desc: '', after, ...extra })
const draft = (steps: SopStepDef[]): Draft => ({ ...newDraft('manual'), name: '流程', steps })
const errs = (d: Draft) => checkDraft(d, cat).filter((x) => x.level === 'error').map((x) => x.text)

describe('条件回退的配置和检查', () => {
  const loop = (cfg: Record<string, string>, rule = 'result.verdict 等于 reject', cases = [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }]) =>
    st('gate', 'loopback', ['rv'], { rule, config: cfg, cases })
  const base = [st('dev', 'template', [], { config: { template: 'x' } }), st('rv', 'template', ['dev'], { config: { template: 'y' } })]

  it('新建带两个出口和空条件；换成别的分支类型时出口换成那个类型的', () => {
    const s = makeStep(draft([]), cat, 'loopback', '条件回退', [])
    expect(s).toMatchObject({ cond: { logic: 'and', items: [{ field: '', op: 'eq', value: '' }] }, cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }], config: { max_rounds: '3' } })
    expect(changeKind(cat, s, 'decide').cases?.map((c) => c.key)).toEqual(['yes', 'no'])
    expect(changeKind(cat, st('d', 'decide', [], { cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }] }), 'loopback').cases?.map((c) => c.key)).toEqual(['pass', 'over'])
  })

  it('目标只能是上游，回退不算环；条件、上限、出口要对', () => {
    expect(errs(draft([...base, loop({ target: 'dev', max_rounds: '3' })]))).toEqual([])
    expect(upstreamSteps(draft([...base, loop({ target: 'dev' })]), 2).map((x) => x.key)).toEqual(['dev', 'rv'])
    expect(errs(draft([...base, loop({ target: 'gate' })]))).toContain('「gate」不能退回到自己')
    expect(errs(draft([...base, loop({ target: 'nope' })]))).toContain('「gate」退回的步骤已被删除')
    expect(errs(draft([...base, loop({ target: 'later' }), st('later', 'template', ['gate'], { config: { template: 'z' } })]))).toContain('「gate」只能退回到上游的步骤')
    expect(errs(draft([...base, loop({ target: 'dev', max_rounds: '11' })]))).toContain('「gate」最多退回几轮要是 1 到 10 的整数')
    expect(errs(draft([...base, loop({ target: 'dev' }, '')]))).toContain('「gate」还没填回退条件')
    expect(errs(draft([...base, loop({ target: 'dev' }, 'verdict 是 reject')]))[0]).toContain('是一句话')
    expect(errs(draft([...base, loop({ target: 'dev' }, undefined, [{ key: 'pass', label: '通过' }, { key: 'x', label: '别的' }])]))).toContain('「gate」出口要有「通过」和「超限」')
    expect(loopRounds('')).toBe(3)
    expect(loopRounds('0')).toBeNull()
  })

  it('退回目标下拉列上游步骤，选着的不在上游时标出来', () => {
    const f = nodeInfo('loopback').fields.find((x) => x.key === 'target')!
    const ctx = { ...EMPTY_CTX, ups: [{ key: 'dev', name: '研发' }] }
    expect(f.options?.(ctx, {}).map((o) => o.label)).toEqual(['选一个上游步骤', '研发'])
    expect(f.options?.(ctx, { target: 'x' }).at(-1)).toEqual({ value: 'x', label: 'x（不在上游）' })
  })
})

describe('Claude Code 执行的配置', () => {
  it('角色下拉标出只读，摘要写角色和目录；超时写法', () => {
    const ctx = { ...EMPTY_CTX, presets: [{ id: 'rp_review', scene: '研发评审', permission: 'read_only' }, { id: 'rp_dev', scene: '研发' }] }
    const info = nodeInfo('claude_code')
    expect(info.fields.map((f) => f.key)).toEqual(['preset', 'workdir', 'prompt', 'task', 'permission', 'timeout'])
    expect(info.fields[0].options?.(ctx, {}).map((o) => o.label)).toEqual(['不选角色', '研发评审（只读）', '研发'])
    expect(info.summary?.({ preset: 'rp_dev', workdir: '/w' }, ctx)).toBe('研发 · /w')
    expect(claudeTimeoutMs('')).toBe(2 * 3600e3)
    expect(claudeTimeoutMs('30 分钟')).toBe(30 * 60e3)
    expect(claudeTimeoutMs('1h30m')).toBe(90 * 60e3)
    expect(claudeTimeoutMs('2 天')).toBeNull()
    const d = draft([st('c', 'claude_code', [], { config: { workdir: '/w', prompt: 'p', timeout: '永远' } })])
    expect(errs(d)[0]).toContain('超时写法不对')
  })
})

const FLOW: SopFlow = {
  id: 'sop_loop', name: '研发闭环', desc: '', trigger: 'manual', version: 1, created_at: '', updated_at: '', fields: [],
  steps: [
    { key: 'dev', name: '研发', kind: 'claude_code', config: { workdir: '/w', prompt: 'p', task: '{{task_id}}' } },
    { key: 'rv', name: '评审', kind: 'claude_code', config: { workdir: '/w', prompt: 'r' } },
    { key: 'gate', name: '不通过退回', kind: 'loopback', rule: 'result.verdict 等于 reject', config: { target: 'dev', max_rounds: '3' },
      cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }] },
  ],
}
const now = new Date().toISOString()
const RUN: SopRun = {
  id: 'spr_1', flow_id: FLOW.id, flow_name: FLOW.name, flow_version: 1, flow: FLOW, title: '研发闭环', input: {}, step_through: false, stopped: false,
  status: 'running', started_at: now, updated_at: now,
  steps: [
    { key: 'dev', status: 'running', input: { feedback: { round: 2 } }, output: null, attempts: 2, log: [], started_at: now, round: 2,
      rework_reason: '「不通过退回」条件「result.verdict 等于 reject」成立', claude: { run_id: 'run_t2', task_id: 'obj_t1', workdir: '/w' } },
    { key: 'rv', status: 'pending', input: null, output: null, attempts: 1, log: [], round: 2 },
    { key: 'gate', status: 'pending', input: null, output: null, attempts: 1, log: [], round: 2, loops: 1 },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('执行详情', () => {
  it('显示第几轮和退回原因，能跳到任务里的这次 Claude Code 执行；回退节点显示已退回几轮', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x')
      const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: 0 } }), { status: 200 })
      if (u.pathname === '/api/sop/runs/spr_1') return json(RUN)
      if (u.pathname === '/api/sop/node-types') return json([])
      if (u.pathname === '/api/sop/flows' || u.pathname === '/api/sop/runs') return json([])
      return json([])
    }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }, { path: '/tasks', element: <div>任务页</div> }], { initialEntries: ['/sop/runs/spr_1'] })
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
    expect(await screen.findByText('被退回重做')).toBeInTheDocument()
    expect(screen.getByText('「不通过退回」条件「result.verdict 等于 reject」成立')).toBeInTheDocument()
    expect(screen.getAllByText('第 2 轮').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '在任务里查看这次执行' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    expect(router.state.location.search).toBe('?t=obj_t1&run=run_t2')
  })
})
