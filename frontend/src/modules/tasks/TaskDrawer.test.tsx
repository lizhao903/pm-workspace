// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStatus, Progress, TaskRun, WorkObject } from '../../core/data'
import { objectSectionRegistry, objectSectionStore, type ObjectSectionProps } from '../../core/plugin'
import { acceptanceItems } from './mdParse'
import { TaskDrawer } from './TaskDrawer'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'doing', label: '进行中', color: '', terminal: false },
  { key: 'review', label: '待验收', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]
const at = new Date(Date.now() - 3600_000).toISOString()

function task(p: Partial<WorkObject> = {}): WorkObject {
  return {
    id: 'obj_0001', type_id: 'task', ref: 'TSK-0001', title: '导出改成分批写', body: '## 背景\n\n超时', status: 'review', priority: '', owner: '',
    owner_id: null, category_id: null, project_id: null, source: '', props: { acceptance: '- [ ] 导出不再超时\n- [ ] 前端提示进度' },
    workdir: '', due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null, created_at: at, updated_at: at,
    tags: [], link_count: 0, participants: [], ...p,
  }
}
const review: Progress = {
  id: 'pg_2', object_id: 'obj_0001', kind: 'review', text: '改了服务端分批写\n\n### 测试结果\ngo test ./... 通过',
  commits: ['abc1234def5678'], files: ['a.go'], status: 'review', actor: 'claude-code', actor_name: 'claude-code',
  session_id: 'sess-1234abcd', source: 'mcp', created_at: at,
}

function run(p: Partial<TaskRun>): TaskRun {
  return {
    id: 'run_1', object_id: 'obj_0001', workdir: '/tmp/w', prompt: '', status: 'done', exit_code: 0, output: '完成了', error: '',
    started_at: at, finished_at: at, mode: 'stream', ...p,
  }
}

function stub(t: WorkObject, extra: { progress?: Progress[]; runs?: TaskRun[] } = {}) {
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname.endsWith('/progress')) return json(extra.progress ?? (t.status === 'review' ? [review] : []))
    if (u.pathname.endsWith('/runs')) return json(extra.runs ?? [])
    if (u.pathname.startsWith('/api/runs/')) return json((extra.runs ?? []).find((r) => u.pathname.endsWith(r.id)))
    if (u.pathname === '/api/artifacts/stats') return json({ total: 0 })
    if (u.pathname === `/api/objects/${t.id}`) return json(t)
    if (u.pathname === '/api/object-types') return json([{ id: 'task', name: '任务', statuses }])
    if (u.pathname.startsWith('/api/agent/workdir')) return json({ path: '', exists: false, is_dir: false, writable: false, message: '' })
    return json([])
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

// 地址栏：标签记在地址上，测试里读出来
function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname + l.search}</output>
}
const where = () => screen.getByTestId('where').textContent

function open(t: WorkObject, opts: { url?: string; progress?: Progress[]; runs?: TaskRun[]; onClose?: () => void } = {}) {
  const fn = stub(t, opts)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.url ?? '/tasks']}>
        <Where />
        <TaskDrawer task={t} statuses={statuses} priorities={[]} projects={[]} onClose={opts.onClose ?? (() => {})} onCreated={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { drawer: screen.getByRole('dialog'), fn }
}

const tabNames = (drawer: HTMLElement) =>
  within(within(drawer).getByRole('tablist', { name: '任务详情' })).getAllByRole('tab').map((x) => x.childNodes[0].textContent)
const selected = (drawer: HTMLElement) => within(drawer).getByRole('tab', { selected: true }).childNodes[0].textContent

