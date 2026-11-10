// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchClaudeTab, resetTerminalStore, useTerminalState } from './store'
import { activeTab, tabName } from './model'
import { renderHook } from '@testing-library/react'

afterEach(() => { vi.unstubAllGlobals(); resetTerminalStore() })

describe('交给 Claude Code「切换到终端」', () => {
  it('不先开「工作台」标签，新开一个以任务编号命名的标签，带 claude 建会话', async () => {
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input), 'http://x')
      if (u.pathname === '/api/terminal/sessions' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ data: { id: 'pn_1', cwd: '/ok/w', status: 'running', command: "gogogo \"$(cat '/p')\"" } }), { status: 201 })
      }
      return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
    }))
    const claude = { prompt_file: '/p', mcp_config: '/m', workdir: '/ok/w' }
    const out = await launchClaudeTab({ cwd: '/ok/w', title: 'TSK-0001', claude })
    expect(out.command).toBe("gogogo \"$(cat '/p')\"")
    expect(posts).toEqual([{ cwd: '/ok/w', claude }])
    const { result } = renderHook(() => useTerminalState())
    expect(result.current.layout.tabs).toHaveLength(1)
    expect(tabName(activeTab(result.current.layout)!)).toBe('TSK-0001')
  })
})
