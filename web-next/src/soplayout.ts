// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 分层自动布局（SPEC-sop-8.15）：编排画布（sopedit.tsx）和只读流程图（sop.tsx FlowGraph）共用，照正式前端 frontend/src/plugins/sop/layout.ts。列（层）由调用方按依赖给定，这里只排每列内的上下顺序和纵坐标。
// 1. 跨多列的长边在中间各列插虚拟节点（不画，高度 0，只占一个间距），长边从它们中间穿过，旁边的节点给它让道；
//    同列或往回的边（环）不参与排版
// 2. 列内顺序：按上游（往下扫）/ 下游（往上扫）的重心多轮排序，每轮后相邻交换消交叉，保留交叉最少的一轮；
//    分支节点的出口按纵向位置算进重心和交叉，第 i 个出口连的节点自然排在第 i+1 个出口连的上面
// 3. 纵坐标：每个节点想对齐上游出口（汇合节点取几路上游的平均，单父单子的链拉直），或下游入口的平均；
//    同列按顺序不重叠（保序回归，间距 gap），上下来回几轮后最后一轮向上游对齐
// 4. 长边画出来是一条从起点直接到终点的线，不经过虚拟节点；所以纵坐标按「虚拟节点占位」和「不占位」各排一次，
//    按画出来的连线（出口到入口的直线）数交叉，取少的（一样多取占位的）
// 纯函数；横坐标由调用方按列算，这里只用列距和节点宽数交叉

export type LayoutNode = { key: string; rank: number; h: number }
/**
 * out / in：连线在上游节点、下游节点上的纵向位置（相对节点顶部），用来对齐；
 * port：排序时出口在上游节点上的相对位置（0 顶到 1 底），不给时按 out / 上游高度
 */
export type LayoutEdge = { from: string; to: string; out: number; in: number; port?: number }
/** 数交叉用的横向尺寸：列距（相邻两列左边缘的距离）和节点宽 */
export type LayoutGeom = { col: number; w: number }

const SWEEPS = 24
const ROUNDS = 4

type Seg = { u: string; v: string; port: number; out: number; in: number }

/** 各节点的纵坐标（节点顶部，最上面的为 0）；同列互不重叠 */
export function layeredY(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], gap = 28, geom: LayoutGeom = { col: 316, w: 232 }): Record<string, number> {
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const fwd = edges.filter((e) => {
    const a = byKey.get(e.from)
    const b = byKey.get(e.to)
    return !!a && !!b && b.rank > a.rank
  })
  const { layers, segs, h } = orderLayers(nodes, fwd, byKey)
  const lanes = assignY(layers, segs, h, gap)
  if (segs.length === fwd.length) return pick(nodes, lanes)
  const direct = assignY(layers.map((l) => l.filter((k) => byKey.has(k))), fwd.map((e) => ({ u: e.from, v: e.to, port: 0, out: e.out, in: e.in })), h, gap)
  const drawn = (ys: Record<string, number>) => crossings(fwd.map((e) => ({
    a: { x: byKey.get(e.from)!.rank * geom.col + geom.w, y: ys[e.from] + e.out },
    b: { x: byKey.get(e.to)!.rank * geom.col, y: ys[e.to] + e.in },
  })))
  return pick(nodes, drawn(direct) < drawn(lanes) ? direct : lanes)
}

/** 只留真节点，最上面的移到 0 */
function pick(nodes: readonly LayoutNode[], ys: Record<string, number>): Record<string, number> {
  const top = Math.min(...nodes.map((n) => ys[n.key]))
  return Object.fromEntries(nodes.map((n) => [n.key, Math.round(ys[n.key] - top)]))
}

/* ---------- 列内顺序 ---------- */

