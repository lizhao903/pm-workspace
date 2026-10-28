import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverPlugins, disposeCommandsOf, loadPlugins, mergeModules, PLUGIN_API_VERSION, type ModuleDef } from '../plugin'
import { PluginNotice } from './PluginNotice'
import { Shell } from './Shell'

const page = (text: string) => () => Promise.resolve({ default: () => <p>{text}</p> })
const kernel: ModuleDef[] = [
  { id: 'today', label: '今日', path: 'today', load: page('今日页') },
  { id: 'tasks', label: '任务', path: 'tasks', load: page('任务页') },
  { id: 'docs', label: '文档', path: 'docs', load: page('文档页') },
  { id: 'settings', label: '设置', path: 'settings', load: page('设置页') },
]

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
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('外壳按插件清单出菜单', () => {
  beforeEach(() => {
    // 后端状态的请求一直挂着，不连后端
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
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
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
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
