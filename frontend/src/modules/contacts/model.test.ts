import { describe, expect, it } from 'vitest'
import type { Contact, Dictionary } from '../../core/data'
import {
  DEFAULT_GROUP, GONE_COLOR, SEG_MAX, ago, blankDraft, deleteBlock, groupOptions, mergeIm, validate, applyFilter, groupItems, groupsOf, groupView, joinGroups, toggleGroup, hasImField, recentBucket, sectionCounts,
  defaultSort, sectionOf, toRows, type Filter, type GroupItem,
} from './model'

let seq = 0
function ct(p: Partial<Contact>): Contact {
  seq += 1
  return {
    id: `stk_${seq}`, name: `人${seq}`, role: '', email: '', note: '', color: '', sort_order: 0, archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', owned_count: 0, participating_count: 0,
    group: '', company: '', title: '', phone: '', tags: [], photo: '', starred: false, last_contact_at: null, ...p,
  }
}
const F: Filter = { q: '', group: null, starredOnly: false, channel: '', sort: 'recent' }
const names = (rows: ReturnType<typeof toRows>) => rows.map((r) => r.c.name)

describe('搜索', () => {
  const rows = toRows([
    ct({ name: '许知行', company: '远川科技', title: 'IT 总监', phone: '137 2233 4405', email: 'xu.zx@yuanchuan.example', tags: ['试点'] }),
    ct({ name: 'Alice Wang', company: 'Northwind', im: { telegram: '@alice_w' } }),
    ct({ name: '周岚' }),
  ])
  it('匹配姓名、公司、职位、电话、邮箱、标签、IM 编号，不区分大小写', () => {
    for (const q of ['许知', '远川', 'it 总监', '137 2233', 'XU.ZX', '试点']) expect(names(applyFilter(rows, { ...F, q })), q).toEqual(['许知行'])
    expect(names(applyFilter(rows, { ...F, q: 'ALICE_W' }))).toEqual(['Alice Wang'])
    expect(names(applyFilter(rows, { ...F, q: 'northwind' }))).toEqual(['Alice Wang'])
  })
  it('电话忽略空格：输「13722」能搜到「137 2233 4405」', () => {
    expect(names(applyFilter(rows, { ...F, q: '13722' }))).toEqual(['许知行'])
    expect(names(applyFilter(rows, { ...F, q: ' 1372 2334 ' }))).toEqual(['许知行'])
  })
  it('备注和角色也搜；多个词按空格拆开，每个词都要命中，可以跨字段', () => {
    const rs = toRows([
      ct({ name: '周七', company: 'Northstar', tags: ['Acme'], note: 'fleetent 团队负责人\n别名：Randy、乐哥' }),
      ct({ name: 'Abby Chua', role: '产品 / 文案，Globex 信用卡运营执行' }),
      ct({ name: '周岚', company: 'Globex' }),
    ])
    expect(names(applyFilter(rs, { ...F, q: 'randy' }))).toEqual(['周七'])
    expect(names(applyFilter(rs, { ...F, q: 'Fleetent' }))).toEqual(['周七'])
    expect(names(applyFilter(rs, { ...F, q: 'globex 信用卡' }))).toEqual(['Abby Chua'])
    expect(names(applyFilter(rs, { ...F, q: 'acme  乐哥' }))).toEqual(['周七'])
    expect(names(applyFilter(rs, { ...F, q: 'Globex', sort: 'name' }))).toEqual(['Abby Chua', '周岚'])
    expect(applyFilter(rs, { ...F, q: 'Globex 乐哥' })).toEqual([])
  })
  it('空白搜索词不过滤', () => {
    expect(applyFilter(rows, { ...F, q: '   ' })).toHaveLength(3)
  })
})

describe('筛选', () => {
  const rows = toRows([
    ct({ name: 'A', group: '客户', starred: true, im: { wechat: 'a' } }),
    ct({ name: 'B', group: '同事' }),
    ct({ name: 'C', group: '' }),
  ])
  it('分组、星标、渠道', () => {
    expect(names(applyFilter(rows, { ...F, group: '客户' }))).toEqual(['A'])
    expect(names(applyFilter(rows, { ...F, starredOnly: true }))).toEqual(['A'])
    expect(names(applyFilter(rows, { ...F, channel: 'wechat' }))).toEqual(['A'])
    expect(names(applyFilter(rows, { ...F, channel: 'qq' }))).toEqual([])
  })
  it('没分组的按默认分组「其他」算', () => {
    expect(groupsOf(rows[2].c)).toEqual([DEFAULT_GROUP])
    expect(names(applyFilter(rows, { ...F, group: '其他' }))).toEqual(['C'])
  })
  it('一人多个分组：「、」拆开，按包含匹配，两边都能筛到（B-03）', () => {
    const rs = toRows([
      ct({ name: '甲', group: 'Acme' }),
      ct({ name: '乙', group: 'Globex' }),
      ct({ name: '丙', group: 'Acme、Globex' }),
      ct({ name: '丁', group: ' Globex , Acme，Globex ' }),
    ])
    expect(groupsOf(rs[2].c)).toEqual(['Acme', 'Globex'])
    expect(groupsOf(rs[3].c)).toEqual(['Globex', 'Acme'])
    expect(names(applyFilter(rs, { ...F, group: 'Acme', sort: 'name' }))).toEqual(['丙', '丁', '甲'])
    expect(names(applyFilter(rs, { ...F, group: 'Globex', sort: 'name' }))).toEqual(['丙', '丁', '乙'])
    expect(applyFilter(rs, { ...F, group: 'Acme、Globex' })).toEqual([])
    const v = groupView([], rs.map((r) => r.c))
    expect(v.seg.map((g) => g.key)).toEqual(['Acme', 'Globex'])
    expect([v.countOf('Acme'), v.countOf('Globex')]).toEqual([3, 3])
    expect(joinGroups(['Acme', 'Globex'])).toBe('Acme、Globex')
  })
  it('接口没有 im 字段时不显示渠道', () => {
    expect(hasImField(rows.map((r) => r.c))).toBe(true)
    expect(hasImField([ct({})])).toBe(false)
  })
})

