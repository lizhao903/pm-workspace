// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 外部插件（P1-a）纯逻辑测试：清单转换、api 兼容、槽位 → 1.x 注册表的映射、失败路径，
// 以及 registry 对 external source 的跳过 v1 校验。不加载真实插件入口、不需要后端。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginApi } from './api'
import {
  EXTERNAL_API_VERSION, apiCompatible, callExternal, externalCtx, externalEntryRel, externalManifest, externalSources,
  externalStyleUrls, externalWebUrl, externalWebUrls, fetchExternalRows, installPluginRuntime, takeExternalRegistrations,
  validateExternalRegistration, validateExternalRow, type ExternalRegistration, type ExternalRow,
} from './external'
import { PLUGIN_API_VERSION } from './manifest'
import { mergePluginSources, resolvePlugins, type PluginSource } from './registry'

function row(extra: Partial<ExternalRow> & { id: string }): ExternalRow {
  return {
    name: extra.id,
    version: '0.1.0',
    api: '>=2.0.0 <3.0.0',
    enabled: false,
    running: false,
    provides: {},
    permissions: [],
    granted: [],
    ...extra,
  }
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const fail = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: { code: 'validation', message } }), { status })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('apiCompatible', () => {
  it('宿主 API 版本落在清单范围里才算兼容', () => {
    expect(EXTERNAL_API_VERSION).toBe('2.0.0')
    expect(apiCompatible('>=2.0.0 <3.0.0')).toBe(true)
    expect(apiCompatible('^2.0.0')).toBe(true)
    expect(apiCompatible('>=1.0.0')).toBe(true)
  })

  it('缺 api、范围不含 2.0.0 都不兼容', () => {
    expect(apiCompatible(undefined)).toBe(false)
    expect(apiCompatible('')).toBe(false)
    expect(apiCompatible('   ')).toBe(false)
    expect(apiCompatible('>=3.0.0 <4.0.0')).toBe(false)
    expect(apiCompatible('^1.0.0')).toBe(false)
  })
})

describe('externalManifest', () => {
  it('v2 清单摘要转成 1.x 形态：id/name/version/core=api/provides/permissions', () => {
    const m = externalManifest(row({
      id: 'hello_world',
      name: 'Hello World',
      version: '0.2.0',
      description: '示例',
      api: '^2.0.0',
      provides: { modules: ['hello_world'], commands: ['hello_world.say_hi'] },
      permissions: ['objects:read', 'notify'],
      depends: { base: '^1.0.0' },
      optional_depends: { extra: '^1.0.0' },
      emits: ['hello_world.greeted'],
      subscribes: ['object.created'],
    }))
    expect(m.id).toBe('hello_world')
    expect(m.name).toBe('Hello World')
    expect(m.version).toBe('0.2.0')
    expect(m.description).toBe('示例')
    // external 的 core 存的是 v2 的 api 范围，只用于 external 的兼容检查
    expect(m.core).toBe('^2.0.0')
    expect(m.provides).toEqual({ modules: ['hello_world'], commands: ['hello_world.say_hi'] })
    expect(m.permissions).toEqual(['objects:read', 'notify'])
    expect(m.depends).toEqual({ base: '^1.0.0' })
    expect(m.optional_depends).toEqual({ extra: '^1.0.0' })
    expect(m.emits).toEqual(['hello_world.greeted'])
    expect(m.subscribes).toEqual(['object.created'])
  })

  it('v2 的 icon 是包内路径，对不上 1.x 图标 key 时不带；是 key 时保留', () => {
    expect(externalManifest(row({ id: 'aa', icon: 'assets/icon.svg' })).icon).toBeUndefined()
    expect(externalManifest(row({ id: 'aa', icon: 'folder' })).icon).toBe('folder')
  })

  it('缺 api 时给宿主 API 的范围兜底，不抛', () => {
    const m = externalManifest(row({ id: 'aa', api: '' }))
    expect(m.core).toBe(`>=${EXTERNAL_API_VERSION} <3.0.0`)
  })
})

