// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { SopNodeType, SopStepDef } from '../../core/data'
import { COL_GAP, NW, PORT_Y, START, autoLayout, canvasEdges, catalogOf, nodeH, outY, type Catalog, type Draft, type Layout } from './edit'
import { crossings, layeredY, settle, type Segment } from './layout'
import { LAYOUT_FIXTURES } from './layoutFixtures'
import { ranks } from './model'

const step = (key: string, kind: string, after: string[] = [], extra: Partial<SopStepDef> = {}): SopStepDef => ({ key, name: key, kind, desc: '', after, ...extra })
const draft = (steps: SopStepDef[]): Draft => ({ name: '流程', desc: '', trigger: '手动', fields: [{ key: 'input', label: '输入', type: 'textarea' }], steps })

/** 样本里带出口的 kind 当成分支节点 */
function fixtureDraft(id: string): { d: Draft; cat: Catalog } {
  const steps = LAYOUT_FIXTURES[id].map((s) => step(s.key, s.kind, s.after ?? [], {
    ...(s.branch ? { branch: s.branch } : {}),
    ...(s.cases ? { cases: s.cases.map((k) => ({ key: k, label: k })) } : {}),
  }))
  const kinds = [...new Set(steps.map((s) => s.kind))]
  const types: SopNodeType[] = kinds.map((kind) => ({ kind, group: '基础', branching: steps.some((s) => s.kind === kind && s.cases), required: [] }))
  return { d: draft(steps), cat: catalogOf(types) }
}

/** 改版前的自动整理：按依赖分列，每列按步骤顺序从上往下、整列垂直居中（对照用） */
function oldLayout(d: Draft, cat: Catalog): Layout {
  const rk = ranks(d)
  const cols: string[][] = []
  d.steps.forEach((s, i) => { (cols[rk[i]] ??= []).push(s.key) })
  const filled = Array.from(cols, (c) => c ?? [])
  const out: Layout = { [START]: { x: 60, y: 0 } }
  const heights = filled.map((c) => c.reduce((a, k) => a + nodeH(d, cat, k) + 28, -28))
  const tallest = Math.max(nodeH(d, cat, START), ...heights)
  out[START].y = 80 + (tallest - nodeH(d, cat, START)) / 2
  filled.forEach((col, c) => {
    let y = 80 + (tallest - heights[c]) / 2
    col.forEach((k) => { out[k] = { x: 60 + (c + 1) * (NW + COL_GAP), y }; y += nodeH(d, cat, k) + 28 })
  })
  return out
}

/** 画布上实际画出的连线（出口到入口，按直线算） */
const segsOf = (d: Draft, lay: Layout): Segment[] => canvasEdges(d).map((e) => ({
  a: { x: lay[e.from].x + NW, y: lay[e.from].y + outY(d, e.from, e.caseKey) },
  b: { x: lay[e.to].x, y: lay[e.to].y + PORT_Y },
}))

/** 同一列（x 相同）的节点上下不重叠 */
function overlaps(d: Draft, cat: Catalog, lay: Layout) {
  const keys = [START, ...d.steps.map((s) => s.key)]
  const bad: string[] = []
  for (const a of keys) {
    for (const b of keys) {
      if (a >= b || lay[a].x !== lay[b].x) continue
      const [p, q] = lay[a].y <= lay[b].y ? [a, b] : [b, a]
      if (lay[p].y + nodeH(d, cat, p) + 28 > lay[q].y + 0.5) bad.push(`${p}/${q}`)
    }
  }
  return bad
}

const cat0 = catalogOf([
  { kind: 'auto', group: '基础', branching: false, required: [] },
  { kind: 'aggregate', group: '基础', branching: false, required: [] },
  { kind: 'decide', group: '逻辑', branching: true, default_cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], required: [] },
])

