// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 流程库的文件夹（TSK-0482）：筛选、搜索跨文件夹、新建、删非空文件夹先确认、卡片移到文件夹
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow, SopFolder } from '../../core/data'
import { Library } from './Library'
import { FOLDER_NONE, folderChips, folderNameError, libraryRows, type FolderKey } from './model'

const flow = (id: string, name: string, folder_id: string | null): SopFlow => ({
  id, name, desc: '', trigger: 'manual', fields: [], steps: [{ key: 'a', name: '甲', kind: 'auto' }], version: 1, created_at: '', updated_at: '', folder_id,
})
const folder = (id: string, name: string): SopFolder => ({ id, name, count: 0, created_at: '', updated_at: '' })

const FOLDERS = [folder('sfd_pm', '产品经理'), folder('sfd_v', '视频博主')]
const FLOWS = [
  flow('sop_a', '产品经理 · 写周报', 'sfd_pm'),
  flow('sop_b', '产品经理 · 需求评审', 'sfd_pm'),
  flow('sop_c', '视频博主 · 选题', 'sfd_v'),
  flow('sop_d', '消息分诊', null),
  flow('sop_e', '孤儿', 'sfd_gone'),
]

type Call = { method: string; path: string; body?: unknown }

function stubFetch() {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
    if (u.pathname === '/api/sop/folders' && method === 'POST') return ok({ ...folder('sfd_new', body.name) }, 201)
    if (u.pathname.startsWith('/api/sop/folders/') && method === 'DELETE') return ok({ moved: 2 })
    if (u.pathname === '/api/sop/flows/move') return ok({ moved: body.flow_ids.length })
    return ok([])
  }))
  return calls
}

function Harness({ initial = '' as FolderKey, onFolder }: { initial?: FolderKey; onFolder?: (k: FolderKey) => void }) {
  const [k, setK] = useState<FolderKey>(initial)
  return (
    <Library flows={FLOWS} folders={FOLDERS} folder={k} onFolder={(x) => { setK(x); onFolder?.(x) }} stats={new Map()} needs={() => []}
      trigger={(t) => t} onOpen={() => {}} onNew={() => {}} now={Date.now()} />
  )
}

function renderLib(props: Parameters<typeof Harness>[0] = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Harness {...props} /></QueryClientProvider>)
}

const cardNames = () => [...document.querySelectorAll('.sop-lib-name')].map((x) => x.textContent)
const bar = () => screen.getByRole('group', { name: '按文件夹筛选' })

afterEach(() => vi.unstubAllGlobals())

describe('流程库的文件夹（TSK-0482）', () => {
  it('model：数量按全部流程算，指向已删文件夹的算未分类；名字规则同后端', () => {
    expect(folderChips(FLOWS, FOLDERS).map((c) => `${c.label}${c.count}`)).toEqual(['产品经理2', '视频博主1', '未分类2'])
    expect(folderNameError(' ', FOLDERS)).toBe('文件夹名称不能为空')
    expect(folderNameError('未分类', FOLDERS)).toBe('「未分类」是界面上已经占用的叫法，换个名字')
    expect(folderNameError('长'.repeat(31), FOLDERS)).toBe('文件夹名称最多 30 字')
    expect(folderNameError('产品经理', FOLDERS)).toBe('已经有叫「产品经理」的文件夹了')
    expect(folderNameError('产品经理', FOLDERS, 'sfd_pm')).toBe('')
    // 搜索不看文件夹，文件夹名也能搜到
    const rows = (k: FolderKey, q: string) => libraryRows(FLOWS, new Map(), '', q, {
      folder: (f) => (k === FOLDER_NONE ? !f.folder_id || f.folder_id === 'sfd_gone' : !k || f.folder_id === k),
      folderName: (f) => FOLDERS.find((x) => x.id === f.folder_id)?.name ?? '',
    }).map((f) => f.id)
    expect(rows('sfd_v', '')).toEqual(['sop_c'])
    expect(rows('sfd_v', '周报')).toEqual(['sop_a'])
    expect(rows('', '视频博主').sort()).toEqual(['sop_c'])
  })

  it('点文件夹筛选，再点回到全部；未分类含指向已删文件夹的；搜索时在全部文件夹里找', async () => {
    stubFetch()
    const user = userEvent.setup()
    const onFolder = vi.fn()
    renderLib({ onFolder })
    expect(within(bar()).getByRole('button', { name: /全部\s*5/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(bar()).getByRole('button', { name: /^产品经理\s*2$/ }))
    expect(onFolder).toHaveBeenLastCalledWith('sfd_pm')
    expect(cardNames()).toEqual(['产品经理 · 写周报', '产品经理 · 需求评审'])
    await user.click(within(bar()).getByRole('button', { name: /^产品经理\s*2$/ }))
    expect(onFolder).toHaveBeenLastCalledWith('')
    await user.click(within(bar()).getByRole('button', { name: /未分类\s*2/ }))
    expect(cardNames().sort()).toEqual(['孤儿', '消息分诊'])
    await user.type(screen.getByRole('textbox', { name: '搜索流程' }), '选题')
    expect(cardNames()).toEqual(['视频博主 · 选题'])
    expect(screen.getByText('搜索时在全部文件夹里找')).toBeInTheDocument()
  })

  it('新建文件夹：重名、保留名不让存；存上后选中新文件夹', async () => {
    const calls = stubFetch()
    const user = userEvent.setup()
    const onFolder = vi.fn()
    renderLib({ onFolder })
    await user.click(screen.getByRole('button', { name: '新建文件夹' }))
    const input = screen.getByRole('textbox', { name: '文件夹名称' })
    await user.type(input, '视频博主')
    expect(screen.getByRole('alert')).toHaveTextContent('已经有叫「视频博主」的文件夹了')
    expect(screen.getByRole('button', { name: '新建' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '商务对接{Enter}')
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/sop/folders')?.body).toEqual({ name: '商务对接' })
    expect(onFolder).toHaveBeenLastCalledWith('sfd_new')
  })

  it('删非空文件夹先确认，写明流程回未分类；确认后删', async () => {
    const calls = stubFetch()
    const user = userEvent.setup()
    renderLib({ initial: 'sfd_pm' })
    await user.click(screen.getByRole('button', { name: '改名或删除「产品经理」' }))
    await user.click(screen.getByRole('button', { name: '删除文件夹' }))
    const dlg = screen.getByRole('alertdialog')
    expect(dlg).toHaveTextContent('删除文件夹「产品经理」？')
    expect(dlg).toHaveTextContent('里面的 2 个流程移到「未分类」，流程本身不删、不改')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await user.click(within(dlg).getByRole('button', { name: '删除文件夹' }))
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/sop/folders/sfd_pm')
  })

  it('卡片上点文件夹名移到别的文件夹，只调移动接口', async () => {
    const calls = stubFetch()
    const user = userEvent.setup()
    renderLib()
    await user.click(screen.getByRole('button', { name: '「消息分诊」移到文件夹' }))
    await user.click(screen.getByRole('option', { name: /视频博主/ }))
    expect(calls.find((c) => c.path === '/api/sop/flows/move')?.body).toEqual({ flow_ids: ['sop_d'], folder_id: 'sfd_v' })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
})