describe('externalSources', () => {
  it('默认只要启用的行，转成 external source（带 load）', () => {
    const sources = externalSources([
      row({ id: 'on', enabled: true }),
      row({ id: 'off', enabled: false }),
    ])
    expect(sources.map((s) => s.id)).toEqual(['on'])
    expect(sources[0].external).toBe(true)
    expect(typeof sources[0].load).toBe('function')
  })

  it('enabledOnly=false 时也收未启用的；重复 id 只收一次', () => {
    const sources = externalSources([
      row({ id: 'aa', enabled: false }),
      row({ id: 'aa', enabled: true }),
    ], { enabledOnly: false })
    expect(sources.map((s) => s.id)).toEqual(['aa'])
  })

  it('列表里混了坏数据也不崩', () => {
    const sources = externalSources([null as unknown as ExternalRow, { nope: 1 } as unknown as ExternalRow, row({ id: 'aa', enabled: true })])
    expect(sources.map((s) => s.id)).toEqual(['aa'])
  })
})

describe('入口路径与样式 URL', () => {
  const hello = row({
    id: 'hello_world',
    version: '0.1.0',
    web_entry: 'web/entry.js',
    manifest: { id: 'hello_world', name: 'Hello', version: '0.1.0', api: '>=2.0.0 <3.0.0', runtime: { web: { entry: 'web/entry.js', styles: ['web/style.css'] } } },
  })

  it('web_entry 缺省时退回清单 runtime.web.entry', () => {
    expect(externalEntryRel(hello)).toBe('web/entry.js')
    expect(externalEntryRel(row({ id: 'aa' }))).toBe('')
  })

  it('拼出带版本号破缓存的同源 URL，路径段逐个转义', () => {
    expect(externalWebUrl('hello_world', 'entry.js', '0.1.0')).toBe('/api/plugins/external/hello_world/web/entry.js?v=0.1.0')
    expect(externalWebUrl('a/b', 'x y.js')).toBe('/api/plugins/external/a%2Fb/web/x%20y.js')
  })

  it('入口候选 URL 同时覆盖「web 目录内相对」和「安装目录内相对」两种后端实现', () => {
    const urls = externalWebUrls(hello)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe('/api/plugins/external/hello_world/web/entry.js?v=0.1.0')
    expect(urls[1]).toBe('/api/plugins/external/hello_world/web/web/entry.js?v=0.1.0')
  })

  it('样式 URL 来自清单 runtime.web.styles（去掉 web/ 前缀，去重）', () => {
    expect(externalStyleUrls(hello)).toEqual(['/api/plugins/external/hello_world/web/style.css?v=0.1.0'])
    expect(externalStyleUrls(row({ id: 'aa', web_styles: ['web/a.css', 'web/a.css'] }))).toEqual([
      '/api/plugins/external/aa/web/a.css?v=0.1.0',
    ])
  })
})

describe('fetchExternalRows', () => {
  it('读 GET /api/plugins/external', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ok([row({ id: 'aa', enabled: true })]))
    vi.stubGlobal('fetch', f)
    const rows = await fetchExternalRows()
    expect(rows.map((r) => r.id)).toEqual(['aa'])
    expect(f.mock.calls[0][0]).toBe('/api/plugins/external')
  })

  it('404、网络错误、坏数据都返回 []，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    expect(await fetchExternalRows()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect(await fetchExternalRows()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => ok([{ id: 1 }, null])))
    expect(await fetchExternalRows()).toEqual([])
  })
})

