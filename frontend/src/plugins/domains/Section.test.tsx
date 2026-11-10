// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainConfig, DomainRoute, DomainSettings, DomainStatus, ProjectPrototype } from '../../core/data'
import Section from './Section'

type Call = { method: string; path: string; body?: Record<string, unknown> }

const SETTINGS: DomainSettings = {
  enabled: true, suffix: 'bro.vip', resolve: 'hosts', proxy: 'builtin', https: true, ca_installed: false, lan: false, lan_ip: '',
  auto_proto: true, aliases: ['broleez.vip'], http_port: 7777, https_port: 7443, updated_at: '2026-10-29T00:00:00Z',
}

const STATUS: DomainStatus = {
  checked_at: new Date().toISOString(), enabled: true, domains: ['broleez.vip', 'bro.vip'], service: { addr: '127.0.0.1:7777' },
  summary: { ok: 1, problem: 1, unknown: 1 },
  items: [
    { key: 'hosts:bro.vip', group: 'hosts', name: 'bro.vip', state: 'ok', message: 'bro.vip 指到 127.0.0.1' },
    {
      key: 'pf_anchor', group: 'pf', name: 'pf 端口转发', state: 'problem', message: '缺 443 的转发规则',
      fix: { text: '重跑 setup-local-domain.sh', commands: ['cd /repo', 'sudo ./scripts/setup-local-domain.sh'] },
    },
    { key: 'ca', group: 'cert', name: '本地根证书', state: 'unknown', message: '没装 mkcert' },
  ],
}

const CONFIG: DomainConfig = {
  proxy: 'builtin', domains: ['broleez.vip', 'bro.vip'],
  resolve: { kind: 'hosts', path: '/etc/hosts', content: '127.0.0.1\tbroleez.vip\n127.0.0.1\tbro.vip', commands: ['sudo tee -a /etc/hosts'] },
  pf: { kind: 'pf', path: '/etc/pf.anchors/broleez-local', content: 'rdr pass on lo0 ...', commands: ['sudo pfctl -s nat'] },
  proxy_config: { kind: 'builtin', content: 'bro.vip  ->  http://127.0.0.1:7777', commands: [] },
  cert: { kind: 'cert', content: '证书要覆盖：bro.vip', commands: ['brew install mkcert', 'mkcert -install'] },
}

const APP: DomainRoute = {
  id: 'dm_app', host: '', fqdn: 'bro.vip', target: { kind: 'app' }, enabled: true, auto: false, note: '这个工作台', check: null,
  created_at: '', updated_at: '',
}

/** 后端收到原型启动事件后才建自动路由：第 later 次取路由时出现 */
type Opts = { protos?: ProjectPrototype[]; auto?: DomainRoute[]; later?: number }

const PROTO: ProjectPrototype = {
  id: 'pp_1', project_id: 'obj_p1', name: 'Demo', dir: '/x', command: 'npm run dev', argv: [], port: 5173, url: 'http://127.0.0.1:5173',
  status: 'running', error: '', pid: 1, started_at: null, last_crash: null, created_at: '', updated_at: '',
}

const AUTO: DomainRoute = {
  ...APP, id: 'dm_auto', host: 'demo', fqdn: 'demo.bro.vip', target: { kind: 'proto', proto_id: 'pp_1' }, auto: true, note: '自动分配：官网 / Demo',
}

function fakeBackend(opts: Opts = {}) {
  const calls: Call[] = []
  let settings = { ...SETTINGS }
  let routes: DomainRoute[] = [APP, ...(opts.later ? [] : opts.auto ?? [])]
  let gets = 0
  let n = 0
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const p = u.pathname
    if (p === '/api/domains/settings') {
      if (method === 'PUT') settings = { ...settings, ...body }
      return json(settings)
    }
    if (p === '/api/domains/status') return json(STATUS)
    if (p === '/api/domains/config') return json(CONFIG)
    if (p === '/api/domains/routes' && method === 'GET') {
      if (++gets === opts.later) routes = [...routes, ...(opts.auto ?? [])]
      return json(routes, 200, { total: routes.length })
    }
    if (p === '/api/domains/routes' && method === 'POST') {
      const r: DomainRoute = { ...APP, id: `dm_${++n}`, host: body.host, fqdn: `${body.host}.${settings.suffix}`, target: body.target, note: body.note ?? '', enabled: true }
      routes = [...routes, r]
      return json(r, 201)
    }
    const one = p.match(/^\/api\/domains\/routes\/([^/]+)(\/check)?$/)
    if (one) {
      const r = routes.find((x) => x.id === one[1])!
      if (one[2]) {
        const check = { ok: false, at: new Date().toISOString(), message: 'HTTPS 开着但本地根证书没装' }
        routes = routes.map((x) => (x.id === r.id ? { ...x, check } : x))
        return json({ id: r.id, fqdn: r.fqdn, check })
      }
      if (method === 'PATCH') {
        routes = routes.map((x) => (x.id === r.id ? { ...x, ...body, auto: false } : x))
        return json(routes.find((x) => x.id === r.id))
      }
      if (method === 'DELETE') {
        routes = routes.filter((x) => x.id !== r.id)
        return json(null)
      }
    }
    // 项目原型（项目插件）：默认没有项目
    if (p === '/api/objects') {
      const xs = opts.protos ? [{ id: 'obj_p1', type: 'project', title: '官网' }] : []
      return json(xs, 200, { total: xs.length })
    }
    if (p === '/api/projects/obj_p1/prototypes') return json(opts.protos ?? [], 200, { total: opts.protos?.length ?? 0 })
    return json({ error: { code: 'not_found', message: p } }, 404)
  }))
  return { calls }
}

