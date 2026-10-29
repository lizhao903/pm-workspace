// SOP 插件的小部件：节点类型标签、执行表格的行、进度条。照原型 sop.tsx 的 RunRow、Progress 和 nodetypes.tsx 的 KindTag
import type { CSSProperties } from 'react'
import type { SopRunBrief } from '../../core/data'
import { sopNodeView } from '../../core/plugin'
import { Pill } from '../../core/ui'
import { KIND_LABEL, kindLabel, progressText, runDur, runLook, timeAgo } from './model'
import { nodeInfo } from './nodes'

/** 内置节点的颜色在 sop.css 的 .sop-kt-<kind>，插件节点用它登记的颜色 */
export function KindTag({ kind }: { kind: string }) {
  const c = KIND_LABEL[kind] ? undefined : sopNodeView(kind)?.color
  return <span className={`sop-kind sop-kt-${kind}`} style={c ? ({ '--c': c } as CSSProperties) : undefined}>{kindLabel(kind)}</span>
}

export function IconPlus() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}
export function IconPlay() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 3v10l8-5Z" fill="currentColor" /></svg>
}
export function IconBack() {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export function RunPill({ status }: { status: string }) {
  const l = runLook(status)
  return <Pill label={l.label} color={l.color} />
}

function Progress({ run }: { run: SopRunBrief }) {
  return (
    <div className="sop-run-progress">
      <div className="sop-steps-bar" aria-hidden="true">
        {run.steps.map((x) => <span key={x.key} className={`seg-${x.status}`} />)}
      </div>
      <span className="sop-run-progress-text ellipsis">{progressText(run)}</span>
    </div>
  )
}

export function RunHead() {
  return (
    <div className="sop-run-row sop-run-th" aria-hidden="true">
      <span>执行</span><span>状态</span><span>进度</span><span>开始</span><span>耗时</span>
    </div>
  )
}

export function RunRow({ r, onOpen, showFlow = true, now }: { r: SopRunBrief; onOpen: (id: string) => void; showFlow?: boolean; now: number }) {
  return (
    <button type="button" className="sop-run-row" onClick={() => onOpen(r.id)}>
      <span className="sop-run-name">
        <span className="ellipsis" title={r.title}>{r.title}</span>
        {showFlow
          ? <span className="sop-run-sub ellipsis">{r.flow_name}{r.step_through ? ' · 逐步确认' : ''}</span>
          : r.step_through && <span className="sop-run-sub ellipsis">逐步确认</span>}
      </span>
      <span><RunPill status={r.status} /></span>
      <Progress run={r} />
      <span className="sop-run-muted">{timeAgo(r.started_at, now)}</span>
      <span className="sop-run-muted">{runDur(r, now)}</span>
    </button>
  )
}

const START_ICON = <path d="M5.5 4v8l6.5-4Z" fill="currentColor" />
const MANUAL_COLOR = '#b0570b'

/** 节点图标：kind 为 start 是开始节点，manual 是节点选择器里的「人工判断」 */
export function KindIcon({ kind, size = 22, manual }: { kind: string; size?: number; manual?: boolean }) {
  const t = kind === 'start' ? null : nodeInfo(kind)
  const bg = kind === 'start' ? '#2f7d43' : manual ? MANUAL_COLOR : t!.color
  return (
    <span className="sop-kind-icon" style={{ width: size, height: size, background: bg }} aria-hidden="true">
      <svg viewBox="0 0 16 16" width={size * 0.62} height={size * 0.62}>{t?.icon ?? START_ICON}</svg>
    </span>
  )
}
