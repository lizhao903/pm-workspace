// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// TSK-0498 前端：条件是一句话的提前发现（流程库「需修复」、流程详情修复提示）与失败面板换按钮。
// 接口口径（与后端并行）：流程列表 / 详情每项带 issues（code=rule_text）；执行步骤带 error_code=rule_text。
// 固定文案必须与后端逐字一致，这里把全文抄下来断言，改动文案时测试会先红。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow, SopRun, SopRunStep, SopStepDef } from '../../core/data'
import Page from './Page'
import { RunView } from './RunView'
import { ruleIsSentence, ruleSentenceText } from './repair'

const SENTENCE_RULE = 'IM 消息来源群组 = C0BNCBRL5C0 且 消息中未 @ 我'
const STEP_NAME = '判断来源群组且未@我'

/** 4.3 基础段（逐字，注意全角标点与空格） */
const baseText = (rule: string) =>
  `条件「${rule}」是一句话，程序没法照着判断。到流程编辑里把这一步的条件改成「字段 + 运算符 + 值」（从这一步能拿到的字段里选，可多条且 / 或），这句话可以留在步骤说明里`
/** 4.3 IM 触发追加段（逐字） */
const IM_SUFFIX =
  '；按来源会话、是否 @我 筛消息不用判断步骤，在触发方式「IM 消息」下面选「只接这些会话」和「与我的关系」，要拦住后面的流程就打开「命中后不再触发后面的 IM 流程」'

const step = (over: Partial<SopStepDef> = {}): SopStepDef => ({ key: 'd', name: STEP_NAME, kind: 'decide', rule: SENTENCE_RULE, ...over })
const flow = (over: Partial<SopFlow> = {}): SopFlow => ({
  id: 'sop_broken', name: '忽略 ai-octok-platform 自动消息', desc: '忽略自动消息', trigger: 'im', version: 3,
  created_at: '', updated_at: '', fields: [], steps: [step()],
  issues: [{ text: '条件是一句话', step: 0, level: 'error', code: 'rule_text' }],
  ...over,
})

// ---------------- 文案与判断口径 ----------------

describe('条件是一句话的判断与说明（TSK-0498）', () => {
  it('一句话旧规则算，能解析的旧写法与空条件不算', () => {
    expect(ruleIsSentence(SENTENCE_RULE)).toBe(true)
    expect(ruleIsSentence('status 等于 done')).toBe(false)
    expect(ruleIsSentence('  ')).toBe(false)
    expect(ruleIsSentence(undefined)).toBe(false)
  })

  it('IM 触发的说明是两段拼接，其他触发只有基础段', () => {
    expect(ruleSentenceText(SENTENCE_RULE, 'im')).toBe(baseText(SENTENCE_RULE) + IM_SUFFIX)
    expect(ruleSentenceText(SENTENCE_RULE, 'manual')).toBe(baseText(SENTENCE_RULE))
  })
})

// ---------------- 流程库卡片 / 流程详情 ----------------

type Call = { method: string; path: string }
const json = (data: unknown, status = 200, meta?: unknown) =>
  new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })

function fakeBackend(flows: SopFlow[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: u.pathname })
    if (u.pathname === '/api/sop/flows') return json(flows, 200, { total: flows.length })
    const one = u.pathname.match(/^\/api\/sop\/flows\/([^/]+)$/)
    if (one) {
      const f = flows.find((x) => x.id === one[1])
      return f ? json(f) : json({ error: { code: 'not_found', message: '流程不存在' } }, 404)
    }
    if (u.pathname === '/api/sop/runs') return json([], 200, { total: 0 })
    if (u.pathname === '/api/sop/folders') return json([])
    if (u.pathname === '/api/sop/node-types') {
      return json([
        { kind: 'decide', group: '逻辑', branching: true, required: [] },
        { kind: 'loopback', group: '逻辑', branching: false, required: [] },
      ])
    }
    // 字典、Agent 等下拉选项：空列表
    return json([])
  }))
  return { calls }
}

