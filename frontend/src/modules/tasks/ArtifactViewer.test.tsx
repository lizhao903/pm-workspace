// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, ArtifactBranch, ArtifactCommit, ArtifactFile, WorkObject } from '../../core/data'
import { ArtifactsPanel } from './ArtifactsPanel'

// 产出物查看（DEV-08b 补，SPEC-tasks-5.40 起）：点标题打开查看窗，按产出物 id 读，不传路径

const at = new Date().toISOString()
function art(p: Partial<Artifact>): Artifact {
  return {
    id: 'art_x', object_id: 'obj_1', session_id: null, run_id: null, title: '', path: '',
    base_dir: '', url: '', platform: '', size: 0, source: 'mcp', note: '', created_at: at, updated_at: at, rel_path: '', kind: '', display_kind: 'other', ...p,
  }
}
const task = { id: 'obj_1', ref: 'TSK-0001', title: '任务' } as WorkObject

const fileOf = (p: Partial<ArtifactFile>): ArtifactFile => ({
  artifact_id: 'art_f', path: '/repo/docs/a.md', name: 'a.md', ext: 'md', size: 12, modified: at, preview: 'markdown',
  binary: false, truncated: false, limit: 1048576, content: '', ...p,
})

const commit: ArtifactCommit = {
  artifact_id: 'art_b', repo: '/repo', sha: 'c0ffee1234567890c0ffee1234567890c0ffee12', parents: [], author: 'T', author_email: 't@x',
  authored_at: at, subject: 'fix: c2', body: '', files_truncated: false, truncated: false, limit: 524288,
  files: [{ path: 'c.txt', old_path: '', status: 'M', additions: 1, deletions: 1, binary: false }],
  diff: 'diff --git a/c.txt b/c.txt\nindex 1..2 100644\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-c\n+c2\n',
}
const branch: ArtifactBranch = {
  artifact_id: 'art_b', repo: '/repo', branch: 'feat/x', ref: 'refs/heads/feat/x', base: 'main', ahead: 1, behind: 0,
  commits: [{ sha: commit.sha, author: 'T', authored_at: at, subject: 'fix: c2' }], commits_truncated: false,
  files: commit.files, files_truncated: false,
}

