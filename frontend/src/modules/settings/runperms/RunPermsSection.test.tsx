// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「执行权限」（TSK-0499，SPEC-settings-26）：默认写入档位、自定义白名单整体保存；前端先挡等于放开任意命令的规则；
// 执行记录「去设置放行」带 ?add= 过来时预填规则、档位切到自定义
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunPermissions } from '../../../core/data'
import { RunPermsSection } from './RunPermsSection'
import { parseRules, pendingRules, ruleIssue } from './permsModel'

const seed: RunPermissions = {
  write_profile: 'accept_edits', custom: ['Bash(git add:*)'], mcp_server: 'pmw-run',
  profiles: [
    { key: 'read_only', label: '只读', writes: false, allowed: ['Bash(git log:*)', 'Bash(sqlite3 -readonly -safe:*)'] },
    { key: 'accept_edits', label: '允许改文件', writes: true, allowed: ['Bash(git log:*)'] },
    { key: 'edits_and_tests', label: '允许改文件 + 跑测试构建', writes: true, allowed: ['Bash(git log:*)', 'Bash(go test:*)'] },
    { key: 'custom', label: '自定义白名单', writes: true, allowed: ['Bash(git log:*)', 'Bash(git add:*)'] },
  ],
}

function backend() {
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const b = JSON.parse(String(init.body)) as { write_profile: RunPermissions['write_profile']; custom: string[] }
      bodies.push(b)
      return new Response(JSON.stringify({ data: { ...seed, ...b } }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: seed }), { status: 200 })
  }))
  return bodies
}

function renderIt(url = '/settings/run-permissions') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><RunPermsSection /></MemoryRouter></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('执行权限的纯函数', () => {
  it('一行一条、去空去重；挡住放开任意命令的写法', () => {
    expect(parseRules(' Bash(a:*) \n\nBash(a:*)\nmcp__x')).toEqual(['Bash(a:*)', 'mcp__x'])
    for (const bad of ['Bash', 'Bash(*)', 'Bash(:*)', 'rm -rf /', 'Bash(git', 'mcp__']) expect(ruleIssue(bad)).not.toBe('')
    for (const ok of ['Bash(git commit:*)', 'mcp__slack', 'WebFetch', 'WebFetch(domain:example.com)']) expect(ruleIssue(ok)).toBe('')
    expect(pendingRules('Bash(git add:*)\nBash(make x:*)', ['Bash(git add:*)'])).toEqual(['Bash(make x:*)'])
    expect(pendingRules(null, [])).toEqual([])
  })
})

describe('设置「执行权限」', () => {
  it('列出每一档实际放行的规则，改档位和白名单后整体保存', async () => {
    const bodies = backend()
    renderIt()
    const user = userEvent.setup()
    const sel = await screen.findByRole('combobox', { name: '默认写入档位' })
    expect(sel).toHaveValue('accept_edits')
    expect(screen.getByText(/server 名 pmw-run/)).toBeInTheDocument()
    expect(screen.getByText('只读', { selector: 'summary' })).toBeInTheDocument()
    await user.selectOptions(sel, 'edits_and_tests')
    const box = screen.getByRole('textbox', { name: '自定义白名单' })
    await user.type(box, '\nBash(*)')
    expect(await screen.findByText(/等于放开任意命令/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    await user.clear(box)
    await user.type(box, 'Bash(git add:*)\nBash(git commit:*)')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ write_profile: 'edits_and_tests', custom: ['Bash(git add:*)', 'Bash(git commit:*)'] })
    expect(await screen.findByRole('status')).toHaveTextContent('已保存')
  })

  it('从执行记录带来的规则预填进白名单，档位切到自定义', async () => {
    const bodies = backend()
    renderIt('/settings/run-permissions?add=' + encodeURIComponent('Bash(git add:*)\nBash(make deploy:*)'))
    const user = userEvent.setup()
    expect(await screen.findByText(/从执行记录带来 1 条/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '默认写入档位' })).toHaveValue('custom')
    expect(screen.getByRole('textbox', { name: '自定义白名单' })).toHaveValue('Bash(git add:*)\nBash(make deploy:*)')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ write_profile: 'custom', custom: ['Bash(git add:*)', 'Bash(make deploy:*)'] })
  })
})