describe('externalCtx', () => {
  type Registers = { kind: string; def: Record<string, unknown> }
  function fakeApi(registers: Registers[]) {
    const record = (kind: string) => (def: Record<string, unknown>) => {
      registers.push({ kind, def })
      return { dispose: vi.fn() }
    }
    return {
      modules: { register: record('module') },
      settings: { register: record('settings') },
      todayCards: { register: record('todayCards') },
      commands: { register: record('commands') },
    } as unknown as PluginApi
  }
  const Page = () => null

  it('槽位映射到 1.x 注册表：module / settings.section / today.card / command', () => {
    const registers: Registers[] = []
    const ctx = externalCtx(row({ id: 'hello_world', granted: ['objects:read'] }), fakeApi(registers))

    ctx.slots.register('module', { id: 'hello_world', title: 'Hello World' }, Page)
    ctx.slots.register('settings.section', { id: 'hello_world', title: 'Hello 设置' }, Page)
    ctx.slots.register('today.card', { key: 'hello_world_tip', title: 'Hello 提示', order: 5 }, Page)
    const run = vi.fn()
    ctx.slots.register('command', { id: 'hello_world.say_hi', title: '打个招呼', run })

    expect(registers.map((r) => r.kind)).toEqual(['module', 'settings', 'todayCards', 'commands'])
    expect(registers[0].def).toMatchObject({ id: 'hello_world', label: 'Hello World', path: 'ext-hello_world' })
    expect(registers[1].def).toMatchObject({ key: 'hello_world', label: 'Hello 设置' })
    expect(registers[2].def).toMatchObject({ key: 'hello_world_tip', title: 'Hello 提示', order: 5 })
    expect(registers[3].def).toMatchObject({ id: 'hello_world.say_hi', group: '插件', title: '打个招呼' })

    // 组件都被包了 [data-pmw-plugin] 作用域（module 的 load 里、其它槽位的组件上）
    const load = registers[0].def.load as () => Promise<{ default: unknown }>
    return load().then((mod) => {
      expect(typeof mod.default).toBe('function')
    })
  })

  it('command 槽位的 run 调插件的 run；object.section 明确忽略并告警', () => {
    const registers: Registers[] = []
    const ctx = externalCtx(row({ id: 'aa' }), fakeApi(registers))
    const run = vi.fn()
    ctx.slots.register('command', { id: 'aa.go', title: '去做', run })
    const cmd = registers[0].def as { run: () => Promise<void> }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = ctx.slots.register('object.section', { object_type: 'task', title: '区块' }, Page)
    expect(typeof d.dispose).toBe('function')
    expect(warn).toHaveBeenCalled()
    return cmd.run().then(() => expect(run).toHaveBeenCalledOnce())
  })

  it('ctx 基础信息、权限只看 granted、i18n 插值、theme 静态', () => {
    const ctx = externalCtx(row({ id: 'aa', version: '1.2.3', granted: ['objects:read'] }), fakeApi([]))
    expect(ctx.id).toBe('aa')
    expect(ctx.version).toBe('1.2.3')
    expect(ctx.apiVersion).toBe(EXTERNAL_API_VERSION)
    expect(ctx.permissions.has('objects:read')).toBe(true)
    expect(ctx.permissions.has('network:any')).toBe(false)
    expect(ctx.i18n.lang).toBe('zh')
    expect(ctx.i18n.t('你好，{name}', { name: '世界' })).toBe('你好，世界')
    // 宿主 UI 组件（标题行、按钮）给插件用，插件页面的标题和操作才能放进顶栏
    expect(typeof ctx.ui.PageTitle).toBe('function')
    expect(typeof ctx.ui.Button).toBe('function')
    expect(ctx.i18n.t('原样')).toBe('原样')
    expect(ctx.theme.mode).toBe('system')
    const cb = vi.fn()
    expect(typeof ctx.theme.subscribe(cb).dispose).toBe('function')
  })

  it('host.call 发 POST .../call，返回 data', async () => {
    const f = vi.fn(async () => ok({ items: [{ id: 't1' }] }))
    vi.stubGlobal('fetch', f)
    await expect(callExternal('hello_world', 'host.objects.list', { limit: 5 })).resolves.toEqual({ items: [{ id: 't1' }] })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/plugins/external/hello_world/call')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ method: 'host.objects.list', params: { limit: 5 } })
  })

  it('host.call 非 2xx 抛带后端 message 的 Error；notify 走 host.notify', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail('没有权限')))
    const ctx = externalCtx(row({ id: 'aa' }), fakeApi([]))
    await expect(ctx.host.call('host.objects.list')).rejects.toThrow('没有权限')
    await expect(ctx.notify({ title: 'hi', body: 'x' })).rejects.toThrow('没有权限')
  })
})

