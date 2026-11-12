// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 纪要里的流程图 / 树形图：按 RecordingDiagrams JSON 自绘（SVG + CSS），不引 mermaid 依赖。
// 数据来自 AI，可能缺字段或类型不对：布局函数先清洗（model.ts 的 layoutFlow/treeRows），这里只负责画，
// 没有可用数据时给一句提示，不让整块纪要因为一张图坏掉而白屏。
import { useId } from 'react'
import type { RecordingDiagrams } from '../../core/data'
import { layoutFlow, treeRows } from './model'

/** 流程图：分层布局（列=层级，行=同层顺序），边用三次贝塞尔 + 箭头 */
function FlowDiagram({ diagrams }: { diagrams: RecordingDiagrams | null | undefined }) {
  const markerId = `rec-flow-arrow-${useId().replace(/[«»:]/g, '')}`
  const flow = layoutFlow(diagrams?.flow)
  if (!flow) return <p className="rec-diagram-empty">这次纪要没有生成流程图。</p>
  const title = diagrams?.flow?.title?.trim() || '讨论脉络'
  return (
    <figure className="rec-diagram">
      <figcaption className="rec-diagram-title">{title}</figcaption>
      <div className="rec-diagram-scroll">
        <svg className="rec-flow" width={flow.width} height={flow.height} viewBox={`0 0 ${flow.width} ${flow.height}`}
          role="img" aria-label={`流程图：${title}`}>
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path className="rec-flow-arrow" d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {flow.edges.map((e, i) => (
            <g key={`${e.from}-${e.to}-${i}`}>
              <path className="rec-flow-edge" d={e.path} markerEnd={`url(#${markerId})`} />
              {e.label ? <text className="rec-flow-edge-label" x={e.lx} y={e.ly} textAnchor="middle">{e.label}</text> : null}
            </g>
          ))}
          {flow.nodes.map((n) => (
            <g key={n.id} className={`rec-flow-node kind-${n.kind}`}>
              {n.kind === 'decision'
                ? <polygon className="rec-flow-shape" points={`${n.cx},${n.y} ${n.x + n.w},${n.cy} ${n.cx},${n.y + n.h} ${n.x},${n.cy}`} />
                : <rect className="rec-flow-shape" x={n.x} y={n.y} width={n.w} height={n.h} rx={n.kind === 'start' || n.kind === 'end' ? n.h / 2 : 10} />}
              <text className="rec-flow-label" x={n.cx} textAnchor="middle" dominantBaseline="middle">
                {n.lines.map((line, i) => (
                  <tspan key={i} x={n.cx} y={n.lines.length > 1 ? n.cy - 7 + i * 14 : n.cy}>{line}</tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </figure>
  )
}

/** 树形图：缩进的嵌套列表（深度最多 3 层、每层最多 8 个，由 treeRows 截断） */
function TreeDiagram({ diagrams }: { diagrams: RecordingDiagrams | null | undefined }) {
  const rows = treeRows(diagrams?.tree)
  if (!rows.length) return <p className="rec-diagram-empty">这次纪要没有生成树形图。</p>
  const title = diagrams?.tree?.title?.trim() || '项目/任务树'
  return (
    <figure className="rec-diagram">
      <figcaption className="rec-diagram-title">{title}</figcaption>
      <ul className="rec-tree" role="tree" aria-label={`树形图：${title}`}>
        {rows.map((row) => (
          <li key={row.id} className={`rec-tree-row depth-${row.depth}`} role="treeitem" aria-level={row.depth + 1}
            style={{ paddingLeft: 8 + row.depth * 20 }}>
            <span className="rec-tree-dot" aria-hidden="true" />
            <span className="rec-tree-label">{row.label}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

/** 纪要里的两张图；数据空/坏时各自显示提示 */
export function Diagrams({ diagrams }: { diagrams: RecordingDiagrams | null | undefined }) {
  return (
    <div className="rec-diagrams">
      <FlowDiagram diagrams={diagrams} />
      <TreeDiagram diagrams={diagrams} />
    </div>
  )
}
