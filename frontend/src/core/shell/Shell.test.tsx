import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverPlugins, loadPlugins, mergeModules, PLUGIN_API_VERSION, type ModuleDef } from '../plugin'
import { PluginNotice } from './PluginNotice'
import { Shell } from './Shell'

const kernel: ModuleDef[] = [
  { id: 'today', label: '今日', path: 'today', load: () => Promise.resolve({ default: () => <p>今日页</p> }) },
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
  render(
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