type Route = (url: URL) => Response | undefined
function stub(rows: Artifact[], route: Route) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x')
    calls.push(url.pathname + url.search)
    const r = route(url)
    if (r) return r
    return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }), { status: 200 })
  }))
  return calls
}
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const fail = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status })

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ArtifactsPanel task={task} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('产出物查看', () => {
  it('本机文件点标题打开查看窗：Markdown 渲染，按产出物 id 读、不带路径；复制路径还在；Esc 关查看窗', async () => {
    const calls = stub([art({ id: 'art_f', path: '/repo/docs/a.md', rel_path: 'docs/a.md' })],
      (u) => (u.pathname === '/api/artifacts/art_f/file' ? ok(fileOf({ content: '# 方案标题\n\n正文一段' })) : undefined))
    const user = userEvent.setup()
    renderPanel()
    const file = await screen.findByRole('group', { name: '文件' })
    expect(within(file).getByRole('button', { name: '复制路径' })).toBeInTheDocument()
    await user.click(within(file).getByRole('button', { name: 'docs/a.md' }))
    const dlg = await screen.findByRole('dialog', { name: '查看文件 docs/a.md' })
    expect(await within(dlg).findByRole('heading', { name: '方案标题' })).toBeInTheDocument()
    expect(calls).toContain('/api/artifacts/art_f/file')
    expect(calls.some((c) => c.includes('path='))).toBe(false)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('源码等宽显示；HTML 在不跑脚本的沙箱里看，可切源码；二进制、越界给明确说明', async () => {
    const rows = [
      art({ id: 'art_go', path: '/repo/main.go', rel_path: 'main.go' }),
      art({ id: 'art_html', path: '/repo/p.html', rel_path: 'p.html' }),
      art({ id: 'art_bin', path: '/repo/a.bin', rel_path: 'a.bin' }),
      art({ id: 'art_env', path: '/repo/.env', rel_path: '.env' }),
    ]
    stub(rows, (u) => {
      switch (u.pathname) {
        case '/api/artifacts/art_go/file': return ok(fileOf({ path: '/repo/main.go', name: 'main.go', ext: 'go', preview: 'text', content: 'package main' }))
        case '/api/artifacts/art_html/file': return ok(fileOf({ path: '/repo/p.html', name: 'p.html', ext: 'html', preview: 'html', content: '<h1>hi</h1>' }))
        case '/api/artifacts/art_bin/file': return ok(fileOf({ path: '/repo/a.bin', name: 'a.bin', ext: 'bin', preview: 'binary', binary: true, size: 2048 }))
        case '/api/artifacts/art_env/file': return fail(403, 'forbidden', '路径里有隐藏目录或隐藏文件，不在工作台里显示：/repo/.env')
      }
      return undefined
    })
    const user = userEvent.setup()
    renderPanel()
    const close = async () => user.click(screen.getByRole('button', { name: '关闭查看' }))

    await user.click(await screen.findByRole('button', { name: 'main.go' }))
    expect((await screen.findByText('package main')).tagName).toBe('PRE')
    await close()

    await user.click(screen.getByRole('button', { name: 'p.html' }))
    const frame = await screen.findByTitle('页面 p.html')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame).toHaveAttribute('src', '/api/artifacts/art_html/raw')
    await user.click(screen.getByRole('radio', { name: '源码' }))
    expect(screen.getByText('<h1>hi</h1>')).toBeInTheDocument()
    await close()

    await user.click(screen.getByRole('button', { name: 'a.bin' }))
    expect(await screen.findByText(/这是二进制文件（2.0 KB），不显示内容/)).toBeInTheDocument()
    await close()

    await user.click(screen.getByRole('button', { name: '.env' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('不能在工作台里看：路径里有隐藏目录或隐藏文件')
  })

  it('提交点开看说明、改动文件和 diff；只有链接没有本机仓库的提交照旧是链接', async () => {
    stub([
      art({ id: 'art_c', path: '/repo', note: `[commit] sha=${commit.sha.slice(0, 7)} repo=/repo 修排序`, url: 'https://github.com/a/b/commit/c0ffee1' }),
      art({ id: 'art_u', url: 'https://github.com/a/b/commit/abcdef1', note: '[commit] sha=abcdef1 只在远端' }),
    ], (u) => (u.pathname === '/api/artifacts/art_c/commit' ? ok(commit) : undefined))
    const user = userEvent.setup()
    renderPanel()
    const g = await screen.findByRole('group', { name: '提交' })
    expect(within(g).getByRole('link', { name: '只在远端' })).toHaveAttribute('href', 'https://github.com/a/b/commit/abcdef1')
    // 有链接也有本机仓库：标题点开看，链接挪到后面
    expect(within(g).getByRole('link', { name: '链接' })).toHaveAttribute('href', 'https://github.com/a/b/commit/c0ffee1')
    await user.click(within(g).getByRole('button', { name: '修排序' }))
    const dlg = await screen.findByRole('dialog', { name: '查看提交 修排序' })
    expect(await within(dlg).findByRole('heading', { name: 'fix: c2' })).toBeInTheDocument()
    expect(within(within(dlg).getByRole('list', { name: '改动文件' })).getByText('+1 -1')).toBeInTheDocument()
    const diff = within(dlg).getByLabelText('改动内容')
    expect(diff.querySelector('.dl-add')).toHaveTextContent('+c2')
    expect(diff.querySelector('.dl-del')).toHaveTextContent('-c')
  })

  it('分支看相对主分支的提交，点提交看改动；仓库取不到时说清原因', async () => {
    const calls = stub([
      art({ id: 'art_b', path: '/repo', note: '[branch] branch=feat/x repo=/repo' }),
      art({ id: 'art_g', path: '/gone', note: '[branch] branch=feat/y repo=/gone' }),
    ], (u) => {
      if (u.pathname === '/api/artifacts/art_b/branch') return ok(branch)
      if (u.pathname === '/api/artifacts/art_b/commit') return ok(commit)
      if (u.pathname === '/api/artifacts/art_g/branch') return fail(409, 'repo_unavailable', '仓库目录不在了（备注里的 repo=）：/gone。工作区可能已经清理，或仓库挪了位置')
      return undefined
    })
    const user = userEvent.setup()
    renderPanel()
    const g = await screen.findByRole('group', { name: '分支' })
    const rows = within(g).getAllByRole('listitem')
    // 没有标题和备注的分支，标题处是「看提交」
    await user.click(within(rows[0]).getByRole('button', { name: '看提交' }))
    const dlg = await screen.findByRole('dialog')
    expect(await within(dlg).findByText(/多 1 个提交/)).toBeInTheDocument()
    await user.click(within(within(dlg).getByRole('list', { name: '分支提交' })).getByRole('button', { name: 'fix: c2' }))
    expect(await within(dlg).findByRole('heading', { name: 'fix: c2' })).toBeInTheDocument()
    expect(calls).toContain(`/api/artifacts/art_b/commit?sha=${commit.sha}`)
    await user.click(within(dlg).getByRole('button', { name: '返回分支' }))
    expect(within(dlg).getByRole('list', { name: '分支提交' })).toBeInTheDocument()
    await user.click(within(dlg).getByRole('button', { name: '关闭查看' }))

    await user.click(within(rows[1]).getByRole('button', { name: '看提交' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('仓库取不到：仓库目录不在了')
  })
})