describe('排序和分段', () => {
  it('按姓名：英文名和中文名按首字母混排，# 最后，同字母内按中文排序', () => {
    const rows = toRows(['张三', 'zoe', '王五', 'Bob', '安娜', '123', '曾国强', '单雄', '@x', '陈一', 'Carl'].map((name) => ct({ name })))
    const sorted = applyFilter(rows, { ...F, sort: 'name' })
    expect(sorted.map((r) => r.initial)).toEqual(['A', 'B', 'C', 'C', 'S', 'W', 'Z', 'Z', 'Z', '#', '#'])
    // 同字母内按 zh-CN 排序规则：汉字在拉丁字母前
    expect(names(sorted).slice(0, 5)).toEqual(['安娜', 'Bob', '陈一', 'Carl', '单雄'])
    expect(names(sorted).slice(-2).sort()).toEqual(['123', '@x'].sort())
    const counts = sectionCounts(sorted, 'name')
    expect(counts.get('Z')).toBe(3)
    expect(counts.get('#')).toBe(2)
  })

  it('按最近联系：倒序，没联系过的最后', () => {
    const rows = toRows([
      ct({ name: '甲', last_contact_at: null }),
      ct({ name: '乙', last_contact_at: '2026-10-20T10:00:00Z' }),
      ct({ name: '丙', last_contact_at: '2026-10-28T10:00:00Z' }),
    ])
    expect(names(applyFilter(rows, F))).toEqual(['丙', '乙', '甲'])
  })

  it('最近联系的分段：今天、本周（周一起）、本月、更早、未联系', () => {
    // 2026-10-29 是周四
    const now = new Date(2026, 9, 29, 15, 0)
    expect(recentBucket(new Date(2026, 9, 29, 0, 5).toISOString(), now)).toBe('今天')
    expect(recentBucket(new Date(2026, 9, 26, 9, 0).toISOString(), now)).toBe('本周')
    expect(recentBucket(new Date(2026, 9, 25, 23, 0).toISOString(), now)).toBe('本月')
    expect(recentBucket(new Date(2026, 8, 30, 12, 0).toISOString(), now)).toBe('更早')
    expect(recentBucket(null, now)).toBe('未联系')
    const r = toRows([ct({ name: '甲' })])[0]
    expect(sectionOf(r, 'recent', now)).toBe('未联系')
    expect(sectionOf(r, 'name', now)).toBe('J')
  })

  it('相对时间按日历日', () => {
    const now = new Date(2026, 9, 29, 0, 30)
    expect(ago(new Date(2026, 9, 28, 23, 50).toISOString(), now)).toBe('昨天')
    expect(ago(new Date(2026, 9, 29, 0, 1).toISOString(), now)).toBe('今天')
    expect(ago(new Date(2026, 9, 19, 12).toISOString(), now)).toBe('10 天前')
    expect(ago(new Date(2026, 6, 25).toISOString(), now)).toBe('3 个月前')
    expect(ago(new Date(2024, 9, 1).toISOString(), now)).toBe('2 年前')
    expect(ago(null, now)).toBeNull()
  })
})