describe('入口登记校验', () => {
  const base: ExternalRegistration = { id: 'aa', api: '>=2.0.0 <3.0.0', activate() {} }

  it('通过：id、api 和清单一致', () => {
    expect(validateExternalRegistration(row({ id: 'aa' }), base)).toEqual([])
  })

  it('没注册、id 不符、api 不兼容、缺 activate 都列出原因', () => {
    expect(validateExternalRegistration(row({ id: 'aa' }), undefined)[0]).toContain('没有调用')
    expect(validateExternalRegistration(row({ id: 'aa' }), { ...base, id: 'bb' })).toEqual([
      '入口注册的 id 是 bb，和清单 id aa 不一致',
    ])
    expect(validateExternalRegistration(row({ id: 'aa' }), { ...base, api: '^3.0.0' })[0]).toContain('不包含宿主 API')
    expect(validateExternalRegistration(row({ id: 'aa', api: '^2.0.0' }), { ...base, api: '>=2.0.0 <3.0.0' })[0]).toContain('不一致')
    expect(validateExternalRegistration(row({ id: 'aa' }), { ...base, activate: undefined as unknown as () => void })).toEqual([
      '入口没有提供 activate(ctx)',
    ])
  })

  it('行级校验：api 不兼容、没有 web 入口', () => {
    expect(validateExternalRow(row({ id: 'aa', api: '>=3.0.0' }))[0]).toContain('不兼容')
    expect(validateExternalRow(row({ id: 'aa' }))).toContain('没有声明前端入口（web_entry）')
    expect(validateExternalRow(row({ id: 'aa', web_entry: 'web/entry.js' }))).toEqual([])
  })

  it('window.__PMW_PLUGIN__.register 收集登记，按 id 取走后清空', () => {
    const win = {} as Window
    vi.stubGlobal('window', win)
    installPluginRuntime()
    const reg: ExternalRegistration = { id: 'aa', activate() {} }
    win.__PMW_PLUGIN__!.register(reg)
    win.__PMW_PLUGIN__!.register({ id: 'bb', activate() {} })
    expect(takeExternalRegistrations('aa')).toEqual([reg])
    expect(takeExternalRegistrations('aa')).toEqual([])
    expect(takeExternalRegistrations('bb')).toHaveLength(1)
  })
})

describe('registry 集成 external source', () => {
  it('跳过 v1 的 parse/check：core 是 v2 的 api 范围也能通过', () => {
    const src: PluginSource = {
      id: 'hello_world',
      external: true,
      manifest: externalManifest(row({ id: 'hello_world', enabled: true, provides: { modules: ['hello_world'] } })),
      load: () => Promise.resolve({ default: { activate() {} } }),
    }
    const r = resolvePlugins([src], { enabled: ['hello_world'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    expect(r.ok.map((m) => m.id)).toEqual(['hello_world'])
  })

  it('api 不兼容 / id 不一致时报出来，不加载', () => {
    const bad = (patch: Partial<ExternalRow>) => ({
      id: 'aa',
      external: true,
      manifest: externalManifest(row({ id: 'aa', ...patch })),
      load: () => Promise.resolve({ default: { activate() {} } }),
    }) as PluginSource
    const state = { enabled: ['aa'], apiVersion: PLUGIN_API_VERSION }
    const r1 = resolvePlugins([bad({ api: '>=3.0.0 <4.0.0' })], state)
    expect(r1.ok).toEqual([])
    expect(r1.problems[0].reasons[0]).toContain('要求宿主 API')
    const r2 = resolvePlugins([{ ...bad({}), id: 'other' }], { enabled: ['aa'], apiVersion: PLUGIN_API_VERSION })
    expect(r2.ok).toEqual([])
  })

  it('mergePluginSources：同 id 以内置为准，外部接在后面', () => {
    const builtin: PluginSource = { id: 'hello', manifest: {} }
    const ext: PluginSource = { id: 'hello_world', external: true, manifest: externalManifest(row({ id: 'hello_world' })) }
    const dup: PluginSource = { id: 'hello', external: true, manifest: externalManifest(row({ id: 'hello' })) }
    expect(mergePluginSources([builtin], [ext]).map((s) => s.id)).toEqual(['hello', 'hello_world'])
    expect(mergePluginSources([builtin], [dup])).toEqual([builtin])
    expect(mergePluginSources([builtin], [])).toEqual([builtin])
  })
})
