import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImConversationList } from '../data'
import { ChannelPicker } from './ChannelPicker'


const list: ImConversationList = {
  connector_id: 'cn_s', complete: true, note: '',
  items: [
    { id: 'C01', name: 'product', kind: 'public', is_member: true, is_archived: false },
    { id: 'C02', name: 'random', kind: 'public', is_member: true, is_archived: false },
    { id: 'G01', name: 'secret-plan', kind: 'private', is_member: true, is_archived: true },
    { id: 'G02', name: 'mpdm-lin--zhou--me-1', kind: 'mpim', is_member: true, is_archived: false },
  ],
}

function stub(res: () => Response) {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    paths.push(String(input).replace(/^https?:\/\/[^/]+/, ''))
    return res()
  }))
  return paths
}

// 最近一次存回的值（onChange 里记，不在渲染时改外部变量）
let last = ''
function Host({ initial, connectorId }: { initial: string; connectorId?: string }) {
  const [v, setV] = useState(initial)
  return <ChannelPicker label="监听频道" placeholder="#product, #feedback" connectorId={connectorId} value={v} onChange={(x) => { last = x; setV(x) }} />
}

function renderPicker(initial: string, connectorId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><Host initial={initial} connectorId={connectorId} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals(); last = '' })

describe('监听频道列表选择', () => {
  it('新建还没保存：只有文本框，提示先保存测试，不发请求', () => {
    const paths = stub(() => new Response('{}'))
    renderPicker('#product')
    expect(screen.getByLabelText('监听频道（文本）')).toHaveValue('#product')
    expect(screen.getByText('先保存并测试连接后可从列表选择')).toBeInTheDocument()
    expect(paths).toEqual([])
  })

  it('按已保存连接器列出；旧值的 #名字对上显示为已选并排前面，对不上的标未找到；勾选写编号，取消去掉', async () => {
    const paths = stub(() => new Response(JSON.stringify({ data: list })))
    renderPicker('#random, #gone', 'cn_s')
    const group = await screen.findByRole('group', { name: '监听频道列表' })
    expect(paths).toEqual(['/api/im/connectors/cn_s/conversations'])
    const rows = within(group).getAllByRole('checkbox')
    expect(rows.map((r) => r.closest('label')?.getAttribute('data-channel-id'))).toEqual(['C02', 'C01', 'G01', 'G02'])
    expect(rows[0]).toBeChecked()
    const picked = screen.getByLabelText('已选频道')
    expect(picked).toHaveTextContent('#random')
    expect(picked).toHaveTextContent('#gone未找到')
    expect(group).toHaveTextContent('私有频道')
    expect(group).toHaveTextContent('已归档')
    expect(group).toHaveTextContent('lin、zhou、me')

    await userEvent.click(within(group).getByRole('checkbox', { name: /#product/ }))
    expect(last).toBe('#random,#gone,C01')
    await userEvent.click(within(group).getByRole('checkbox', { name: /#random/ }))
    expect(last).toBe('#gone,C01')
    await userEvent.click(within(picked).getByRole('button', { name: '移除 #gone' }))
    expect(last).toBe('C01')

    // 搜索
    await userEvent.type(screen.getByLabelText('搜频道'), 'zhou')
    expect(within(group).getAllByRole('checkbox')).toHaveLength(1)
    // 手动填写
    await userEvent.click(screen.getByRole('button', { name: '手动填写' }))
    expect(screen.getByLabelText('监听频道（文本）')).toHaveValue('C01')
  })

  it('列表不完整时写出原因', async () => {
    stub(() => new Response(JSON.stringify({ data: { ...list, complete: false, note: 'Slack 限流，只列出了前 4 个，稍后再刷新' } })))
    renderPicker('', 'cn_s')
    expect(await screen.findByText('Slack 限流，只列出了前 4 个，稍后再刷新')).toBeInTheDocument()
    expect(screen.getByText('还没选，只收私信和多人私信')).toBeInTheDocument()
  })

  it('拿不到列表（没填 Token 等）退回文本框，写原因，可以重试', async () => {
    const paths = stub(() => new Response(JSON.stringify({ error: { code: 'conflict', message: '连接器「公司 Slack」还没填 Token', reason: 'no_token' } }), { status: 409 }))
    renderPicker('C01', 'cn_s')
    expect(await screen.findByText(/没能读取频道列表：.*还没填 Token/)).toBeInTheDocument()
    const input = screen.getByLabelText('监听频道（文本）')
    await userEvent.type(input, ',C02')
    expect(last).toBe('C01,C02')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(paths.length).toBe(2)
  })
})