describe('自动布局', () => {
  it('直线链：从开始往右一列一个，纵向拉成一条直线', () => {
    const d = draft([step('a', 'auto'), step('b', 'auto', ['a']), step('c', 'auto', ['b'])])
    const lay = autoLayout(d, cat0)
    expect([lay.a.x, lay.b.x, lay.c.x]).toEqual([60 + (NW + COL_GAP), 60 + 2 * (NW + COL_GAP), 60 + 3 * (NW + COL_GAP)])
    expect(lay.b.y).toBe(lay.a.y)
    expect(lay.c.y).toBe(lay.a.y)
    // 开始节点的出口对着第一步的入口
    expect(lay[START].y + PORT_Y).toBe(lay.a.y + PORT_Y)
  })

  it('分支三出口：下游按出口顺序从上往下排，和步骤顺序无关；不重叠，没有交叉', () => {
    const cases = [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'z', label: 'Z' }]
    const d = draft([
      step('d', 'decide', [], { cases }),
      step('cz', 'auto', ['d'], { branch: { of: 'd', case: 'z' } }),
      step('cx', 'auto', ['d'], { branch: { of: 'd', case: 'x' } }),
      step('cy', 'auto', ['d'], { branch: { of: 'd', case: 'y' } }),
      step('tz', 'auto', ['cz']),
      step('tx', 'auto', ['cx']),
    ])
    const lay = autoLayout(d, cat0)
    expect(lay.cx.y).toBeLessThan(lay.cy.y)
    expect(lay.cy.y).toBeLessThan(lay.cz.y)
    // 单父单子拉直
    expect(lay.tx.y).toBe(lay.cx.y)
    expect(lay.tz.y).toBe(lay.cz.y)
    expect(overlaps(d, cat0, lay)).toEqual([])
    expect(crossings(segsOf(d, lay))).toBe(0)
    // 旧排法按步骤顺序，z 出口的排在最上面，会交叉
    expect(crossings(segsOf(d, oldLayout(d, cat0)))).toBeGreaterThan(0)
  })

  it('汇合：放在几路上游的中间', () => {
    const d = draft([
      step('a', 'auto'), step('b1', 'auto', ['a']), step('b2', 'auto', ['a']), step('b3', 'auto', ['a']),
      step('j', 'aggregate', ['b1', 'b2', 'b3']),
    ])
    const lay = autoLayout(d, cat0)
    const mid = (lay.b1.y + lay.b2.y + lay.b3.y) / 3
    expect(Math.abs(lay.j.y - mid)).toBeLessThanOrEqual(1)
    // 分叉的上游也在几路下游中间
    expect(Math.abs(lay.a.y - mid)).toBeLessThanOrEqual(1)
    expect(overlaps(d, cat0, lay)).toEqual([])
  })

  it('跨层长边：长边经过的列给它让出顺序，不和短边交叉', () => {
    // a 直连 e（跨三列），另一路 a → b → c → d → e；还有一路 a → x → y 放在下面
    const d = draft([
      step('a', 'auto'), step('x', 'auto', ['a']), step('b', 'auto', ['a']), step('y', 'auto', ['x']),
      step('c', 'auto', ['b']), step('d', 'auto', ['c']), step('e', 'aggregate', ['a', 'd']),
    ])
    const lay = autoLayout(d, cat0)
    expect(crossings(segsOf(d, lay))).toBe(0)
    expect(overlaps(d, cat0, lay)).toEqual([])
  })

  it('环：不死循环，位置都是有限数，不重叠', () => {
    const d = draft([step('a', 'auto', ['b']), step('b', 'auto', ['a']), step('c', 'auto', ['b'])])
    const lay = autoLayout(d, cat0)
    for (const k of [START, 'a', 'b', 'c']) expect(Number.isFinite(lay[k].x) && Number.isFinite(lay[k].y)).toBe(true)
    expect(overlaps(d, cat0, lay)).toEqual([])
  })

  it('空流程只有开始节点', () => {
    expect(autoLayout(draft([]), cat0)).toEqual({ [START]: { x: 60, y: 80 } })
  })

  it('同一输入多次排结果一样', () => {
    const { d, cat } = fixtureDraft('sop_im_dev_pipeline')
    expect(autoLayout(d, cat)).toEqual(autoLayout(d, cat))
  })

  describe('真实流程：交叉不比旧排法多，同列不重叠，分支下游按出口顺序', () => {
    for (const id of Object.keys(LAYOUT_FIXTURES)) {
      it(id, () => {
        const { d, cat } = fixtureDraft(id)
        const lay = autoLayout(d, cat)
        const now = crossings(segsOf(d, lay))
        const before = crossings(segsOf(d, oldLayout(d, cat)))
        expect(now).toBeLessThanOrEqual(before)
        expect(overlaps(d, cat, lay)).toEqual([])
        // 同一分支节点的各出口直接连的下游：出口靠上的，下游也靠上
        for (const s of d.steps.filter((x) => x.cases?.length)) {
          const kids = d.steps.filter((x) => x.branch?.of === s.key)
            .map((x) => ({ i: s.cases!.findIndex((c) => c.key === x.branch!.case), y: lay[x.key].y, x: lay[x.key].x }))
          for (const a of kids) for (const b of kids) if (a.i < b.i && a.x === b.x) expect(a.y).toBeLessThan(b.y)
        }
      })
    }
  })
})

describe('布局工具', () => {
  it('settle：保序、不重叠、尽量贴近想要的位置', () => {
    expect(settle([0, 0, 0], [10, 10, 10])).toEqual([-10, 0, 10])
    expect(settle([0, 100], [10, 10])).toEqual([0, 100])
    expect(settle([50, 0], [10, 10])).toEqual([20, 30])
  })

  it('layeredY：只有一个节点时在 0；同列往回的边忽略', () => {
    expect(layeredY([{ key: 'a', rank: 0, h: 10 }], [])).toEqual({ a: 0 })
    const ys = layeredY([{ key: 'a', rank: 0, h: 10 }, { key: 'b', rank: 0, h: 10 }], [{ from: 'a', to: 'b', out: 5, in: 5 }], 4)
    expect(ys).toEqual({ a: 0, b: 14 })
  })

  it('crossings：交叉的两条算一次，共用端点的不算', () => {
    const p = (x: number, y: number) => ({ x, y })
    expect(crossings([{ a: p(0, 0), b: p(10, 10) }, { a: p(0, 10), b: p(10, 0) }])).toBe(1)
    expect(crossings([{ a: p(0, 0), b: p(10, 10) }, { a: p(0, 0), b: p(10, 0) }])).toBe(0)
    expect(crossings([{ a: p(0, 0), b: p(10, 0) }, { a: p(0, 10), b: p(10, 10) }])).toBe(0)
  })
})
