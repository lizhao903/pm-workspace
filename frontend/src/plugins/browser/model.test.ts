import { describe, expect, it } from 'vitest'
import type { BrowserTabRecord, TerminalPrototype } from '../../core/data'
import {
  HOME_URL, MAX_HISTORY, MAX_TABS, classify, closeOthers, closeTab, displayUrl, fromRecords, go, groupProtos, homeTabs, makeTab, navigate,
  normalize, oauthReturnTo, openOrFocus, openTab, protoMatcher, remember, sameUrl, timeAgo, titleOf, toRecords, togglePin, type Tabs,
} from './model'

const proto = (o: Partial<TerminalPrototype>): TerminalPrototype => ({
  id: 'pt_1', project_id: 'obj_p', project_title: '产品工作台新版', name: '新版前端原型', dir: '/w', command: 'npm run dev', argv: [], port: 7778,
  url: '', status: 'running', error: '', pid: 0, started_at: null, last_crash: null, created_at: '', updated_at: '', ...o,
})

describe('地址栏输入（SPEC-browser-1.13）', () => {
  it.each([
    ['', HOME_URL],
    ['  ', HOME_URL],
    ['7790', 'http://127.0.0.1:7790'],
    [':7790', 'http://127.0.0.1:7790'],
    ['7790/a?b=1', 'http://127.0.0.1:7790/a?b=1'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['192.168.1.5:80', 'http://192.168.1.5:80'],
    ['example.com', 'https://example.com'],
    ['example.com/a b', 'https://example.com/a b'],
    ['https://x.dev/p', 'https://x.dev/p'],
    ['about:home', 'about:home'],
    ['任务 看板', 'https://www.google.com/search?q=%E4%BB%BB%E5%8A%A1%20%E7%9C%8B%E6%9D%BF'],
  ])('%s -> %s', (input, url) => {
    expect(normalize(input)).toBe(url)
  })

  it('显示时去掉协议和末尾斜杠、解码；新标签页显示空', () => {
    expect(displayUrl('https://example.com/')).toBe('example.com')
    expect(displayUrl('https://example.com/%E4%BB%BB')).toBe('example.com/任')
    expect(displayUrl(HOME_URL)).toBe('')
  })

  it('种类：本机地址是原型，Drive 地址按网页，about: 是新标签页', () => {
    expect(classify('http://localhost:7778')).toBe('proto')
    expect(classify('http://0.0.0.0:1')).toBe('proto')
    expect(classify('https://drive.google.com/drive/my-drive')).toBe('web')
    expect(classify('about:blank')).toBe('home')
  })

  it('同一地址忽略末尾斜杠和 localhost / 127.0.0.1', () => {
    expect(sameUrl('http://localhost:7778/', 'http://127.0.0.1:7778')).toBe(true)
    expect(sameUrl('http://127.0.0.1:7778/a', 'http://127.0.0.1:7778')).toBe(false)
  })
})

describe('标题', () => {
  it('原型「<原型> · <项目>」，没登记的本机地址是地址；网页是主机名；搜索写「<词> - 搜索」', () => {
    const ps = [proto({})]
    expect(titleOf('http://127.0.0.1:7778', ps)).toBe('新版前端原型 · 产品工作台新版')
    expect(titleOf('http://127.0.0.1:9999/', ps)).toBe('127.0.0.1:9999')
    expect(titleOf('https://www.example.com/a')).toBe('example.com')
    expect(titleOf(normalize('看板'))).toBe('看板 - 搜索')
    expect(titleOf(HOME_URL)).toBe('新标签页')
  })
})

describe('标签和历史', () => {
  const three = (): Tabs => {
    let s = homeTabs()
    s = openTab(s, 'http://127.0.0.1:1', 'a').state
    s = openTab(s, 'http://127.0.0.1:2', 'b').state
    return s
  }

  it('打开地址截掉当前位置之后的历史；前进后退在历史里走，到头不动', () => {
    let s = homeTabs()
    const id = s.active
    s = navigate(s, id, 'https://a.com', 'a.com')
    s = navigate(s, id, 'https://b.com', 'b.com')
    s = go(s, id, -1, (u) => u)
    expect(s.tabs[0]).toMatchObject({ url: 'https://a.com', cursor: 1, history: [HOME_URL, 'https://a.com', 'https://b.com'], loading: true })
    expect(go(go(s, id, -1, (u) => u), id, -1, (u) => u).tabs[0].cursor).toBe(0)
    s = navigate(s, id, 'https://c.com', 'c.com')
    expect(s.tabs[0].history).toEqual([HOME_URL, 'https://a.com', 'https://c.com'])
    expect(go(s, id, 1, (u) => u)).toBe(s)
  })

  it('历史最多留 100 条', () => {
    let s = homeTabs()
    for (let i = 0; i < MAX_HISTORY + 5; i++) s = navigate(s, s.active, `https://x.com/${i}`, 'x')
    expect(s.tabs[0].history).toHaveLength(MAX_HISTORY)
    expect(s.tabs[0].cursor).toBe(MAX_HISTORY - 1)
  })

  it('满 12 个时在当前标签打开；已有同一地址的切过去', () => {
    let s = homeTabs()
    for (let i = 1; i < MAX_TABS; i++) s = openTab(s, `https://x.com/${i}`, 'x').state
    expect(s.tabs).toHaveLength(MAX_TABS)
    const r = openTab(s, 'https://y.com', 'y')
    expect(r.state.tabs).toHaveLength(MAX_TABS)
    expect(r.id).toBe(s.active)
    const hit = openOrFocus(s, 'https://x.com/3/', 'x')
    expect(hit.state.active).toBe(s.tabs[3].id)
  })

  it('关当前标签切到左边那个；关最后一个补新标签页', () => {
    const s = three()
    const c = closeTab(s, s.tabs[2].id)
    expect(c.active).toBe(s.tabs[1].id)
    const one = homeTabs()
    const after = closeTab(one, one.active)
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].id).not.toBe(one.active)
    expect(after.tabs[0].kind).toBe('home')
  })

  it('固定的排最前；关其他留着固定的', () => {
    let s = three()
    s = togglePin(s, s.tabs[2].id)
    expect(s.tabs[0]).toMatchObject({ title: 'b', pinned: true })
    const o = closeOthers(s, s.tabs[1].id)
    expect(o.tabs.map((t) => t.title)).toEqual(['b', '新标签页'])
  })

  it('最近打开：最新在前、同一地址只留一条、最多 8 条、不记新标签页', () => {
    let r = remember([], HOME_URL, '新标签页')
    expect(r).toEqual([])
    for (let i = 0; i < 10; i++) r = remember(r, `https://x.com/${i}`, String(i), 'now')
    r = remember(r, 'https://x.com/5/', '5', 'now')
    expect(r).toHaveLength(8)
    expect(r[0].url).toBe('https://x.com/5/')
    expect(r.filter((x) => sameUrl(x.url, 'https://x.com/5'))).toHaveLength(1)
  })
})