function orderLayers(nodes: readonly LayoutNode[], fwd: readonly LayoutEdge[], byKey: Map<string, LayoutNode>) {
  const maxRank = Math.max(0, ...nodes.map((n) => n.rank))
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => [])
  const rankOf = new Map<string, number>()
  const h = new Map<string, number>()
  for (const n of nodes) { layers[n.rank].push(n.key); rankOf.set(n.key, n.rank); h.set(n.key, n.h) }
  // 相邻两列之间的线段：长边拆成经过虚拟节点的几段，只有第一段带出口位置
  const segs: Seg[] = []
  fwd.forEach((e, i) => {
    const a = byKey.get(e.from)!
    const b = byKey.get(e.to)!
    const port = e.port ?? (a.h > 0 ? Math.min(1, Math.max(0, e.out / a.h)) : 0.5)
    let prev = e.from
    for (let r = a.rank + 1; r < b.rank; r += 1) {
      const id = `\u0000${i}:${r}`
      layers[r].push(id)
      rankOf.set(id, r)
      h.set(id, 0)
      segs.push({ u: prev, v: id, port: prev === e.from ? port : 0.5, out: prev === e.from ? e.out : 0, in: 0 })
      prev = id
    }
    segs.push({ u: prev, v: e.to, port: prev === e.from ? port : 0.5, out: prev === e.from ? e.out : 0, in: e.in })
  })
  const below: Seg[][] = layers.map(() => [])
  const into = new Map<string, Seg[]>()
  const outOf = new Map<string, Seg[]>()
  for (const s of segs) {
    below[rankOf.get(s.u)!].push(s)
    into.set(s.v, [...(into.get(s.v) ?? []), s])
    outOf.set(s.u, [...(outOf.get(s.u) ?? []), s])
  }

  const posOf = (ls: string[][]) => {
    const m = new Map<string, number>()
    ls.forEach((l) => l.forEach((k, i) => m.set(k, i)))
    return m
  }
  const crossBetween = (r: number, pos: Map<string, number>) => {
    const list = below[r].map((s) => [pos.get(s.u)! + s.port * 0.9, pos.get(s.v)!] as const)
    let n = 0
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if ((list[i][0] - list[j][0]) * (list[i][1] - list[j][1]) < 0) n += 1
      }
    }
    return n
  }
  const total = (ls: string[][]) => {
    const pos = posOf(ls)
    let n = 0
    for (let r = 0; r < ls.length - 1; r += 1) n += crossBetween(r, pos)
    return n
  }
  const sortLayer = (ls: string[][], r: number, down: boolean) => {
    const pos = posOf(ls)
    const key = new Map<string, number>()
    ls[r].forEach((k, i) => {
      const xs = down
        ? (into.get(k) ?? []).map((s) => pos.get(s.u)! + s.port - 0.5)
        : (outOf.get(k) ?? []).map((s) => pos.get(s.v)! - (s.port - 0.5))
      key.set(k, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : i)
    })
    ls[r] = ls[r].map((k, i) => ({ k, i })).sort((a, b) => key.get(a.k)! - key.get(b.k)! || a.i - b.i).map((x) => x.k)
  }
  // 相邻交换：换了能让这一列上下两侧的交叉变少就换，直到换不动
  const transpose = (ls: string[][]) => {
    for (let pass = 0; pass < 8; pass += 1) {
      let better = false
      for (let r = 0; r < ls.length; r += 1) {
        for (let i = 0; i + 1 < ls[r].length; i += 1) {
          const local = () => {
            const pos = posOf(ls)
            return (r > 0 ? crossBetween(r - 1, pos) : 0) + (r < ls.length - 1 ? crossBetween(r, pos) : 0)
          }
          const before = local()
          ;[ls[r][i], ls[r][i + 1]] = [ls[r][i + 1], ls[r][i]]
          if (local() < before) better = true
          else [ls[r][i], ls[r][i + 1]] = [ls[r][i + 1], ls[r][i]]
        }
      }
      if (!better) break
    }
  }

  let cur = layers.map((l) => [...l])
  // 先自上而下排一遍作为起点
  for (let r = 1; r < cur.length; r += 1) sortLayer(cur, r, true)
  let best = cur.map((l) => [...l])
  let bestN = total(best)
  for (let it = 0; it < SWEEPS && bestN > 0; it += 1) {
    const down = it % 2 === 0
    if (down) for (let r = 1; r < cur.length; r += 1) sortLayer(cur, r, true)
    else for (let r = cur.length - 2; r >= 0; r -= 1) sortLayer(cur, r, false)
    transpose(cur)
    const n = total(cur)
    if (n < bestN) { best = cur.map((l) => [...l]); bestN = n }
  }
  return { layers: best, segs, h }
}

