// 会话旁边的终端（SPEC-sessions-1.35）：和一级菜单同一套标签；每次从会话头部打开，定位到停在会话目录的格子，没有就新开标签
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LAYOUT, addPane, addTab, findPaneByCwd, newPane, newTab } from './model'
import SessionPanel from './SessionPanel'
import { resetTerminalStore } from './store'

vi.mock('./XTerm', () => ({
  XTerm: ({ session }: { session: string }) => <div data-testid="xterm">{session}</div>,
}))

describe('按目录找格子', () => {
  const p = (id: string, cwd: string) => newPane({ id, cwd })
  it('当前标签的焦点格优先，忽略末尾斜杠，空目录不算', () => {
    let l = addTab(EMPTY_LAYOUT, newTab([p('a', '/w/app')]))
    const t2 = newTab([p('b', '/w/api')])
    l = addTab(l, t2)
    l = addPane(l, t2.id, p('c', '/w/app'), 'row')
    expect(findPaneByCwd(l, '/w/app/')?.pane.session).toBe('c')
    expect(findPaneByCwd(l, '/w/api')?.tab.id).toBe(t2.id)
    expect(findPaneByCwd(l, '/w/none')).toBeUndefined()
    expect(findPaneByCwd(l, '')).toBeUndefined()
  })
})

function fakeBackend(existing: { id: string; cwd: string }[]) {
  const posts: string[] = []
  const sessions = existing.map((s) => ({ ...s, status: 'running' }))
  let n = 0
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { total: 0 } }), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (u.pathname === '/api/terminal/sessions' && method === 'GET') return json(sessions)
    if (u.pathname === '/api/terminal/sessions' && method === 'POST') {
      const cwd = JSON.parse(String(init?.body)).cwd || '/Users/me'
      posts.push(cwd)
      const s = { id: `pn_new${++n}`, cwd, status: 'running' }
      sessions.push(s)
      return json(s, 201)
    }
    if (u.pathname === '/api/objects') return json([{ id: 'obj_p', type_id: 'project', title: '项目', workdir: '/w/first' }])
    if (u.pathname === '/api/fs/shortcuts') return json([{ label: '主目录', path: '/Users/me' }])
    return json([])
  }))
  return posts
}

const props = { sessionId: 'ags_1', links: [], hidden: false }
function renderPanel(workdir: string, request: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (w: string, r: number) => <QueryClientProvider client={qc}><SessionPanel {...props} workdir={w} request={r} /></QueryClientProvider>
  const r = render(ui(workdir, request))
  return (w: string, req: number) => r.rerender(ui(w, req))
}
const shown = () => screen.queryAllByTestId('xterm').filter((e) => !e.closest('[hidden]')).map((e) => e.textContent)

describe('会话旁边的终端', () => {
  beforeEach(() => { resetTerminalStore(); localStorage.clear() })
  afterEach(() => vi.unstubAllGlobals())

  it('一个终端都没有时，第一个标签直接开在会话目录，不先开「工作台」', async () => {
    const posts = fakeBackend([])
    renderPanel('/w/app', 1)
    await waitFor(() => expect(shown()).toEqual(['pn_new1']))
    expect(posts).toEqual(['/w/app'])
  })

  it('已经有停在会话目录的格子就切过去，不新开；换了目录再打开才新开', async () => {
    localStorage.setItem('pmw-terminal', JSON.stringify({
      tabs: [
        { id: 't1', name: '', dir: 'row', panes: [{ id: 'p1', session: 'pn_1', cwd: '/w/first', started: [] }], focus: 'p1' },
        { id: 't2', name: '', dir: 'row', panes: [{ id: 'p2', session: 'pn_2', cwd: '/w/app', started: [] }], focus: 'p2' },
      ],
      active: 't1',
    }))
    const posts = fakeBackend([{ id: 'pn_1', cwd: '/w/first' }, { id: 'pn_2', cwd: '/w/app' }])
    const rerender = renderPanel('/w/app', 1)
    await waitFor(() => expect(shown()).toEqual(['pn_2']))
    expect(posts).toEqual([])
    // 换了会话（目录不同）但没再点入口：不动
    rerender('/w/other', 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(posts).toEqual([])
    rerender('/w/other', 2)
    await waitFor(() => expect(shown()).toEqual(['pn_new1']))
    expect(posts).toEqual(['/w/other'])
  })

  it('会话没设目录时用终端的默认目录（第一个有目录的项目）', async () => {
    const posts = fakeBackend([])
    renderPanel('', 1)
    await waitFor(() => expect(posts).toEqual(['/w/first']))
  })
})