describe('和后端记录互转', () => {
  it('顺序、当前标签、历史和游标原样往返；loading 不存', () => {
    let s = homeTabs()
    s = navigate(s, s.active, 'http://127.0.0.1:7790', 'x')
    s = openTab(s, 'https://a.com', 'a').state
    s = navigate(s, s.active, 'https://b.com', 'b')
    s = go(s, s.active, -1, (u) => u)
    s = togglePin(s, s.active)
    const rows = toRecords(s)
    expect(rows.map((r) => [r.position, r.active, r.pinned, r.cursor])).toEqual([[0, true, true, 0], [1, false, false, 1]])
    expect(rows[0]).not.toHaveProperty('loading')
    const back = fromRecords(rows)
    expect(back.active).toBe(s.active)
    expect(back.tabs.map((t) => [t.url, t.history, t.cursor])).toEqual(s.tabs.map((t) => [t.url, t.history, t.cursor]))
  })

  it('坏游标收回范围，旧的 drive 按网页，按 position 排，空列表给新标签页', () => {
    const rows: BrowserTabRecord[] = [
      { id: 'bt_b', url: 'https://drive.google.com/x', title: '', kind: 'drive', history: ['https://drive.google.com/x'], cursor: 5, pinned: false, position: 1, active: false },
      { id: 'bt_a', url: HOME_URL, title: '新标签页', kind: 'home', history: [], cursor: 0, pinned: false, position: 0, active: false },
    ]
    const s = fromRecords(rows)
    expect(s.tabs.map((t) => t.id)).toEqual(['bt_a', 'bt_b'])
    expect(s.tabs[1]).toMatchObject({ kind: 'web', cursor: 0, title: 'drive.google.com' })
    expect(s.tabs[0].history).toEqual([HOME_URL])
    expect(s.active).toBe('bt_a')
    expect(fromRecords([]).tabs).toHaveLength(1)
  })

  it('存不了的地址（javascript: 之类）不往后端送', () => {
    const t = makeTab('https://a.com', 'a')
    const s: Tabs = { tabs: [{ ...t, url: 'javascript:alert(1)', history: ['https://a.com', 'javascript:alert(1)'], cursor: 1 }], active: t.id }
    expect(toRecords(s)[0]).toMatchObject({ url: HOME_URL, history: ['https://a.com'], cursor: 0 })
  })
})

describe('新标签页的原型分组', () => {
  it('有在跑的组排前，其次有失败的；组内在跑的在前', () => {
    const g = groupProtos([
      proto({ id: 'a', project_id: 'p1', project_title: '甲', status: 'stopped' }),
      proto({ id: 'b', project_id: 'p2', project_title: '乙', status: 'crashed' }),
      proto({ id: 'c', project_id: 'p3', project_title: '丙', status: 'stopped' }),
      proto({ id: 'd', project_id: 'p3', project_title: '丙', status: 'running' }),
    ])
    expect(g.map((x) => x.name)).toEqual(['丙', '乙', '甲'])
    expect(g[0].items.map((p) => p.id)).toEqual(['d', 'c'])
    expect(g[0]).toMatchObject({ running: 1, live: true })
    expect(g[1].failed).toBe(1)
  })

  it('搜索按名字、项目、端口，多个词都要命中', () => {
    const { hit } = protoMatcher('看板 7790')
    expect(hit(proto({ name: '状态看板', port: 7790 }))).toBe(true)
    expect(hit(proto({ name: '状态看板', port: 7791 }))).toBe(false)
  })
})

describe('杂项', () => {
  it('多久前', () => {
    const now = Date.parse('2026-10-29T10:00:00Z')
    expect(timeAgo('2026-10-29T09:59:40Z', now)).toBe('刚刚')
    expect(timeAgo('2026-10-29T09:30:00Z', now)).toBe('30 分钟前')
    expect(timeAgo('2026-10-29T07:00:00Z', now)).toBe('3 小时前')
    expect(timeAgo(null, now)).toBe('')
  })

  it('授权回调：本机打开回到当前前端的 /browser，否则给站内路径', () => {
    expect(oauthReturnTo({ origin: 'http://127.0.0.1:7787', hostname: '127.0.0.1' })).toBe('http://127.0.0.1:7787/browser')
    expect(oauthReturnTo({ origin: 'https://bro.vip', hostname: 'bro.vip' })).toBe('/browser')
  })
})