/* ---------- 纵坐标 ---------- */

function assignY(order: string[][], segs: readonly Seg[], h: Map<string, number>, gap: number): Record<string, number> {
  const into = new Map<string, Seg[]>()
  const outOf = new Map<string, Seg[]>()
  for (const e of segs) {
    into.set(e.v, [...(into.get(e.v) ?? []), e])
    outOf.set(e.u, [...(outOf.get(e.u) ?? []), e])
  }
  const y = new Map<string, number>()
  for (const l of order) {
    let at = 0
    for (const k of l) { y.set(k, at); at += h.get(k)! + gap }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const wantUp = (k: string) => {
    const es = into.get(k) ?? []
    return es.length ? mean(es.map((e) => y.get(e.u)! + e.out - e.in)) : undefined
  }
  const wantDown = (k: string) => {
    const es = outOf.get(k) ?? []
    return es.length ? mean(es.map((e) => y.get(e.v)! + e.in - e.out)) : undefined
  }
  const place = (l: string[], want: (k: string) => number | undefined) => {
    const ys = settle(l.map((k) => want(k) ?? y.get(k)!), l.map((k) => h.get(k)! + gap))
    l.forEach((k, i) => y.set(k, ys[i]))
  }
  const down = () => { for (let r = 1; r < order.length; r += 1) place(order[r], wantUp) }
  const up = () => { for (let r = order.length - 2; r >= 0; r -= 1) place(order[r], wantDown) }
  down()
  for (let i = 0; i < ROUNDS; i += 1) { up(); down() }
  return Object.fromEntries(y)
}

/**
 * 保序不重叠：第 i 个想放在 want[i]，占 size[i]（高度加间距），顺序不变、互不重叠，总偏移平方和最小。
 * 减去前面累计的高度后变成单调回归，用相邻块合并（PAV）
 */
export function settle(want: readonly number[], size: readonly number[]): number[] {
  const off: number[] = []
  let acc = 0
  for (const s of size) { off.push(acc); acc += s }
  const blocks: { sum: number; n: number }[] = []
  want.forEach((w, i) => {
    blocks.push({ sum: w - off[i], n: 1 })
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!
      blocks[blocks.length - 1].sum += b.sum
      blocks[blocks.length - 1].n += b.n
    }
  })
  const out: number[] = []
  for (const b of blocks) for (let j = 0; j < b.n; j += 1) out.push(b.sum / b.n + off[out.length])
  return out
}

/* ---------- 交叉数（测试和比较用） ---------- */

export type Segment = { a: { x: number; y: number }; b: { x: number; y: number } }

/** 线段两两真相交的次数；共用端点的不算（同一出口连出、连进同一入口） */
export function crossings(segs: readonly Segment[]): number {
  const same = (p: Segment['a'], q: Segment['a']) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5
  const side = (p: Segment['a'], q: Segment['a'], r: Segment['a']) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  let n = 0
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i]
      const t = segs[j]
      if (same(s.a, t.a) || same(s.a, t.b) || same(s.b, t.a) || same(s.b, t.b)) continue
      const d1 = side(s.a, s.b, t.a)
      const d2 = side(s.a, s.b, t.b)
      const d3 = side(t.a, t.b, s.a)
      const d4 = side(t.a, t.b, s.b)
      if (d1 * d2 < 0 && d3 * d4 < 0) n += 1
    }
  }
  return n
}
