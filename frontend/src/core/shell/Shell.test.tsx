import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataKeys } from '../data'
import { deactivatePlugin, discoverPlugins, disposeCommandsOf, loadPlugins, mergeModules, PLUGIN_API_VERSION, type ModuleDef } from '../plugin'
import { module as settingsModule } from '../../modules/settings'
import { module as todayModule } from '../../modules/today'
import { ModuleRoute } from './ModuleRoute'
import { PluginNotice } from './PluginNotice'
import { Shell } from './Shell'

const page = (text: string) => () => Promise.resolve({ default: () => <p>{text}</p> })
const kernel: ModuleDef[] = [
  { id: 'today', label: '今日', path: 'today', load: page('今日页') },
  { id: 'tasks', label: '任务', path: 'tasks', load: page('任务页') },
  { id: 'docs', label: '文档', path: 'docs', load: page('文档页') },
  { id: 'settings', label: '设置', path: 'settings', load: page('设置页') },
]

// 不连后端：工作台列表立刻失败（菜单回退到默认分组），别的请求一直挂着
const noWorkspaces = (url: RequestInfo | URL) =>
  String(url).includes('/api/workspaces') ? Promise.resolve(new Response('{}', { status: 500 })) : new Promise<Response>(() => {})
const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

// 和 main.tsx 一样的接法：内核模块加上按启用列表加载出来的插件模块
async function renderApp(enabled: string[], at = '/today') {
  const r = await loadPlugins(discoverPlugins(), { enabled, apiVersion: PLUGIN_API_VERSION })
  const modules = mergeModules(kernel, r.modules, r.problems)
  const router = createMemoryRouter(
    [{
      path: '/',
      element: <Shell modules={modules} />,
      children: modules.map((m) => ({ path: m.path + '/*', lazy: async () => ({ Component: (await m.load()).default }) })),
    }],
    { initialEntries: [at] },
  )
  return render(
    <QueryClientProvider client={testClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('外壳按插件清单出菜单', () => {
  beforeEach(() => {
    // 后端状态的请求一直挂着，不连后端
    vi.stubGlobal('fetch', vi.fn(noWorkspaces))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    disposeCommandsOf('hello')
  })

  it('hello 在启用列表里：菜单出现，点进去是插件页面', async () => {
    await renderApp(['hello'])
    const link = await screen.findByRole('link', { name: '示例插件' })
    await userEvent.click(link)
    expect(await screen.findByText(/这个页面来自示例插件 hello/)).toBeInTheDocument()
  })

  it('hello 不在启用列表里：菜单没有它', async () => {
    await renderApp([])
    expect(await screen.findByRole('link', { name: '今日' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '示例插件' })).not.toBeInTheDocument()
  })
})

describe('PluginNotice', () => {
  it('没有问题时不渲染', () => {
    const { container } = render(<PluginNotice problems={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('列出没加载的插件和原因', async () => {
    render(<PluginNotice problems={[{ id: 'aa', name: '甲', reasons: ['depends.nope 依赖的插件不存在'] }, { id: 'ghost', reasons: ['没有这个插件'] }]} />)
    await userEvent.click(screen.getByText('2 个插件没有加载'))
    expect(screen.getByText('甲（aa）')).toBeVisible()
    expect(screen.getByText('depends.nope 依赖的插件不存在')).toBeVisible()
    expect(screen.getByText('ghost')).toBeVisible()
  })
})

describe('外壳的菜单和命令面板', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(noWorkspaces))
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    disposeCommandsOf('hello')
  })

  it('有标题的分组可折叠，重新打开后折叠状态还在', async () => {
    const first = await renderApp(['hello'])
    const title = await screen.findByRole('button', { name: '工作' })
    expect(title).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(title)
    expect(title).toHaveAttribute('aria-expanded', 'false')
    first.unmount()
    disposeCommandsOf('hello')
    await renderApp(['hello'])
    expect(await screen.findByRole('button', { name: '工作' })).toHaveAttribute('aria-expanded', 'false')
    // 没标题的组（今日）没有折叠按钮，插件模块进「未分组」，设置在底部
    expect(screen.getByRole('button', { name: '未分组' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '设置' })).toBeInTheDocument()
  })

  it('侧栏收起后刷新还是收起的', async () => {
    const first = await renderApp([])
    await userEvent.click(await screen.findByRole('button', { name: '收起菜单' }))
    expect(localStorage.getItem('pmw-side')).toBe('collapsed')
    first.unmount()
    await renderApp([])
    expect(await screen.findByRole('button', { name: '展开菜单' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('Cmd/Ctrl+K 打开命令面板，搜到示例插件注册的命令，回车执行', async () => {
    await renderApp(['hello'])
    await screen.findByRole('link', { name: '今日' })
    await userEvent.keyboard('{Meta>}k{/Meta}')
    const input = await screen.findByRole('combobox', { name: '搜索和命令' })
    expect(input).toHaveFocus()
    await userEvent.type(input, 'hello')
    expect(screen.getByRole('option', { name: /打开示例插件/ })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: '搜索和命令' })).not.toBeInTheDocument()
    expect(await screen.findByText(/这个页面来自示例插件 hello/)).toBeInTheDocument()

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(await screen.findByRole('dialog', { name: '搜索和命令' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '搜索和命令' })).not.toBeInTheDocument()
  })

  it('命令面板没输入时列出操作和跳转，上下键移动', async () => {
    await renderApp([])
    // 侧栏和顶栏（窄屏）各有一个入口
    await userEvent.click((await screen.findAllByRole('button', { name: '搜索和命令' }))[0])
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toContain('任务功能模块')
    expect(opts[0]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('窄屏菜单按钮打开抽屉，Esc 关上', async () => {
    await renderApp([])
    const btn = await screen.findByRole('button', { name: '打开菜单' })
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(btn).toHaveFocus()
  })
})

describe('插件的设置分节和今日卡片（CORE-02b）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(noWorkspaces))
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    deactivatePlugin('hello')
  })

  // 真实的今日、设置页，路由和 createAppRouter 一样包一层 ModuleRoute
  async function renderReal(enabled: string[], at: string) {
    const r = await loadPlugins(discoverPlugins(), { enabled, apiVersion: PLUGIN_API_VERSION })
    const modules = mergeModules([todayModule, settingsModule], r.modules, r.problems)
    const router = createMemoryRouter(
      [{
        path: '/',
        element: <Shell modules={modules} />,
        children: modules.map((m) => ({
          path: m.path + '/*',
          lazy: async () => {
            const Page = (await m.load()).default
            return { Component: () => <ModuleRoute module={m} page={Page} home="/today" /> }
          },
        })),
      }],
      { initialEntries: [at] },
    )
    render(
      <QueryClientProvider client={testClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    return router
  }

  it('hello 启用：今日页出卡片，设置页「插件」分组里有它的分节；停用后都消失', async () => {
    await renderReal(['hello'], '/today')
    const card = await screen.findByRole('region', { name: '示例插件' })
    expect(card).toHaveTextContent('这张卡片来自示例插件 hello')

    await userEvent.click(await screen.findByRole('link', { name: '设置' }))
    const nav = await screen.findByRole('navigation', { name: '设置' })
    expect(nav).toHaveTextContent('插件')
    await userEvent.click(within(nav).getByRole('button', { name: /示例插件/ }))
    expect(await screen.findByText(/这一节来自示例插件 hello/)).toBeInTheDocument()
    expect(screen.getByText('来自插件「示例插件」')).toBeInTheDocument()

    // 停在插件分节上停用：分节从菜单去掉，页面回到第一节
    act(() => { deactivatePlugin('hello') })
    expect(within(nav).queryByRole('button', { name: /示例插件/ })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '工作台与模块' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '示例插件' })).not.toBeInTheDocument()

    await userEvent.click(await screen.findByRole('link', { name: '今日' }))
    await screen.findByRole('heading', { name: '今日' })
    expect(screen.queryByRole('region', { name: '示例插件' })).not.toBeInTheDocument()
  })

  it('hello 不启用：今日页没有卡片，设置页没有插件分组', async () => {
    await renderReal([], '/settings')
    const nav = await screen.findByRole('navigation', { name: '设置' })
    // 内核自己有「插件」管理分节（CORE-09），这里只看插件注册的分节
    expect(within(nav).queryByRole('button', { name: /示例插件/ })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('link', { name: '今日' }))
    await screen.findByRole('heading', { name: '今日' })
    expect(screen.queryByRole('region', { name: '示例插件' })).not.toBeInTheDocument()
  })

  it('停在插件页面上停用：送回默认模块', async () => {
    const router = await renderReal(['hello'], '/hello')
    expect(await screen.findByText(/这个页面来自示例插件 hello/)).toBeInTheDocument()
    act(() => { deactivatePlugin('hello') })
    expect(await screen.findByRole('heading', { name: '今日' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/today')
  })

  it('内核模块在界面上没有停用入口', async () => {
    await renderReal(['hello'], '/settings')
    await screen.findByRole('navigation', { name: '设置' })
    expect(screen.queryByRole('button', { name: /停用/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/停用/)).not.toBeInTheDocument()
  })
})

describe('工作台切换（CORE-10b）', () => {
  const ws = (id: string, name: string, groups: [string, string[]][], plugins: string[] = []) => ({
    id, name, role: name, description: '', home: groups[0][1][0], mark: null, plugins, template: id, position: 0, created_at: '', updated_at: '',
    groups: groups.map(([n, m], i) => ({ id: `g${i + 1}`, name: n, modules: m, collapsed: false })), modules: groups.flatMap(([, m]) => m),
  })
  const list = [
    ws('ws_a', '甲工作台', [['', ['today']], ['工作', ['tasks', 'library']]]),
    ws('ws_b', '交易工作台', [['', ['tasks']], ['行情', ['markets']], ['资料', ['library']]], ['markets']),
  ]
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    localStorage.clear()
    fetchMock = vi.fn((url: RequestInfo | URL) => {
      const u = String(url)
      const body = u.includes('/api/workspaces') ? list : u.includes('/api/plugins') ? [] : null
      if (!body) return new Promise<Response>(() => {})
      return Promise.resolve(new Response(JSON.stringify({ data: body, meta: { total: body.length } }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('菜单按当前工作台出；切到缺插件的工作台先提示「尚未提供」，先不装照样切过去，只换菜单不动任务列表的缓存', async () => {
    const qc = testClient()
    const taskKey = dataKeys.objects.listAll({ type: ['task'] })
    qc.setQueryData(taskKey, [{ id: 'obj_1', title: '一条任务' }])
    const router = createMemoryRouter(
      [{ path: '/', element: <Shell modules={kernel} />, children: kernel.map((m) => ({ path: m.path + '/*', lazy: async () => ({ Component: (await m.load()).default }) })) }],
      { initialEntries: ['/today'] },
    )
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)

    const side = await screen.findByRole('complementary', { name: '一级菜单' })
    expect(await within(side).findByRole('button', { name: '工作' })).toBeInTheDocument()
    expect(within(side).getAllByRole('link').map((a) => a.textContent)).toEqual(['今日', '任务', '文档', '设置'])

    await userEvent.click(screen.getByRole('button', { name: '一人之下，当前工作台：甲工作台' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /交易工作台/ }))
    const dialog = await screen.findByRole('alertdialog', { name: '「交易工作台」需要的插件还没装好' })
    expect(dialog).toHaveTextContent('交易套件（行情）：尚未提供')
    // 尚未提供的装不了，不给去插件管理的入口
    expect(within(dialog).queryByRole('button', { name: '去插件管理安装' })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '先不装，照样切换' }))

    // 缺插件的「行情」不出现；默认模块是任务，打开它
    expect(await within(side).findByRole('button', { name: '资料' })).toBeInTheDocument()
    expect(within(side).getAllByRole('link').map((a) => a.textContent)).toEqual(['任务', '文档', '设置'])
    expect(router.state.location.pathname).toBe('/tasks')
    expect(localStorage.getItem('pmw-workspace')).toBe('ws_b')
    expect(qc.getQueryState(taskKey)?.isInvalidated).toBe(false)
    expect(qc.getQueryData(taskKey)).toEqual([{ id: 'obj_1', title: '一条任务' }])
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/objects'))).toBe(false)
  })
})