function setup(opts?: Opts) {
  const backend = fakeBackend(opts)
  const user = userEvent.setup()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><Section /></QueryClientProvider>)
  return { ...backend, user }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('内网域名分节', () => {
  it('本机状态每项一行，和接口一致；有问题的写怎么修和命令；重新检测再测一次', async () => {
    const { calls, user } = setup()
    const box = await screen.findByRole('region', { name: '本机状态' })
    const rows = await within(box).findAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(STATUS.items.map((i) => i.key))
    expect(within(rows[0]).getByText('正常')).toBeInTheDocument()
    expect(within(rows[1]).getByText('有问题')).toBeInTheDocument()
    expect(within(rows[1]).getByText('缺 443 的转发规则')).toBeInTheDocument()
    expect(within(rows[1]).getByText(/重跑 setup-local-domain.sh/)).toBeInTheDocument()
    expect(within(rows[1]).getByText(/sudo .\/scripts\/setup-local-domain.sh/)).toBeInTheDocument()
    expect(within(rows[2]).getByText('没检测到')).toBeInTheDocument()
    await user.click(within(rows[1]).getByRole('button', { name: '复制命令' }))
    expect(await navigator.clipboard.readText()).toBe('cd /repo\nsudo ./scripts/setup-local-domain.sh')
    const before = calls.filter((c) => c.path === '/api/domains/status').length
    await user.click(within(box).getByRole('button', { name: '重新检测' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/domains/status').length).toBe(before + 1))
  })

  it('生成的配置一键复制，切段后复制那一段', async () => {
    const { user } = setup()
    const box = await screen.findByRole('region', { name: '生成的配置' })
    expect((await within(box).findByLabelText('配置内容')).textContent).toBe(CONFIG.resolve.content)
    await user.click(within(box).getByRole('button', { name: '复制' }))
    expect(await navigator.clipboard.readText()).toBe(CONFIG.resolve.content)
    expect(within(box).getByRole('button', { name: '已复制' })).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'pf 转发' }))
    expect(within(box).getByText('/etc/pf.anchors/broleez-local')).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: '证书' }))
    await user.click(within(box).getByRole('button', { name: '复制命令' }))
    expect(await navigator.clipboard.readText()).toBe('brew install mkcert\nmkcert -install')
  })

  it('加一个、停用、测试、删除', async () => {
    const { calls, user } = setup()
    const box = await screen.findByRole('region', { name: '域名' })
    await within(box).findByText('bro.vip')
    // 工作台那条不能删
    expect(within(box).queryByRole('button', { name: '删除 bro.vip' })).not.toBeInTheDocument()

    await user.click(within(box).getByRole('button', { name: '加一个' }))
    const add = within(box).getByRole('button', { name: '添加' })
    expect(add).toBeDisabled()
    await user.type(within(box).getByLabelText('子域名'), 'Video')
    await user.clear(within(box).getByLabelText('目标地址'))
    await user.type(within(box).getByLabelText('目标地址'), 'http://127.0.0.1:7801')
    await user.type(within(box).getByLabelText('备注'), '视频预览')
    await user.click(add)
    await within(box).findByText('video.bro.vip')
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/domains/routes')?.body).toEqual({
      host: 'video', target: { kind: 'url', url: 'http://127.0.0.1:7801' }, enabled: true, note: '视频预览',
    })
    expect(within(box).queryByLabelText('子域名')).not.toBeInTheDocument()

    await user.click(within(box).getByRole('switch', { name: '启用 video.bro.vip' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false }))

    const row = within(box).getByText('video.bro.vip').closest('[role="listitem"]') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '测试' }))
    await within(row).findByText('HTTPS 开着但本地根证书没装')
    expect(within(row).getByText(/有问题 · /)).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: '复制' }))
    expect(await navigator.clipboard.readText()).toBe('https://video.bro.vip')

    await user.click(within(row).getByRole('button', { name: '删除 video.bro.vip' }))
    expect(within(row).getByText('删除这个域名？')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(within(box).queryByText('video.bro.vip')).not.toBeInTheDocument())
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/routes/dm_1')).toBe(true)
  })

  it('加域名时重名、不合法置灰', async () => {
    const { user } = setup()
    const box = await screen.findByRole('region', { name: '域名' })
    await within(box).findByText('bro.vip')
    await user.click(within(box).getByRole('button', { name: '加一个' }))
    await user.type(within(box).getByLabelText('子域名'), 'a_b')
    expect(within(box).getByText('只能用小写字母、数字和连字符')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: '添加' })).toBeDisabled()
  })

  it('后缀不合法时红字、不提交；合法的回车才存', async () => {
    const { calls, user } = setup()
    const input = await screen.findByRole('textbox', { name: '域名后缀' })
    await user.clear(input)
    await user.type(input, 'pmw.local')
    await user.tab()
    expect(screen.getByText('后缀不合法；也别用 .local，它被系统的 mDNS 占用了')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    await user.clear(input)
    await user.type(input, ' PMW.lan{Enter}')
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ suffix: 'pmw.lan' }))
  })

  it('总开关关掉后各块变淡、域名不能点', async () => {
    const { calls, user } = setup()
    const box = await screen.findByRole('region', { name: '域名' })
    expect(await within(box).findByRole('link', { name: 'bro.vip' })).toHaveAttribute('href', 'https://bro.vip')
    await user.click(screen.getByRole('switch', { name: '内网域名总开关' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: false }))
    await waitFor(() => expect(within(box).queryByRole('link', { name: 'bro.vip' })).not.toBeInTheDocument())
    expect(box).toHaveClass('dm-off')
    expect(screen.getByText('未启用')).toBeInTheDocument()
  })

  it('HTTPS 开着时「怎么安装」给证书命令，状态以检测为准', async () => {
    const { user } = setup()
    expect(await screen.findByText(/没检测到本地根证书/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '怎么安装' }))
    expect(screen.getByText(/插件不替你装证书/)).toBeInTheDocument()
  })

  it('打开局域网访问要先填地址，填好一起存', async () => {
    const { calls, user } = setup()
    await user.click(await screen.findByRole('switch', { name: '允许局域网访问' }))
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    const ip = screen.getByRole('textbox', { name: '本机局域网地址' })
    await user.type(ip, '192.168.1.23{Enter}')
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ lan_ip: '192.168.1.23', lan: true }))
    expect(await screen.findByText(/hosts 文件只对这台电脑生效，局域网访问建议/)).toBeInTheDocument()
  })

  it('原型启动后等到后端建好的自动域名，标「自动」、能访问、不能删；关掉自动分配后不再显示', async () => {
    const { calls, user } = setup({ protos: [PROTO], auto: [AUTO], later: 2 })
    const box = await screen.findByRole('region', { name: '域名' })
    const link = await within(box).findByRole('link', { name: 'demo.bro.vip' }, { timeout: 5000 })
    expect(link).toHaveAttribute('href', 'https://demo.bro.vip')
    const row = link.closest('[role="listitem"]') as HTMLElement
    expect(within(row).getByText('自动')).toBeInTheDocument()
    expect(within(row).getByText(/原型在运行，可以访问/)).toBeInTheDocument()
    expect(within(row).getByText('官网 / Demo（:5173）')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '删除 demo.bro.vip' })).not.toBeInTheDocument()
    expect(within(box).getByText(/2 个启用/)).toBeInTheDocument()

    await user.click(within(box).getByRole('switch', { name: '项目原型自动分配' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ auto_proto: false }))
    await waitFor(() => expect(within(box).queryByText('demo.bro.vip')).not.toBeInTheDocument())
    expect(within(box).queryByText(/项目原型自动分配 \d/)).not.toBeInTheDocument()
    expect(within(box).getByText(/1 个启用/)).toBeInTheDocument()
  }, 10_000)

  it('原型停着时自动域名写「原型没在运行」，不能点', async () => {
    setup({ protos: [{ ...PROTO, status: 'stopped' }], auto: [AUTO] })
    const box = await screen.findByRole('region', { name: '域名' })
    const host = await within(box).findByText('demo.bro.vip')
    expect(host.tagName).not.toBe('A')
    expect(host).toHaveAttribute('title', '原型没在运行')
    const row = host.closest('[role="listitem"]') as HTMLElement
    await within(row).findByText(/原型没在运行/, { selector: '[data-access]' })
  })
})