function renderPage(path = '/sop/library') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const LEGACY_FLOW: SopFlow = {
  id: 'sop_legacy', name: '按状态分流', desc: '', trigger: 'manual', version: 1, created_at: '', updated_at: '', fields: [],
  steps: [{ key: 'd', name: '已归档', kind: 'decide', rule: 'status 等于 done' }],
  issues: [{ text: '旧写法能解析，建议换成结构化条件', step: 0, level: 'warning', code: 'legacy_rule' }],
}
const MANUAL_FLOW: SopFlow = {
  id: 'sop_manual', name: '人工判断发不发', desc: '', trigger: 'manual', version: 1, created_at: '', updated_at: '', fields: [],
  steps: [{ key: 'd', name: '要不要发', kind: 'decide' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('流程库卡片的「需修复」', () => {
  it('一句话条件标红并写明步骤；旧规则（legacy_rule）和空条件的人工判断不标', async () => {
    fakeBackend([flow(), LEGACY_FLOW, MANUAL_FLOW])
    renderPage()
    const broken = await screen.findByRole('button', { name: /忽略 ai-octok-platform 自动消息/ })
    const tag = within(broken).getByText('需修复')
    expect(tag).toHaveAttribute('title', expect.stringContaining(STEP_NAME))
    expect(within(screen.getByRole('button', { name: /按状态分流/ })).queryByText('需修复')).not.toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /人工判断发不发/ })).queryByText('需修复')).not.toBeInTheDocument()
  })
})

describe('流程详情的修复提示', () => {
  it('列出步骤名 + 4.3 说明，点「去改流程」进编辑页；同一问题不在保存校验里再列一遍', async () => {
    const user = userEvent.setup()
    fakeBackend([flow()])
    const router = renderPage()
    await user.click(await screen.findByRole('button', { name: /忽略 ai-octok-platform 自动消息/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sop/flows/sop_broken'))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('需修复')).toBeInTheDocument()
    expect(within(alert).getByText(`${STEP_NAME}：${baseText(SENTENCE_RULE)}${IM_SUFFIX}`)).toBeInTheDocument()
    // 一句话条件交给红条，不再出现在「保存校验」里
    expect(screen.queryByRole('note', { name: '保存校验' })).not.toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: '去改流程' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sop/flows/sop_broken/edit'))
  })
})

// ---------------- 运行页失败面板 ----------------

function runOf(stepOver: Partial<SopRunStep> = {}, flowOver: Partial<SopFlow> = {}): SopRun {
  const now = new Date().toISOString()
  const f = flow(flowOver)
  return {
    id: 'spr_1', flow_id: f.id, flow_name: f.name, flow_version: f.version, flow: f, title: '忽略 · x',
    input: {}, step_through: false, stopped: false, status: 'failed', started_at: now, updated_at: now,
    steps: [{
      key: 'd', status: 'failed', input: {}, output: null, attempts: 1, log: [], error: ruleSentenceText(SENTENCE_RULE, f.trigger),
      error_code: 'rule_text', ...stepOver,
    }],
  }
}

function renderRun(run: SopRun, handlers: { onAct?: (a: unknown) => Promise<unknown>; onRerun?: () => void; onEditFlow?: () => void } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [], meta: { total: 0 } }))))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: (
    <RunView run={run} branching={() => true} busy={false}
      onBack={() => {}} onAct={handlers.onAct ?? (async () => {})} onRerun={handlers.onRerun ?? (() => {})}
      onEditFlow={handlers.onEditFlow} />
  ) }], { initialEntries: ['/sop/runs/spr_1'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

describe('运行页失败面板（TSK-0498）', () => {
  it('一句话条件失败：没有「重试」，有「去改流程」「按最新流程重新发起」「跳过这一步」', async () => {
    const user = userEvent.setup()
    const onAct = vi.fn(async () => {})
    const onRerun = vi.fn()
    const onEditFlow = vi.fn()
    renderRun(runOf(), { onAct, onRerun, onEditFlow })
    expect(await screen.findByText('执行失败')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '去改流程' }))
    expect(onEditFlow).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '按最新流程重新发起' }))
    expect(onRerun).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '跳过这一步' }))
    expect(onAct).toHaveBeenCalledWith({ kind: 'skip', step: 0 })
  })

  it('其他原因失败：仍是「重试」「跳过这一步」，没有「去改流程」', async () => {
    renderRun(runOf({ error_code: undefined, error: '模型超时' }))
    expect(await screen.findByText('执行失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳过这一步' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '去改流程' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '按最新流程重新发起' })).not.toBeInTheDocument()
  })

  it('已按最新流程重跑过的说明保持，不出现重试或去改流程', async () => {
    renderRun({ ...runOf(), relaunched_to: 'spr_2' })
    expect(await screen.findByText(/这次执行已按最新流程重跑/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '去改流程' })).not.toBeInTheDocument()
  })
})
