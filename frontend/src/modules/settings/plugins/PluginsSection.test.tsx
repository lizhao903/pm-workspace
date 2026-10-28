import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginInfo } from '../../../core/data'
import { PluginsSection } from './PluginsSection'

const plugin = vi.hoisted(() => ({
  activatePlugin: vi.fn(async () => ({ ok: true as const, reload: false })),
  deactivatePlugin: vi.fn(() => true),
}))
// 前端的插件加载另有测试（core/plugin），这里只看页面调没调
vi.mock('../../../core/plugin', async (orig) => ({ ...(await orig<object>()), ...plugin }))

function info(p: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: p.id, description: '', version: '0.1.0', installed: false, enabled: false, running: false, installed_version: '',
    upgradable: false, installed_at: null, depends: {}, optional_depends: {}, dependents: [], permissions: [],
    permissions_confirmed: [], permissions_at: null, pending_migrations: 0, jobs: 0, provides: { modules: [p.id] }, ...p,
  }
}

type Call = { method: string; path: string; body: unknown }

// 打桩后端：列表、安装、启停、卸载按契约改状态；disable 被依赖时回 409
function stub(rows: PluginInfo[]) {
  const calls: Call[] = []
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (path === '/api/plugins') return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }))
    const m = /^\/api\/plugins\/([^/]+)\/(\w+)$/.exec(path)!
    const [id, action] = [m[1], m[2]]
    const set = (patch: Partial<PluginInfo>) => {
      rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
      return rows.find((r) => r.id === id)!
    }
    switch (action) {
      case 'install':
        return ok({ plugin: set({ installed: true, permissions_confirmed: body.permissions }), backup: null })
      case 'enable':
        return ok(set({ enabled: true, running: true }))
      case 'disable': {
        const deps = rows.filter((r) => r.enabled && id in r.depends).map((r) => r.id)
        if (deps.length) {
          return new Response(JSON.stringify({ error: { code: 'conflict', message: `插件 ${id} 被这些已启用的插件依赖，要先停用它们：${deps.join(', ')}`, dependents: deps } }), { status: 409 })
        }
        return ok(set({ enabled: false, running: false }))
      }
      case 'uninstall': {
        const plugin = set({ installed: false })
        return ok(body.delete_data
          ? { plugin, data_deleted: true, backup: '/data/backups/pm-20261029-004000.db', dropped_tables: ['projects_items'] }
          : { plugin, data_deleted: false, backup: null, dropped_tables: [] })
      }
    }
    return new Response('{}', { status: 404 })
  }))
  return calls
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => [c.path, c.body])

function renderPage(reload = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><PluginsSection reload={reload} /></QueryClientProvider>)
  return reload
}

const cardOf = async (id: string) => (await screen.findByText((_, el) => el?.getAttribute('data-plugin') === id)) as HTMLElement

beforeEach(() => {
  plugin.activatePlugin.mockClear()
  plugin.deactivatePlugin.mockClear()
  try { sessionStorage.clear() } catch { /* 无存储 */ }
})
afterEach(() => { vi.unstubAllGlobals() })