describe('分组切换', () => {
  const item = (key: string, enabled = true): GroupItem => ({ key, label: key, color: '', enabled })

  it('没有字典时用内置五组；有字典按 sort_order，归档的算停用', () => {
    expect(groupItems(undefined).map((g) => g.key)).toEqual(['客户', '合作伙伴', '同事', '供应商', '其他'])
    const dict = {
      id: 'contact_group', items: [
        { key: 'b', label: '乙', color: '', sort_order: 2, archived_at: '2026-01-01T00:00:00Z' },
        { key: 'a', label: '甲', color: 'red', sort_order: 1, archived_at: null },
      ],
    } as unknown as Dictionary
    expect(groupItems([dict])).toEqual([
      { key: 'a', label: '甲', color: 'red', enabled: true },
      { key: 'b', label: '乙', color: GONE_COLOR, enabled: false },
    ])
  })

  it('停用但还有人的照样列出，没人的停用分组不列；字典里没有的分组值排最后', () => {
    const v = groupView([item('客户'), item('旧', false), item('空', false)], [ct({ group: '旧' }), ct({ group: '朋友' }), ct({ group: '客户' })])
    expect(v.seg.map((g) => g.key)).toEqual(['客户', '旧', '朋友'])
    expect(v.more).toEqual([])
    expect(v.countOf('朋友')).toBe(1)
  })

  it(`多于 ${SEG_MAX + 1} 个分组时只放人数最多的 ${SEG_MAX} 个，保持枚举顺序，其余进「更多分组」`, () => {
    const items = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'].map((k) => item(k))
    const people = [
      ...Array.from({ length: 1 }, () => ct({ group: 'g1' })),
      ...Array.from({ length: 7 }, () => ct({ group: 'g2' })),
      ...Array.from({ length: 6 }, () => ct({ group: 'g3' })),
      ...Array.from({ length: 5 }, () => ct({ group: 'g4' })),
      ...Array.from({ length: 4 }, () => ct({ group: 'g6' })),
      ...Array.from({ length: 3 }, () => ct({ group: 'g7' })),
    ]
    const v = groupView(items, people)
    expect(v.seg.map((g) => g.key)).toEqual(['g2', 'g3', 'g4', 'g6', 'g7'])
    expect(v.more.map((g) => g.key)).toEqual(['g1', 'g5'])
    // 正好 SEG_MAX + 1 个时全放进切换
    const six = items.slice(0, SEG_MAX + 1).map((g) => g.key)
    expect(groupView(items.slice(0, SEG_MAX + 1), people.filter((c) => six.includes(c.group))).more).toEqual([])
  })
})

describe('抽屉（CT-03b）', () => {
  it('校验：姓名必填，邮箱非空时要像邮箱，电话不管', () => {
    expect(validate(blankDraft())).toEqual({ name: '姓名必填', email: '' })
    expect(validate({ ...blankDraft(), name: ' 许 ', email: 'x@y', phone: 'abc' })).toEqual({ name: '', email: '邮箱格式不对' })
    expect(validate({ ...blankDraft(), name: '许', email: 'xu@a.example' })).toEqual({ name: '', email: '' })
  })

  it('删除检查：有负责或参与的事就拦下，提示改为归档', () => {
    expect(deleteBlock({ name: '许', owned_count: 0, participating_count: 0 })).toBeNull()
    expect(deleteBlock({ name: '许', owned_count: 2, participating_count: 1 })).toMatch(/还负责 2 件事、参与 1 件事，不能删除。可以改为归档/)
    expect(deleteBlock({ name: '许', owned_count: 0, participating_count: 3 })).toMatch(/参与 3 件事/)
  })

  it('分组选项：启用的加上当前值（停用或字典里没有的也留着）', () => {
    const items = [{ key: '客户', label: '客户', color: '#000', enabled: true }, { key: '旧', label: '旧', color: '#000', enabled: false }]
    expect(groupOptions(items, ['客户']).map((g) => g.key)).toEqual(['客户'])
    expect(groupOptions(items, ['旧']).map((g) => g.key)).toEqual(['客户', '旧'])
    expect(groupOptions(items, ['没了']).map((g) => g.key)).toEqual(['客户', '没了'])
    expect(groupOptions(items, ['旧', '没了']).map((g) => g.key)).toEqual(['客户', '旧', '没了'])
  })

  it('点分组：多选，按选项顺序排，最后一个去不掉', () => {
    const opts = ['客户', '同事', '其他'].map((k) => ({ key: k, label: k, color: '#000', enabled: true }))
    expect(toggleGroup(opts, ['其他'], '客户')).toEqual(['客户', '其他'])
    expect(toggleGroup(opts, ['客户', '其他'], '客户')).toEqual(['其他'])
    expect(toggleGroup(opts, ['其他'], '其他')).toEqual(['其他'])
  })

  it('身份合进联系人：接口不能用时 im 保持 undefined', () => {
    const c = { id: 'stk_a' } as never
    expect(mergeIm([c], null)[0]).toBe(c)
    expect(mergeIm([c], new Map())[0]).toMatchObject({ im: {} })
  })
})

describe('默认排序', () => {
  const at = '2026-01-01T00:00:00Z'
  it('没联系过的人多于一半按姓名，否则按最近联系', () => {
    expect(defaultSort([])).toBe('recent')
    expect(defaultSort([ct({}), ct({}), ct({ last_contact_at: at })])).toBe('name')
    expect(defaultSort([ct({}), ct({ last_contact_at: at })])).toBe('recent')
    expect(defaultSort(Array.from({ length: 62 }, () => ct({})))).toBe('name')
  })
})
