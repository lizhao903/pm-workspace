// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ImConversationOption } from '../data'
import { convLabel, isPicked, orderChannels, removeToken, resolveChannels, splitChannelTokens, toggleChannel } from './channelPick'

const ch = (id: string, name: string, kind: ImConversationOption['kind'] = 'public'): ImConversationOption =>
  ({ id, name, kind, is_member: true, is_archived: false })
const product = ch('C01', 'product')
const random = ch('C02', 'Random')
const secret = ch('G01', 'secret-plan', 'private')
const group = ch('G02', 'mpdm-lin--zhou--me-1', 'mpim')
const items = [product, random, secret, group]

describe('监听频道的值', () => {
  it('拆法同后端：逗号、中文逗号、顿号、空白都算分隔，去 #，按去 # 后去重', () => {
    expect(splitChannelTokens(' #product, C02，#feedback、 ops\nC02 #product ')).toEqual([
      { raw: '#product', key: 'product' }, { raw: 'C02', key: 'C02' }, { raw: '#feedback', key: 'feedback' }, { raw: 'ops', key: 'ops' },
    ])
    expect(splitChannelTokens('')).toEqual([])
  })

  it('旧值里的 #名字 按名字对上（不分大小写），编号按编号对上；对不上的单列出来', () => {
    const r = resolveChannels('#product,#random,C0B68D4PA79', items)
    expect(r.map((x) => x.item?.id)).toEqual(['C01', 'C02', undefined])
    expect(r[2].token.raw).toBe('C0B68D4PA79')
    expect(isPicked('#PRODUCT', product)).toBe(true)
  })

  it('勾上写编号，已有的不重复；取消时编号和名字一起去掉，别的项原样保留', () => {
    expect(toggleChannel('', product, true)).toBe('C01')
    expect(toggleChannel('#product, #feedback', secret, true)).toBe('#product,#feedback,G01')
    expect(toggleChannel('#product', product, true)).toBe('#product')
    expect(toggleChannel('#product, C01, #feedback', product, false)).toBe('#feedback')
    expect(removeToken('#gone,C01', 'gone')).toBe('C01')
  })

  it('显示名：频道带 #，多人私信列出人', () => {
    expect(convLabel(product)).toBe('#product')
    expect(convLabel(group)).toBe('lin、zhou、me')
    expect(convLabel(ch('G9', '', 'mpim'))).toBe('G9')
  })

  it('列表：已选的排前面，搜索认名字、显示名和编号，# 可带', () => {
    expect(orderChannels(items, 'G01,#random', '').map((c) => c.id)).toEqual(['C02', 'G01', 'C01', 'G02'])
    expect(orderChannels(items, '', '#prod').map((c) => c.id)).toEqual(['C01'])
    expect(orderChannels(items, '', 'zhou').map((c) => c.id)).toEqual(['G02'])
    expect(orderChannels(items, '', 'g01').map((c) => c.id)).toEqual(['G01'])
  })
})
