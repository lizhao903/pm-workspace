// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_STATUS_LABEL, releaseReportUrl, releaseSummary, releaseTone, type Release, type ReleaseStep } from '../../core/data'
import { ReleaseBlock } from './ReleaseBlock'

// 任务详情「最近一次发布」（AUTO-10）：等审批时写明审批前不动生产、能作废；冒烟没过写明已回滚；已上线带版本和更新日志
const st = (over: Partial<ReleaseStep> = {}): ReleaseStep => ({
  key: 'version', label: '版本号与更新日志', phase: 'prepare', command: 'make version', dir: '/w', timeout_sec: 300, status: 'passed', exit_code: 0,
  duration_ms: 800, timed_out: false, output: 'v1.2.0', error: '', started_at: '2026-11-04T10:00:00Z', finished_at: '2026-11-04T10:00:01Z', ...over,
})
const pending = (key: ReleaseStep['key'], label: string): ReleaseStep =>
  st({ key, label, phase: 'deploy', status: 'pending', exit_code: null, duration_ms: 0, output: '', started_at: null, finished_at: null })

const rel = (over: Partial<Release> = {}): Release => ({
  id: 'rel_1', task_id: 'obj_t', task_ref: 'TSK-1', project_id: 'obj_p', worktree_id: 'wt_1', workdir: '/w', status: 'prepared', phase: 'prepare',
  version: 'v1.2.0', changelog: '- 导出加 CSV', failed_step: '', error: '', rollback_state: '', run_dir: '/data/releases/x', report_path: '/data/releases/x/report.md',
  artifact_ids: [], source: 'sop', approved_at: null, approved_by: '', sop_run_id: 'spr_1', started_at: '2026-11-04T10:00:00Z', finished_at: null, updated_at: '',
  steps: [st(), st({ key: 'package', label: '打包', command: 'make pack' }), pending('preflight', '发布前检查'), pending('release', '发布'),
    pending('prod_smoke', '线上冒烟'), pending('rollback', '回滚')],
  ...over,
})

function backend(rows: Release[]) {
  const calls: { method: string; path: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: u.pathname })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
    if (u.pathname === '/api/projects/releases') return json(rows)
    if (u.pathname === '/api/projects/releases/runs/rel_1/stop') {
      rows = [{ ...rows[0], status: 'cancelled', error: '手动作废，没有上线' }]
      return json(rows[0])
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: u.pathname } }), { status: 404 })
  }))
  return calls
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ReleaseBlock taskId="obj_t" poll={false} /></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('releaseSummary', () => {
  it('等审批写明审批前不动生产', () => {
    expect(releaseSummary(rel())).toBe('版本 v1.2.0 已打包。等上线审批：审批前不跑发布前检查、发布、线上冒烟')
    expect(releaseTone('prepared')).toBe('warn')
  })
  it('冒烟没过写明回滚情况', () => {
    const r = rel({ status: 'rolled_back', phase: 'deploy', failed_step: 'prod_smoke', error: '线上冒烟：退出码 1', rollback_state: 'done' })
    expect(releaseSummary(r)).toBe('线上冒烟：退出码 1；已自动回滚')
    expect(releaseSummary({ ...r, status: 'rollback_failed', rollback_state: 'failed' })).toContain('自动回滚也没成功')
    expect(releaseSummary({ ...r, status: 'failed', rollback_state: 'unavailable' })).toContain('没有回滚命令')
    expect(releaseSummary({ ...r, status: 'failed', failed_step: 'preflight', error: '发布前检查：退出码 1', rollback_state: '' })).toBe('发布前检查：退出码 1；还没动生产')
    expect(releaseTone('rolled_back')).toBe('bad')
  })
  it('在跑写正在哪一步，已上线带版本', () => {
    const r = rel({ status: 'running', phase: 'deploy', steps: [st({ key: 'release', label: '发布', phase: 'deploy', status: 'running' })] })
    expect(releaseSummary(r)).toBe('正在发布')
    expect(releaseSummary(rel({ status: 'released', phase: 'deploy' }))).toBe('版本 v1.2.0 已上线，线上冒烟通过')
    expect(RELEASE_STATUS_LABEL.cancelled).toBe('已作废')
    expect(releaseReportUrl('rel 1')).toBe('/api/projects/releases/runs/rel%201/report')
  })
})

describe('ReleaseBlock', () => {
  it('没有发布记录时不显示', async () => {
    const calls = backend([])
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(container.querySelector('[data-section="release"]')).toBeNull()
  })

  it('等审批：按审批前、审批后分组，审批后的步骤还没跑，能作废', async () => {
    const calls = backend([rel()])
    mount()
    const box = await screen.findByRole('group', { name: '最近一次发布' })
    expect(within(box).getByText('等上线审批')).toBeTruthy()
    expect(within(box).getByText(/审批前不跑发布前检查、发布、线上冒烟/)).toBeTruthy()
    expect(within(box).getByText('审批前')).toBeTruthy()
    expect(within(box).getByText('审批后')).toBeTruthy()
    expect(within(box).getAllByText('等着')).toHaveLength(4)
    expect(within(box).queryByRole('button', { name: /批准/ })).toBeNull()
    await userEvent.click(within(box).getByRole('button', { name: '作废' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/releases/runs/rel_1/stop')).toBe(true))
    expect(await within(box).findByText('已作废')).toBeTruthy()
  })

  it('冒烟没过：已回滚，摘要写明', async () => {
    backend([rel({ status: 'rolled_back', phase: 'deploy', failed_step: 'prod_smoke', error: '线上冒烟：退出码 1', rollback_state: 'done',
      approved_at: '2026-11-04T10:05:00Z', approved_by: 'sop:spr_1', finished_at: '2026-11-04T10:06:00Z',
      steps: [st(), st({ key: 'prod_smoke', label: '线上冒烟', phase: 'deploy', status: 'failed', exit_code: 1, error: '退出码 1' }),
        st({ key: 'rollback', label: '回滚', phase: 'deploy' })] })])
    mount()
    const box = await screen.findByRole('group', { name: '最近一次发布' })
    expect(within(box).getByRole('alert').textContent).toBe('线上冒烟：退出码 1；已自动回滚')
    expect(within(box).getByText(/SOP 人工审批/)).toBeTruthy()
    expect(within(box).queryByRole('button')).toBeNull()
    expect(within(box).getByRole('link', { name: '看报告' }).getAttribute('href')).toBe('/api/projects/releases/runs/rel_1/report')
  })

  it('已上线：版本、更新日志', async () => {
    backend([rel({ status: 'released', phase: 'deploy', approved_at: '2026-11-04T10:05:00Z', approved_by: 'api' })])
    mount()
    const box = await screen.findByRole('group', { name: '最近一次发布' })
    expect(within(box).getByText('已上线')).toBeTruthy()
    expect(within(box).getByText('v1.2.0', { selector: 'code' })).toBeTruthy()
    expect(within(box).getByText('更新日志')).toBeTruthy()
    expect(within(box).getByText('- 导出加 CSV')).toBeTruthy()
  })
})
