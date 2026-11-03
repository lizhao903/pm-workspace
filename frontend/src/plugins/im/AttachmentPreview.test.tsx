import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage } from '../../core/data'
import { AttachmentPanel } from './AttachmentPanel'

// 附件预览弹窗（SPEC-messages-3.16）：图片、PDF 带 inline 读，文本读出来显示，不能预览的只给下载；
// 没获取的在弹窗里获取后接着看；← → 切换，Esc 关掉
const base = {
  id: 'msg_1', channel: 'slack', connector_id: '', external_id: 'x', conversation_id: 'cv_prod', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin', identity_id: null, stakeholder_id: null, contact_name: '',
  text: '', relevance: '', status: 'pending', read: false, snooze_until: null, at: '2026-10-29T01:00:00Z', received_at: '2026-10-29T01:00:00Z',
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', expired_at: null,
} as const
const done = (id: string, name: string, kind: 'file' | 'image') =>
  ({ id, name, kind, size: 10, fetch: 'done' as const, local: `/d/attachments/slack/${name}`, download_url: `/api/im/attachments/slack/${encodeURIComponent(name)}` })
const MSG = {
  ...base,
  attachments: [done('a1', '截屏.png', 'image'), done('a2', '日志.txt', 'file'), done('a3', '合同.pdf', 'file'), done('a4', '包.zip', 'file'),
    { id: 'a5', name: '新图.jpg', kind: 'image', size: 10, fetch: 'idle' }, { id: 'a6', name: 'Figma', kind: 'link', url: 'https://f.example' }],
} as unknown as ImMessage

let fetched: string[] = []
beforeEach(() => {
  fetched = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    const p = decodeURIComponent(u.pathname)
    if (p === '/api/plugins') return new Response(JSON.stringify({ data: [{ id: 'projects', running: false }] }))
    if (p === '/api/im/attachments/slack/日志.txt') return new Response('第一行\n第二行')
    if (p === '/api/im/messages/msg_1/attachments/a5/fetch') {
      fetched.push('a5')
      return new Response(JSON.stringify({ data: { ...MSG, attachments: MSG.attachments.map((a) => (a.id === 'a5' ? done('a5', '新图.jpg', 'image') : a)) } }))
    }
    return new Response(JSON.stringify({ data: [] }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><AttachmentPanel msg={MSG} /></QueryClientProvider>)
}
const rowOf = (name: string) => screen.getByText(name).closest('.im-att-row') as HTMLElement

describe('附件预览', () => {
  it('图片有缩略图，点预览打开弹窗，带 inline 读；← → 在文件之间切换，链接不算；Esc 关掉', async () => {
    renderPanel()
    const user = userEvent.setup()
    expect(within(rowOf('截屏.png')).getByRole('button', { name: '预览 截屏.png' }).querySelector('img')?.getAttribute('src')).toMatch(/inline=1$/)
    expect(within(rowOf('Figma')).queryByRole('button', { name: '预览' })).not.toBeInTheDocument()
    await user.click(within(rowOf('截屏.png')).getByRole('button', { name: '预览' }))
    let dlg = screen.getByRole('dialog', { name: '预览 截屏.png' })
    expect(within(dlg).getByRole('img', { name: '截屏.png' }).getAttribute('src')).toMatch(/inline=1$/)
    expect(within(dlg).getByText('图片 · 10 B · 1 / 5')).toBeInTheDocument()
    expect(within(dlg).getByRole('link', { name: '下载' }).getAttribute('href')).not.toMatch(/inline/)

    await user.keyboard('{ArrowRight}')
    dlg = screen.getByRole('dialog', { name: '预览 日志.txt' })
    expect(await within(dlg).findByText(/第一行/)).toBeInTheDocument()

    await user.keyboard('{ArrowRight}')
    dlg = screen.getByRole('dialog', { name: '预览 合同.pdf' })
    expect(dlg.querySelector('iframe')?.getAttribute('src')).toMatch(/inline=1$/)

    await user.click(within(dlg).getByRole('button', { name: '下一个附件' }))
    dlg = screen.getByRole('dialog', { name: '预览 包.zip' })
    expect(within(dlg).getByText(/不能在页面里看/)).toBeInTheDocument()
    expect(within(dlg).queryByRole('link', { name: '新窗口打开' })).not.toBeInTheDocument()

    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('dialog', { name: '预览 新图.jpg' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('没获取的：弹窗里「获取并预览」，取回来接着看', async () => {
    renderPanel()
    const user = userEvent.setup()
    await user.click(within(rowOf('新图.jpg')).getByRole('button', { name: '预览' }))
    const dlg = screen.getByRole('dialog', { name: '预览 新图.jpg' })
    expect(within(dlg).getByText(/获取到本地后就能看/)).toBeInTheDocument()
    await user.click(within(dlg).getByRole('button', { name: '获取并预览' }))
    await waitFor(() => expect(fetched).toEqual(['a5']))
  })
})
