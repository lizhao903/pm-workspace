import { describe, expect, it } from 'vitest'
import { arrangeFound, filterPalette, type PaletteItem } from './palette'

const it_ = (id: string, group: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, group, title, run: () => {}, ...extra })
const items = [
  it_('a', '操作', '切换到深色', { keywords: 'dark 主题' }),
  it_('b', '跳转', '任务', { sub: '功能模块' }),
  it_('c', '任务', 'TSK-1 修登录'),
  it_('d', '操作', '打开示例插件', { keywords: 'hello' }),
  it_('e', '跳转', '示例插件'),
]

describe('filterPalette', () => {
  it('没输入只显示操作和跳转两组，同组排在一起', () => {
    expect(filterPalette(items, '  ').map((x) => x.id)).toEqual(['a', 'd', 'b', 'e'])
  })

  it('按词匹配标题、副标题、关键词、组名，每个词都要命中', () => {
    expect(filterPalette(items, 'hello').map((x) => x.id)).toEqual(['d'])
    expect(filterPalette(items, '功能 任务').map((x) => x.id)).toEqual(['b'])
    expect(filterPalette(items, 'DARK').map((x) => x.id)).toEqual(['a'])
  })

  it('标题开头命中的排前面，所在组也跟着排前面', () => {
    expect(filterPalette(items, '示例').map((x) => x.id)).toEqual(['e', 'd'])
  })

  it('有输入时每组最多 6 条', () => {
    const many = Array.from({ length: 9 }, (_, i) => it_('m' + i, '任务', '任务 ' + i))
    expect(filterPalette(many, '任务')).toHaveLength(6)
  })
})

describe('arrangeFound', () => {
  it('按项目、任务、联系人、消息排组，其余组在后面，组内保持原顺序', () => {
    const found = [
      it_('u1', '联系人', '周七'),
      it_('x1', '文档', '周报'),
      it_('t1', '任务', 'TSK-1'),
      it_('u2', '联系人', '周七乐'),
      it_('t2', '任务', 'TSK-2'),
      it_('p1', '项目', 'Acme'),
    ]
    expect(arrangeFound(found).map((x) => x.id)).toEqual(['p1', 't1', 't2', 'u1', 'u2', 'x1'])
  })

  it('每组最多 6 条', () => {
    const many = Array.from({ length: 9 }, (_, i) => it_('m' + i, '联系人', '人 ' + i))
    expect(arrangeFound(many)).toHaveLength(6)
  })
})
