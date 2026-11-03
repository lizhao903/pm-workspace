import { describe, expect, it } from 'vitest'
import type { VideoDeal } from '../../core/data'
import { createBody, dealErrors, dealPatch, dealStats, draftOf, historyLine, money, payState, payText, quoteFill, splitDeals } from './dealModel'

const T = '2026-10-29T08:00:00Z'
const deal = (x: Partial<VideoDeal> = {}): VideoDeal => ({
  id: 'deal_1', project_id: 'obj_pj', brand: '远川科技', title: '试点上线短片', platforms: ['bilibili'], deliverables: '1 支横版', quote: 12000,
  currency: 'CNY', status: 'inquiry', video_ids: [], history: [{ status: 'inquiry', at: T }], created_at: T, updated_at: T, ...x,
})

describe('账期', () => {
  const today = '2026-10-29'
  it('已交付、7 天内提醒，过了标红，远的不提醒', () => {
    expect(payState(deal({ status: 'delivered', pay_due: '2026-11-01' }), today)).toEqual({ days: 3, tone: 'warn' })
    expect(payState(deal({ status: 'delivered', pay_due: '2026-10-27' }), today)).toEqual({ days: -2, tone: 'danger' })
    expect(payState(deal({ status: 'delivered', pay_due: '2026-11-20' }), today)).toBeNull()
    expect(payState(deal({ status: 'paid', pay_due: '2026-11-01' }), today)).toBeNull()
    expect(payState(deal({ status: 'delivered' }), today)).toBeNull()
  })
  it('一句话：账期、今天、交付、收款', () => {
    expect(payText(deal({ status: 'delivered', pay_due: '2026-11-01' }), today)).toEqual({ text: '3 天后到账期', tone: 'warn' })
    expect(payText(deal({ status: 'delivered', pay_due: '2026-10-29' }), today).text).toBe('今天到账期')
    expect(payText(deal({ status: 'delivered', pay_due: '2026-10-26' }), today)).toEqual({ text: '账期已过 3 天', tone: 'danger' })
    expect(payText(deal({ status: 'delivered', pay_due: '2026-12-01' }), today).text).toBe('2026-12-01 前收款')
    expect(payText(deal({ status: 'producing', deadline: '2026-11-05' }), today).text).toBe('2026-11-05 交付')
    expect(payText(deal({ status: 'paid' }), today).text).toBe('已收款')
    expect(payText(deal({ status: 'lost', deadline: '2026-11-05' }), today).text).toBe('-')
  })
})

describe('汇总和分组', () => {
  it('进行中金额、已收款只算人民币；账期快到的单数', () => {
    const xs = [
      deal({ id: 'a', quote: 9000 }), deal({ id: 'b', quote: 100, currency: 'USD' }), deal({ id: 'c', status: 'paid', quote: 5000 }),
      deal({ id: 'd', status: 'lost', quote: 7000, lost_reason: 'x' }), deal({ id: 'e', status: 'delivered', quote: 1000, pay_due: '2026-10-30' }),
    ]
    expect(dealStats(xs, '2026-10-29')).toEqual({ open: 3, openSum: 10000, paidSum: 5000, due: 1 })
    const s = splitDeals(xs)
    expect(s.open.map((d) => d.id).sort()).toEqual(['a', 'b', 'e'])
    expect(s.closed.map((d) => d.id).sort()).toEqual(['c', 'd'])
  })
  it('金额带币种符号', () => {
    expect(money({ quote: 12000, currency: 'CNY' })).toBe('¥12,000')
    expect(money({ quote: 800, currency: 'USD' })).toBe('$800')
  })
})

describe('草稿', () => {
  it('校验：品牌、名称、项目、丢单原因、已收款不能丢单，只取第一条', () => {
    const d = draftOf(null)
    expect(dealErrors(d)[0]).toBe('品牌必填')
    expect(dealErrors({ ...d, brand: 'x', title: 'y' })).toEqual(['选一个项目'])
    expect(dealErrors({ ...d, brand: 'x', title: 'y', project_id: 'p', status: 'lost' })).toEqual(['写一下丢单原因'])
    expect(dealErrors({ ...d, brand: 'x', title: 'y', project_id: 'p', status: 'lost', lost_reason: 'r' }, { status: 'paid' })).toEqual(['已收款的商单不能丢单'])
  })
  it('新建 body 不带没填的可选字段，带来源消息', () => {
    const b = createBody({ ...draftOf(null, { project_id: 'p', source_message_id: 'msg_1' }), brand: ' 远川 ', title: '片子' })
    expect(b).toEqual({ project_id: 'p', brand: '远川', title: '片子', platforms: [], deliverables: '', quote: 0, currency: 'CNY', status: 'inquiry', video_ids: [], source_message_id: 'msg_1' })
  })
  it('只传改的字段，清空的可选字段传 null', () => {
    const d = deal({ contact_id: 'stk_a', pay_due: '2026-11-01' })
    expect(dealPatch(d, draftOf(d))).toEqual({})
    expect(dealPatch(d, { ...draftOf(d), contact_id: '', pay_due: '', status: 'quoted', video_ids: ['vd_1'], quote: 13000 }))
      .toEqual({ contact_id: null, pay_due: null, status: 'quoted', video_ids: ['vd_1'], quote: 13000 })
    expect(dealPatch(d, { ...draftOf(d), status: 'lost', lost_reason: '预算没批' })).toEqual({ status: 'lost', lost_reason: '预算没批' })
  })
  it('报价填入取整到百，历史一行最多四条', () => {
    expect(quoteFill(4550)).toBe(4600)
    expect(historyLine([{ status: 'delivered', at: T }, { status: 'quoted', at: T }, { status: 'inquiry', at: T }], () => '1 天前'))
      .toBe('已交付 1 天前 · 已报价 1 天前 · 询价 1 天前')
  })
})
