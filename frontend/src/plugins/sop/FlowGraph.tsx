// 流程图（SPEC-sop-5.9、7.7）：按依赖分列，同一列的步骤互不依赖；判断后的分支也落在同一列，连线上写分支名。
// 给了 run 就按步骤状态着色、标「人」、高亮走过的连线；给了 onSelect 节点可点。照原型 sop.tsx FlowGraph
import { useEffect, useRef } from 'react'
import { isSopProviderWait, type SopFlow, type SopRun, type SopStepDef } from '../../core/data'
import { cls } from '../../core/ui'
import { EDITED_LABEL, depsOf, isFinished, isManualDecide, isQueued, ranks, runStepLook } from './model'
import { KindTag } from './parts'

const W = 184
const H = 74
const COL_GAP = 64
const ROW_GAP = 14
const PAD = 12
const TOP = 22

export function FlowGraph({ flow, run, selected, onSelect, branching }: {
  flow: SopFlow
  run?: SopRun
  selected?: number
  onSelect?: (i: number) => void
  branching: (d: SopStepDef) => boolean
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // 图比视口宽时，选中的步骤可能在右边看不见，切过去时滚到它
  useEffect(() => {
    if (selected === undefined) return
    const el = boxRef.current?.querySelector('.sop-fnode.sel')
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selected])

  if (!flow.steps.length) return null
  const rk = ranks(flow)
  const cols: number[][] = []
  rk.forEach((r, i) => { (cols[r] ??= []).push(i) })
  const filled = cols.filter(Boolean)
  const maxRows = Math.max(...filled.map((c) => c.length))
  const pos = flow.steps.map((_, i) => {
    const col = cols[rk[i]]
    const off = ((maxRows - col.length) * (H + ROW_GAP)) / 2
    return { x: PAD + rk[i] * (W + COL_GAP), y: TOP + PAD + off + col.indexOf(i) * (H + ROW_GAP) }
  })
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * COL_GAP
  const height = TOP + PAD * 2 + maxRows * H + (maxRows - 1) * ROW_GAP
  const idx = new Map(flow.steps.map((x, i) => [x.key, i]))
  const st = (i: number) => run?.steps[i]?.status

  const edges = flow.steps.flatMap((def, i) => depsOf(flow, i).flatMap((k) => {
    const j = idx.get(k)
    if (j === undefined) return []
    const from = { x: pos[j].x + W, y: pos[j].y + H / 2 }
    const to = { x: pos[i].x, y: pos[i].y + H / 2 }
    const mid = (from.x + to.x) / 2
    const label = def.branch?.of === k ? flow.steps[j].cases?.find((c) => c.key === def.branch!.case)?.label : undefined
    const off = st(i) === 'bypassed' || st(j) === 'bypassed'
    const sj = st(j)
    const on = !off && !!run && !!sj && isFinished(sj) && st(i) !== 'pending'
    return [{ id: `${k}-${def.key}`, d: `M${from.x},${from.y} C${mid},${from.y} ${mid},${to.y} ${to.x - 2},${to.y}`, label, lx: mid, ly: (from.y + to.y) / 2, off, on }]
  }))

  return (
    <div className="sop-flow-scroll">
      <div className="sop-flow" ref={boxRef} style={{ width, height }}>
        <svg className="sop-flow-edges" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="sop-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 8,4 0,8Z" className="sop-arr" /></marker>
            <marker id="sop-arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 8,4 0,8Z" className="sop-arr sop-arr-on" /></marker>
          </defs>
          {edges.map((e) => <path key={e.id} d={e.d} className={cls('sop-edge', e.on && 'sop-edge-on', e.off && 'sop-edge-off')} markerEnd={`url(#${e.on ? 'sop-arr-on' : 'sop-arr'})`} />)}
        </svg>
        {edges.filter((e) => e.label).map((e) => (
          <span key={`l-${e.id}`} className={cls('sop-edge-label', e.off && 'off')} style={{ left: e.lx, top: e.ly }}>{e.label}</span>
        ))}
        {cols.map((col, c) => col && col.length > 1 && col.some((i) => !flow.steps[i].branch) && (
          <span key={`p${c}`} className="sop-flow-par" style={{ left: pos[col[0]].x, top: pos[col[0]].y - 20 }}>并行 {col.length} 路</span>
        ))}
        {flow.steps.map((def, i) => {
          const rs = run?.steps[i]
          const deps = depsOf(flow, i).length
          const route = rs?.route && def.cases?.find((c) => c.key === rs.route)?.label
          const idle = branching(def)
            ? (def.kind === 'classifier' ? 'AI 分类' : isManualDecide(def) ? '人工判断' : def.kind === 'loopback' ? '不满足就退回' : '按规则判断')
            : typeof def.ms === 'number' ? `约 ${Math.max(1, Math.round(def.ms / 1000))} 秒` : ''
          const body = (
            <>
              <span className="sop-fnode-top">
                <KindTag kind={def.kind} />
                {deps > 1 && <span className="sop-fnode-join">汇合 {deps} 路</span>}
                {!!rs?.round && <span className="sop-fnode-join">第 {rs.round} 轮</span>}
                {rs?.edited && <span className="sop-edited-dot" title={EDITED_LABEL[rs.edited]}>人</span>}
              </span>
              <span className="sop-fnode-name ellipsis" title={def.name}>{def.name}</span>
              {rs ? (
                <span className={cls('sop-fnode-st', `fst-${rs.status}`, isQueued(rs) && 'fst-queued')}>
                  {rs.status === 'running' && !isQueued(rs) && !isSopProviderWait(rs) && <span className="spinner sop-spinner-xs" aria-hidden="true" />}
                  {route ? `走「${route}」` : runStepLook(rs).label}
                </span>
              ) : <span className="sop-fnode-st">{idle}</span>}
            </>
          )
          const className = cls('sop-fnode', `fn-${rs?.status ?? 'idle'}`, `fk-${def.kind}`, selected === i && 'sel', !onSelect && 'static')
          const style = { left: pos[i].x, top: pos[i].y, width: W, height: H }
          return onSelect ? (
            <button key={def.key} type="button" className={className} style={style} onClick={() => onSelect(i)}
              aria-pressed={selected === i} aria-label={`步骤 ${i + 1} ${def.name}${rs ? `，${runStepLook(rs).label}` : ''}`}>
              {body}
            </button>
          ) : <div key={def.key} className={className} style={style}>{body}</div>
        })}
      </div>
    </div>
  )
}

export function FlowLegend() {
  return (
    <div className="sop-flow-legend">
      <span>同一列的步骤并行执行</span>
      <span>汇合：等前面几路都完成才开始</span>
      <span>判断：只走选中的分支，另一支标为「未走此分支」</span>
    </div>
  )
}