describe('插件管理', () => {
  it('分已安装、可安装两组；卡片点开详情抽屉，显示版本、依赖、权限、扩展点', async () => {
    stub([
      info({ id: 'projects', name: '项目', installed: true, enabled: true, running: true, dependents: ['video'] }),
      info({ id: 'video', name: '视频创作', depends: { projects: '>=0.1.0 <1.0.0' }, permissions: ['network:media-platforms', 'secrets:media'],
        provides: { modules: ['video'], today_cards: ['video_due'] } }),
    ])
    renderPage()
    const installed = await screen.findByRole('region', { name: '已安装' })
    expect(within(installed).getByText('项目')).toBeInTheDocument()
    const available = screen.getByRole('region', { name: '可安装' })
    expect(within(available).getByText('视频创作')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '查看「视频创作」详情' }))
    const drawer = screen.getByRole('dialog', { name: '插件「视频创作」' })
    expect(within(drawer).getByText('>=0.1.0 <1.0.0', { exact: false })).toBeInTheDocument()
    expect(within(drawer).getByText('访问视频平台')).toBeInTheDocument()
    expect(within(drawer).getByText('取凭证保险箱里「media」范围的凭证')).toBeInTheDocument()
    expect(within(drawer).getByText('今日卡片')).toBeInTheDocument()
    expect(within(drawer).getByText('video_due')).toBeInTheDocument()
  })

  it('安装：弹窗列权限，高风险要单独勾选；确认后装好接着启用，并加载前端；启动时没路由的整页重新加载', async () => {
    plugin.activatePlugin.mockResolvedValueOnce({ ok: true, reload: true })
    const calls = stub([info({ id: 'term', name: '终端', permissions: ['network:localhost', 'process:spawn'] })])
    const reload = renderPage()
    await userEvent.click(within(await cardOf('term')).getByRole('button', { name: '安装' }))
    const dlg = screen.getByRole('alertdialog', { name: '安装「终端」' })
    expect(within(dlg).getByText('访问 127.0.0.1 和本机域名')).toBeInTheDocument()
    expect(within(dlg).getByText('高风险')).toBeInTheDocument()
    const confirm = within(dlg).getByRole('button', { name: '确认并安装' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dlg).getByRole('checkbox', { name: '我了解风险，授予这项权限' }))
    await userEvent.click(confirm)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(writes(calls)).toEqual([
      ['/api/plugins/term/install', { permissions: ['network:localhost', 'process:spawn'] }],
      ['/api/plugins/term/enable', {}],
    ])
    expect(plugin.activatePlugin).toHaveBeenCalledWith('term')
    expect(sessionStorage.getItem('pmw-plugin-notice')).toBe('已启用「终端」，菜单里已出现')
  })

  it('没有权限的插件照样弹确认；启动时就有路由的不重新加载，直接提示', async () => {
    stub([info({ id: 'projects', name: '项目' })])
    const reload = renderPage()
    await userEvent.click(within(await cardOf('projects')).getByRole('button', { name: '安装' }))
    const dlg = screen.getByRole('alertdialog', { name: '安装「项目」' })
    expect(within(dlg).getByText('这个插件不需要额外权限。')).toBeInTheDocument()
    await userEvent.click(within(dlg).getByRole('button', { name: '确认并安装' }))
    expect(await screen.findByText('已启用「项目」，菜单里已出现')).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('停用被依赖的插件：列出依赖方，不能单独停用；确认「一起停用」先停依赖方', async () => {
    const calls = stub([
      info({ id: 'projects', name: '项目', installed: true, enabled: true, running: true, dependents: ['video'] }),
      info({ id: 'video', name: '视频创作', installed: true, enabled: true, running: true, depends: { projects: '>=0.1.0 <1.0.0' } }),
      info({ id: 'im', name: 'IM 消息', installed: true, enabled: true, running: true, optional_depends: { projects: '>=0.1.0 <1.0.0' } }),
    ])
    renderPage()
    const card = await cardOf('projects')
    expect(within(card).getByText('被「视频创作」依赖')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: '停用' }))
    const dlg = screen.getByRole('alertdialog', { name: '停用「项目」' })
    expect(within(dlg).getByText('「视频创作」')).toBeInTheDocument()
    expect(within(dlg).getByText(/不能单独停用/)).toBeInTheDocument()
    expect(within(dlg).getByText('「IM 消息」里和「项目」有关的功能会暂时不可用')).toBeInTheDocument()
    expect(within(dlg).queryByRole('button', { name: '停用' })).toBeNull()
    await userEvent.click(within(dlg).getByRole('button', { name: '一起停用' }))
    expect(await screen.findByText('已停用「项目」，连同「视频创作」，菜单里已去掉，数据都保留')).toBeInTheDocument()
    expect(writes(calls)).toEqual([['/api/plugins/video/disable', {}], ['/api/plugins/projects/disable', {}]])
    expect(plugin.deactivatePlugin.mock.calls).toEqual([['video'], ['projects']])
  })

  it('后端说被依赖（列表过时）时提示依赖方，前端不撤', async () => {
    // 列表里没写 dependents，后端按真实状态拒绝
    stub([
      info({ id: 'projects', name: '项目', installed: true, enabled: true, running: true }),
      info({ id: 'video', name: '视频创作', installed: true, enabled: true, running: true, depends: { projects: '^0.1.0' } }),
    ])
    renderPage()
    await userEvent.click(within(await cardOf('projects')).getByRole('button', { name: '停用' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '停用' }))
    expect(await screen.findByText(/停用「项目」失败：.*要先停用它们：video/)).toBeInTheDocument()
    expect(plugin.deactivatePlugin).not.toHaveBeenCalled()
  })

  it('卸载默认保留数据', async () => {
    const calls = stub([info({ id: 'projects', name: '项目', installed: true })])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '查看「项目」详情' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: '插件「项目」' })).getByRole('button', { name: '卸载' }))
    const dlg = screen.getByRole('alertdialog', { name: '卸载「项目」' })
    expect(within(dlg).getByRole('radio', { name: /保留数据/ })).toBeChecked()
    await userEvent.click(within(dlg).getByRole('button', { name: '卸载' }))
    expect(await screen.findByText('已卸载「项目」，数据保留，重新安装后接着用')).toBeInTheDocument()
    expect(writes(calls)).toEqual([['/api/plugins/projects/uninstall', { delete_data: false, confirm: '' }]])
  })

  it('删数据卸载：二次确认要输入插件名，完成后显示快照位置', async () => {
    const calls = stub([info({ id: 'projects', name: '项目', installed: true })])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '查看「项目」详情' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: '插件「项目」' })).getByRole('button', { name: '卸载' }))
    await userEvent.click(screen.getByRole('radio', { name: /删除数据/ }))
    await userEvent.click(screen.getByRole('button', { name: '下一步' }))
    const dlg = screen.getByRole('alertdialog', { name: '删除「项目」的数据' })
    expect(within(dlg).getByText('表名以 projects_ 开头的表（索引随表删）')).toBeInTheDocument()
    expect(within(dlg).getByText(/自动备份/)).toBeInTheDocument()
    const go = within(dlg).getByRole('button', { name: '删除数据并卸载' })
    expect(go).toBeDisabled()
    await userEvent.type(within(dlg).getByRole('textbox'), '项')
    expect(go).toBeDisabled()
    await userEvent.type(within(dlg).getByRole('textbox'), '目')
    await userEvent.click(go)
    const notice = await screen.findByText(/删除前已自动备份，快照在/)
    expect(within(notice).getByText('/data/backups/pm-20261029-004000.db')).toBeInTheDocument()
    expect(notice).toHaveTextContent('删掉 1 张表（projects_items）')
    expect(writes(calls)).toEqual([['/api/plugins/projects/uninstall', { delete_data: true, confirm: 'projects' }]])
  })

  it('还有已安装的插件依赖它时不能卸载，提示先卸载依赖方', async () => {
    stub([
      info({ id: 'projects', name: '项目', installed: true, dependents: ['video'] }),
      info({ id: 'video', name: '视频创作', installed: true, depends: { projects: '^0.1.0' } }),
    ])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '查看「项目」详情' }))
    const drawer = screen.getByRole('dialog', { name: '插件「项目」' })
    expect(within(drawer).getByRole('button', { name: '卸载' })).toBeDisabled()
    expect(within(drawer).getByText('先卸载「视频创作」')).toBeInTheDocument()
  })
})