// 假的 SOP 插件：登记一个带标签的对象区块，区块把收到的 focus 写出来
function fakeSop() {
  return objectSectionRegistry('sop').register({
    key: 'sop-runs', typeIds: ['task'], order: 50,
    section: lazy(async () => ({ default: ({ object, focus }: ObjectSectionProps) => <section aria-label="SOP 执行">{object.ref} 定位 {focus ?? '无'}</section> })),
    tab: {
      key: 'sop', label: 'SOP', focusParam: 'sop_run',
      badge: lazy(async () => ({ default: () => <span className="seg-n">3</span> })),
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  objectSectionStore.removeOwner('sop')
})

describe('验收标准清单', () => {
  it('有 [ ] 写法只取清单项，否则取所有列表项', () => {
    expect(acceptanceItems('说明\n- [ ] 一\n- [x] 二\n- 备注')).toEqual(['一', '二'])
    expect(acceptanceItems('- 一\n1. 二')).toEqual(['一', '二'])
    expect(acceptanceItems('')).toEqual([])
  })
})

describe('待验收的任务抽屉', () => {
  it('默认停在开发任务：等你验收栏（提交说明、测试结果、提交号、验收标准清单），再是改动、产出物、进展，开发字段在最后', async () => {
    const { drawer } = open(task())
    expect(selected(drawer)).toBe('开发任务')
    // 标签上的红点：等你验收
    expect(within(drawer).getByRole('tab', { name: /开发任务/ }).querySelector('.side-dot')).toHaveAttribute('title', '等你验收')
    const bar = within(drawer).getByRole('region', { name: '等你验收' })
    expect(await within(bar).findByText('改了服务端分批写')).toBeInTheDocument()
    expect(within(bar).getByRole('heading', { name: '测试结果' })).toBeInTheDocument()
    expect(within(bar).getByText('abc1234def')).toBeInTheDocument()
    const checks = within(bar).getByRole('group', { name: '对照验收标准' })
    expect(within(checks).getAllByRole('checkbox').map((c) => c.parentElement?.textContent)).toEqual(['导出不再超时', '前端提示进度'])

    // 区块顺序
    const order = [bar, ...['改动', '产出物', '进展'].map((n) => within(drawer).getByRole('region', { name: n })), within(drawer).getByRole('group', { name: '开发' })]
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // 执行记录在自己的标签里，任务字段在基础信息里
    expect(within(drawer).queryByRole('region', { name: '执行记录' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('radiogroup', { name: '状态' })).not.toBeInTheDocument()

    await userEvent.click(within(drawer).getByRole('tab', { name: '基础信息' }))
    expect(within(drawer).getByRole('radiogroup', { name: '状态' })).toBeInTheDocument()
    expect(within(drawer).getByDisplayValue('导出改成分批写')).toBeInTheDocument()
    // 正文默认预览，完整显示
    const bodyMode = within(drawer).getByRole('group', { name: '正文的显示方式' })
    expect(within(bodyMode).getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(drawer).getByRole('heading', { name: '背景' }).closest('.md-preview')).toHaveClass('md-full')
    expect(where()).toBe('/tasks?tab=info')
  })

  it('勾选只在本地，不发请求', async () => {
    const { drawer, fn } = open(task())
    const bar = within(drawer).getByRole('region', { name: '等你验收' })
    const box = within(bar).getAllByRole('checkbox')[0]
    const before = fn.mock.calls.length
    await userEvent.click(box)
    expect(box).toBeChecked()
    expect(within(bar).getByText(/已勾 1 \/ 2/)).toBeInTheDocument()
    expect(fn.mock.calls.slice(before).some(([, init]) => init?.method && init.method !== 'GET')).toBe(false)
  })
})

describe('任务详情的标签', () => {
  it('普通任务只有基础信息：字段、提醒都在里面，「设为开发任务」后出现开发任务和执行记录并切过去', async () => {
    const { drawer } = open(task({ status: 'doing', props: {} }))
    await waitFor(() => expect(tabNames(drawer)).toEqual(['基础信息']))
    expect(selected(drawer)).toBe('基础信息')
    expect(within(drawer).getByRole('radiogroup', { name: '状态' })).toBeInTheDocument()
    expect(within(drawer).getByRole('region', { name: '提醒' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('group', { name: '开发' })).not.toBeInTheDocument()
    const bodyMode = within(drawer).getByRole('group', { name: '正文的显示方式' })
    expect(within(bodyMode).getByRole('button', { name: '编辑' })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(within(drawer).getByRole('button', { name: /设为开发任务/ }))
    expect(tabNames(drawer)).toEqual(['基础信息', '开发任务', '执行记录'])
    expect(selected(drawer)).toBe('开发任务')
    expect(within(drawer).getByRole('group', { name: '开发' })).toBeInTheDocument()
    expect(where()).toBe('/tasks?tab=dev')
  })

  it('有开发字段的任务：开发任务、执行记录标签；执行记录带条数，有在跑的带绿点', async () => {
    const { drawer } = open(task({ status: 'doing' }), { runs: [run({ id: 'run_a', status: 'running', finished_at: null }), run({ id: 'run_b' })] })
    expect(tabNames(drawer)).toEqual(['基础信息', '开发任务', '执行记录'])
    expect(selected(drawer)).toBe('基础信息')
    const runsTab = within(drawer).getByRole('tab', { name: /执行记录/ })
    await waitFor(() => expect(within(runsTab).getByText('2')).toHaveClass('seg-n'))
    expect(runsTab.querySelector('.tab-light')).toHaveAttribute('title', '有执行在跑')
    expect(within(drawer).getByRole('tab', { name: /开发任务/ }).querySelector('.side-dot')).toBeNull()

    await userEvent.click(runsTab)
    expect(within(drawer).getByRole('region', { name: '执行记录' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('radiogroup', { name: '状态' })).not.toBeInTheDocument()
    expect(where()).toBe('/tasks?tab=runs')
  })

  it('有执行记录但没填开发字段的也算开发任务', async () => {
    const { drawer } = open(task({ status: 'doing', props: {} }), { runs: [run({})] })
    await waitFor(() => expect(tabNames(drawer)).toEqual(['基础信息', '开发任务', '执行记录']))
    expect(within(drawer).queryByRole('button', { name: /设为开发任务/ })).not.toBeInTheDocument()
  })

  it('SOP 插件在跑时多一个 SOP 标签（插件给的计数），排在开发任务和执行记录之间；插件停了标签消失', async () => {
    const reg = fakeSop()
    const { drawer } = open(task({ status: 'doing' }))
    expect(tabNames(drawer)).toEqual(['基础信息', '开发任务', 'SOP', '执行记录'])
    const sopTab = within(drawer).getByRole('tab', { name: /SOP/ })
    expect(await within(sopTab).findByText('3')).toBeInTheDocument()
    await userEvent.click(sopTab)
    expect(await within(drawer).findByRole('region', { name: 'SOP 执行' })).toHaveTextContent('TSK-0001 定位 无')
    expect(where()).toBe('/tasks?tab=sop')

    act(() => reg.dispose())
    expect(tabNames(drawer)).toEqual(['基础信息', '开发任务', '执行记录'])
    // 停在被撤掉的标签上时回默认
    expect(selected(drawer)).toBe('基础信息')
  })

  it('地址上的 ?tab= 打开时就停在那个标签；不认识的标签回默认', async () => {
    const { drawer } = open(task({ status: 'doing' }), { url: '/tasks?status=all&tab=dev' })
    expect(selected(drawer)).toBe('开发任务')
    expect(within(drawer).getByRole('group', { name: '开发' })).toBeInTheDocument()
  })

  it('不在跑的插件标签回默认', async () => {
    const { drawer } = open(task({ status: 'doing' }), { url: '/tasks?tab=sop' })
    expect(tabNames(drawer)).not.toContain('SOP')
    expect(selected(drawer)).toBe('基础信息')
  })

  it('跳到某次执行（?run=）：切到执行记录，那一条展开高亮；切别的标签后定位参数去掉', async () => {
    const { drawer } = open(task({ status: 'doing', props: {} }), {
      url: '/tasks?t=obj_0001&run=run_b', runs: [run({ id: 'run_a' }), run({ id: 'run_b', output: '' })],
    })
    // 普通任务也照样显示执行记录标签，链接不落空
    expect(selected(drawer)).toBe('执行记录')
    const row = await waitFor(() => {
      const el = drawer.querySelector('[data-run="run_b"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(row).toHaveClass('lit')
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(within(row).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'true')
    expect(drawer.querySelector('[data-run="run_a"]')).not.toHaveClass('lit')

    await userEvent.click(within(drawer).getByRole('tab', { name: '基础信息' }))
    expect(where()).toBe('/tasks?t=obj_0001&tab=info')
  })

  it('跳到某次 SOP 执行（?sop_run=）：切到 SOP 标签，把要定位的执行交给插件区块', async () => {
    fakeSop()
    const { drawer } = open(task({ status: 'doing' }), { url: '/tasks?sop_run=spr_9' })
    expect(selected(drawer)).toBe('SOP')
    expect(await within(drawer).findByRole('region', { name: 'SOP 执行' })).toHaveTextContent('定位 spr_9')
  })

  it('关闭抽屉时把标签和定位参数从地址上去掉，别的参数留着', async () => {
    const onClose = vi.fn()
    const { drawer } = open(task({ status: 'doing' }), { url: '/tasks?status=all&tab=runs&run=run_x', onClose })
    expect(selected(drawer)).toBe('执行记录')
    await userEvent.click(within(drawer).getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
    expect(where()).toBe('/tasks?status=all')
  })

  it('保存时标题为空：切回基础信息标出来', async () => {
    const { drawer } = open(task({ status: 'doing' }), { url: '/tasks?tab=dev' })
    await userEvent.click(within(drawer).getByRole('tab', { name: '基础信息' }))
    await userEvent.clear(within(drawer).getByDisplayValue('导出改成分批写'))
    await userEvent.click(within(drawer).getByRole('tab', { name: /开发任务/ }))
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    expect(selected(drawer)).toBe('基础信息')
    expect(within(drawer).getByText('必填')).toBeInTheDocument()
  })
})

describe('正文高度随内容撑开', () => {
  it('编辑框按内容高度设高、不出内部滚动条，粘贴长文跟着变高；最小高度是 rows', async () => {
    let content = 60
    const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content)
    try {
      const { drawer } = open(task({ status: 'doing', body: '短' }))
      const box = within(drawer).getByRole('textbox', { name: '正文' }) as HTMLTextAreaElement
      expect(box).toHaveClass('grow')
      expect(box.rows).toBe(6)
      // jsdom 里边框是 0：高度就是内容高度
      expect(box.style.height).toBe('60px')
      content = 900
      await userEvent.click(box)
      await userEvent.paste('很长的一段\n'.repeat(40))
      expect(box.style.height).toBe('900px')
    } finally {
      spy.mockRestore()
    }
  })
})
