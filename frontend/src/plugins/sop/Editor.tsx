// 编排页（SPEC-sop-8）：左边 AI 协助，中间画布（拖动节点、从节点右侧的 + 连线或加下一个节点、分支出口），选中节点时右边是属性面板。
// 编排页改的是草稿，保存时整体提交，位置一起存进 layout；有错误级问题不保存，后端 400 时把问题逐条标到节点上（SPEC-sop-8.30、8.35）。
// 撤销历史最多 50 步；流程名连续输入算一步。照原型 web-next/src/sopedit.tsx 的 SopEditor
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { errorText, isApiError, sopIssuesOf, useConversations, useSaveSopFlow, type SopDraft, type SopFlow, type SopRunBrief, type SopScheduleOff, type SopStepDef } from '../../core/data'
import { Button, ConfirmDialog, IconButton, PageTitle, cls, describeScheduleRule } from '../../core/ui'
import { AiPanel } from './AiPanel'
import {
  COL_GAP, NW, START, caseY, checkDraft, childrenOf, connect, explicit, fitView, isBranching, layoutOf, makeStep, mergeIssues,
  paletteItems, removeEdge as dropEdge, removeStep, sameDraft, serverIssuesOf, topo, type Catalog, type Draft, type Issue, type PaletteItem,
  type Pos, type ServerIssue,
} from './edit'
import { isManualDecide } from './model'
import { NodePanel, type TriggerOption } from './NodePanel'
import { nodeInfo, type FieldCtx } from './nodes'
import { Palette } from './Palette'
import { SCHEDULE } from './schedule'
import { IM, filterText } from './imtrigger'
import { IconBack, IconPlay, KindIcon } from './parts'

const HISTORY = 50
const TOAST_MS = 2400

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'node'; key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; before: Draft }
  | { kind: 'link'; from: string; caseKey?: string; sx: number; sy: number; at: Pos }

type PaletteAt = { at: Pos; from: string; caseKey?: string }

export function Editor({ initial, flowId, version, hasSchedule = false, catalog, ctx, triggers, runs, onCancel, onSaved }: {
  initial: Draft
  /** 编辑已有流程时有；新建没有 */
  flowId?: string
  version?: number
  /** 这个流程现在有随它管理的定时任务（TSK-0463）：改成别的触发方式保存前先确认停用还是删掉 */
  hasSchedule?: boolean
  catalog: Catalog
  ctx: FieldCtx
  triggers: TriggerOption[]
  runs: readonly SopRunBrief[]
  onCancel: () => void
  onSaved: (f: SopFlow, thenRun: boolean) => void
}) {
  const creating = !flowId
  const [draft, setDraft] = useState<Draft>(() => explicit(initial))
  const [base, setBase] = useState(() => JSON.stringify(explicit(initial)))
  const [past, setPast] = useState<Draft[]>([])
  const [future, setFuture] = useState<Draft[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [selEdge, setSelEdge] = useState<{ from: string; to: string } | null>(null)
  const [aiOpen, setAiOpen] = useState(() => window.matchMedia('(min-width: 1101px)').matches)
  const [palette, setPalette] = useState<PaletteAt | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 })
  const [link, setLink] = useState<{ at: Pos; from: string; caseKey?: string } | null>(null)
  const [panning, setPanning] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [tried, setTried] = useState(false)
  const [toast, setToast] = useState('')
  const [server, setServer] = useState<ServerIssue[]>([])
  const [saveError, setSaveError] = useState('')
  const [gone, setGone] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // 从定时改成别的触发方式时，保存前问那条定时任务停用还是删掉（TSK-0463）
  const [offAsk, setOffAsk] = useState<{ thenRun: boolean } | null>(null)
  const [offChoice, setOffChoice] = useState<SopScheduleOff>('disable')
  const [schedSaved, setSchedSaved] = useState(hasSchedule)
  // AI 提案的撤销只撤这次提案：记下应用后的草稿，之后有别的改动就不再给「撤销」
  const [aiMark, setAiMark] = useState<Draft | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const nameEdit = useRef<Draft | null>(null)
  const fitted = useRef(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const saveM = useSaveSopFlow()
  const convs = useConversations({ enabled: draft.trigger === IM }).data ?? []

  const lay = useMemo(() => layoutOf(draft, catalog), [draft, catalog])
  const local = useMemo(() => checkDraft(draft, catalog), [draft, catalog])
  const issues = useMemo(() => mergeIssues(local, server, draft), [local, server, draft])
  const errors = local.filter((x) => x.level === 'error')
  const dirty = !sameDraft(draft, JSON.parse(base) as Draft)
  const items = useMemo(() => paletteItems(catalog), [catalog])
  const triggerLabel = triggers.find((t) => t.value === draft.trigger)?.label ?? draft.trigger
  // 画布开始节点上定时的写出规则（TSK-0463）
  // IM 触发写出过滤条件（TSK-0481）
  const startLabel = draft.trigger === SCHEDULE ? (draft.sched ? `${triggerLabel} · ${describeScheduleRule(draft.sched.rule)}` : `${triggerLabel}，未配置`)
    : draft.trigger === IM && draft.im ? `${triggerLabel} · ${filterText(draft.im, convs)}${draft.im.stop ? ' · 拦截后续' : ''}` : triggerLabel

  const commit = (next: Draft) => {
    setPast((p) => [...p.slice(-(HISTORY - 1)), draft])
    setFuture([])
    setDraft(next)
  }
  const undo = () => {
    const prev = past[past.length - 1]
    if (!prev) return
    setFuture((f) => [draft, ...f])
    setPast((p) => p.slice(0, -1))
    setDraft(prev)
  }
  const redo = () => {
    const nx = future[0]
    if (!nx) return
    setPast((p) => [...p, draft])
    setFuture((f) => f.slice(1))
    setDraft(nx)
  }
  // 流程名连续输入只记一步撤销
  const rename = (name: string) => {
    const next = { ...draft, name }
    if (nameEdit.current === draft) setDraft(next)
    else commit(next)
    nameEdit.current = next
  }
  const say = (t: string) => {
    window.clearTimeout(toastTimer.current)
    setToast(t)
    toastTimer.current = window.setTimeout(() => setToast(''), TOAST_MS)
  }
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // 屏幕不够宽时，选中节点打开属性面板就先收起 AI 面板，给画布留地方
  const select = (key: string | null) => {
    setSel(key)
    setSelEdge(null)
    if (key && window.innerWidth < 1600) setAiOpen(false)
  }

  const changeStep = (key: string, p: Partial<SopStepDef>) => commit({ ...draft, steps: draft.steps.map((s) => (s.key === key ? { ...s, ...p } : s)) })
  const toWorld = (cx: number, cy: number): Pos => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: (cx - r.left - pan.x) / zoom, y: (cy - r.top - pan.y) / zoom }
  }

  const addNode = (item: PaletteItem, from: string, caseKey?: string) => {
    const name = item.manual ? '人工判断' : item.label
    const step = makeStep(draft, catalog, item.kind, name, from === START ? [] : [from], {
      ...(caseKey ? { branch: { of: from, case: caseKey } } : {}),
      ...(item.kind === 'decide' ? { rule: item.manual ? '' : '填写判断条件' } : {}),
    })
    // 同一个节点后面已经有几个子节点就往下错开几格，免得叠在一起
    const siblings = childrenOf(draft, from).length
    const at = lay[from] ?? { x: 60, y: 80 }
    const layout = { ...lay, [step.key]: { x: at.x + NW + COL_GAP, y: at.y + siblings * 108 } }
    commit(topo({ ...draft, steps: [...draft.steps, step], layout }))
    select(step.key)
    setPalette(null)
    // 新节点落在视口外（多半在右边，被属性面板挡住）时把画布挪过去
    const el = canvasRef.current
    if (el && el.clientWidth) {
      const p = layout[step.key]
      const sx = pan.x + p.x * zoom
      const sy = pan.y + p.y * zoom
      const w = el.clientWidth - (sel ? 0 : 380)
      const dx = sx + NW * zoom > w - 40 ? w - 40 - (sx + NW * zoom) : 0
      const dy = sy + 120 * zoom > el.clientHeight - 60 ? el.clientHeight - 60 - (sy + 120 * zoom) : sy < 70 ? 70 - sy : 0
      if (dx || dy) setPan({ x: pan.x + dx, y: pan.y + dy })
    }
  }

  const link2 = (from: string, to: string, caseKey?: string) => {
    const r = connect(draft, from, to, caseKey)
    if (r.ok) commit(r.draft)
    else if (r.toast) say(r.toast)
  }
  const removeEdge = (from: string, to: string) => {
    if (from === START) return
    commit(dropEdge(draft, from, to))
    setSelEdge(null)
  }
  const removeNode = (key: string) => {
    if (key === START) return
    commit(removeStep(draft, key))
    setSel(null)
  }

  // 键盘：删除选中的节点或连线，撤销 / 重做；在输入框里不生效
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selEdge || (sel && sel !== START))) {
        e.preventDefault()
        if (selEdge) removeEdge(selEdge.from, selEdge.to)
        else if (sel) removeNode(sel)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const fit = () => {
    const el = canvasRef.current
    if (!el) return
    const v = fitView(draft, catalog, lay, el.clientWidth, el.clientHeight)
    setZoom(v.zoom)
    setPan(v.pan)
  }
  // 打开时适配一次；AI 整体替换、自动整理后再适配一次
  useEffect(() => {
    if (fitted.current) return
    fitted.current = true
    fit()
  })

  const zoomAt = (z: number, cx?: number, cy?: number) => {
    const el = canvasRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const px = cx ?? r.left + r.width / 2
    const py = cy ?? r.top + r.height / 2
    const nz = Math.max(0.4, Math.min(1.8, z))
    const w = toWorld(px, py)
    setZoom(nz)
    setPan({ x: px - r.left - w.x * nz, y: py - r.top - w.y * nz })
  }
  // 滚轮：平移；按住 ⌘ 或 Ctrl 以光标为中心缩放。要拦住浏览器自己的缩放，挂非 passive 的原生监听
  const wheel = useRef<(e: WheelEvent) => void>(() => {})
  useEffect(() => {
    wheel.current = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(zoom * (e.deltaY > 0 ? 0.92 : 1.08), e.clientX, e.clientY)
      else setPan({ x: pan.x - e.deltaX, y: pan.y - e.deltaY })
    }
  })
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const h = (e: WheelEvent) => wheel.current(e)
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  const onPointerDown = (e: RPointerEvent) => {
    const t = e.target as HTMLElement
    if (e.button > 0) return
    const handle = t.closest<HTMLElement>('[data-out]')
    const node = t.closest<HTMLElement>('[data-node]')
    if (handle) {
      const r = handle.getBoundingClientRect()
      drag.current = { kind: 'link', from: handle.dataset.out!, caseKey: handle.dataset.case || undefined, sx: e.clientX, sy: e.clientY, at: { x: r.right + 8, y: r.top - 10 } }
      setLink({ at: toWorld(e.clientX, e.clientY), from: handle.dataset.out!, caseKey: handle.dataset.case || undefined })
    } else if (node && !t.closest('button, input')) {
      const key = node.dataset.node!
      drag.current = { kind: 'node', key, sx: e.clientX, sy: e.clientY, ox: lay[key].x, oy: lay[key].y, moved: false, before: draft }
    } else if (!node && !t.closest('.sop-cv-ui, .sop-edge-hit, .sop-edge-del')) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
      setPanning(true)
      setSel(null)
      setSelEdge(null)
    } else return
    canvasRef.current?.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') setPan({ x: d.px + e.clientX - d.sx, y: d.py + e.clientY - d.sy })
    else if (d.kind === 'node') {
      const dx = (e.clientX - d.sx) / zoom
      const dy = (e.clientY - d.sy) / zoom
      // 移动超过 3 像素才算拖
      if (!d.moved && !(Math.hypot(dx, dy) >= 3)) return
      d.moved = true
      setDraft({ ...draft, layout: { ...lay, [d.key]: { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) } } })
    } else setLink({ at: toWorld(e.clientX, e.clientY), from: d.from, caseKey: d.caseKey })
  }
  const onPointerUp = (e: RPointerEvent) => {
    const d = drag.current
    drag.current = null
    setPanning(false)
    if (!d) return
    if (d.kind === 'node') {
      if (d.moved) {
        setPast((p) => [...p.slice(-(HISTORY - 1)), d.before])
        setFuture([])
      } else select(d.key)
    } else if (d.kind === 'link') {
      setLink(null)
      // 几乎没动就是点了 +：打开节点选择器；拖出去了才算连线
      if (!(Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 4)) {
        setPalette({ at: d.at, from: d.from, caseKey: d.caseKey })
        return
      }
      const target = document.elementFromPoint?.(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node]')
      if (target) link2(d.from, target.dataset.node!, d.caseKey)
      else setPalette({ at: { x: e.clientX + 8, y: e.clientY - 20 }, from: d.from, caseKey: d.caseKey })
    }
  }

  // 连线：开始节点连到所有没有上游的节点；判断节点从分支对应的出口连出
  const edges = [
    ...draft.steps.filter((s) => !(s.after ?? []).length).map((s) => ({ from: START, to: s.key, caseKey: undefined as string | undefined })),
    ...draft.steps.flatMap((s) => (s.after ?? []).filter((k) => lay[k]).map((k) => ({ from: k, to: s.key, caseKey: s.branch?.of === k ? s.branch.case : undefined }))),
  ]
  const outPt = (key: string, caseKey?: string): Pos => {
    const p = lay[key]
    const st = draft.steps.find((x) => x.key === key)
    const ci = caseKey && st?.cases ? st.cases.findIndex((c) => c.key === caseKey) : -1
    return { x: p.x + NW, y: p.y + (ci >= 0 ? caseY(ci) : 30) }
  }
  const curve = (a: Pos, b: Pos) => {
    const m = Math.max(40, Math.abs(b.x - a.x) / 2)
    return `M${a.x},${a.y} C${a.x + m},${a.y} ${b.x - m},${b.y} ${b.x},${b.y}`
  }

  const applyAi = (p: SopDraft) => {
    const next = explicit({ ...draft, ...p, id: draft.id, name: draft.name.trim() ? draft.name : p.name, layout: undefined })
    commit(next)
    setAiMark(next)
    setSel(null)
    setSelEdge(null)
    // AI 整体替换后位置都变了，重新适配一次视口
    fitted.current = false
  }

  const save = (thenRun: boolean, scheduleOff?: SopScheduleOff) => {
    setTried(true)
    if (errors.length) { setShowIssues(true); return }
    if (saveM.isPending) return
    const asNew = creating || gone
    if (!asNew && schedSaved && draft.trigger !== SCHEDULE && !scheduleOff) { setOffAsk({ thenRun }); return }
    const out: Draft = { ...draft, layout: lay }
    setServer([])
    setSaveError('')
    saveM.mutate({ id: asNew ? undefined : flowId, draft: out, version: asNew ? undefined : version, scheduleOff }, {
      onSuccess: (f) => {
        setBase(JSON.stringify(draft))
        setSchedSaved(!!f.schedule)
        onSaved(f, thenRun)
      },
      onError: (e) => {
        const list = sopIssuesOf(e)
        if (list.length) {
          setServer(serverIssuesOf(list, out))
          setShowIssues(true)
        } else if (!asNew && isApiError(e, 'not_found')) setGone(true)
        else setSaveError(`保存失败：${errorText(e)}`)
      },
    })
  }

  const back = () => {
    if (dirty) setLeaving(true)
    else onCancel()
  }

  const selStep = sel && sel !== START ? draft.steps.find((s) => s.key === sel) ?? null : null
  const stepIssues = (key: string) => issues.filter((x) => x.step !== undefined && draft.steps[x.step]?.key === key)
  const hasError = issues.some((x) => x.level === 'error')
  const saveLabel = gone ? '另存为新流程' : creating && !saveM.isSuccess ? '发布' : '保存'
  const status = creating && !saveM.isSuccess ? '未保存' : dirty ? '有未保存的修改' : '已保存'
  const openIssue = (x: Issue) => {
    if (x.step !== undefined && draft.steps[x.step]) select(draft.steps[x.step].key)
    setShowIssues(false)
  }

  return (
    <div className={cls('sop-editor', aiOpen && 'with-ai', sel && 'with-panel')}>
      <PageTitle parent="SOP">{creating ? '新建 SOP' : `编排 · ${draft.name || '未命名'}`}</PageTitle>
      {/* 收起只是藏起来，对话和没决定的提案在本次编排页里留着 */}
      <AiPanel hidden={!aiOpen} draft={draft} selected={selStep ? draft.steps.indexOf(selStep) : null} onApply={applyAi}
        onUndo={() => { undo(); setAiMark(null) }} canUndo={aiMark !== null && aiMark === draft && past.length > 0} onClose={() => setAiOpen(false)} />
      <div ref={canvasRef} className={cls('sop-canvas', panning && 'panning')} data-testid="sop-canvas"
        style={{ backgroundSize: `${20 * zoom}px ${20 * zoom}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <div className="sop-cv-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="sop-cv-edges" aria-hidden="true">
            {edges.map((ed) => {
              const d = curve(outPt(ed.from, ed.caseKey), { x: lay[ed.to].x, y: lay[ed.to].y + 30 })
              const on = selEdge?.from === ed.from && selEdge.to === ed.to
              return (
                <g key={`${ed.from}-${ed.to}`}>
                  <path d={d} className={cls('sop-cv-edge', on && 'on', ed.caseKey && 'branch')} />
                  {ed.from !== START && (
                    <path d={d} className="sop-edge-hit" data-edge={`${ed.from}>${ed.to}`}
                      onPointerDown={(e) => { e.stopPropagation(); setSelEdge({ from: ed.from, to: ed.to }); setSel(null) }} />
                  )}
                </g>
              )
            })}
            {link && lay[link.from] && <path d={curve(outPt(link.from, link.caseKey), link.at)} className="sop-cv-edge on dashed" />}
          </svg>
          {selEdge && lay[selEdge.from] && lay[selEdge.to] && (() => {
            const to = draft.steps.find((s) => s.key === selEdge.to)
            const a = outPt(selEdge.from, to?.branch?.of === selEdge.from ? to.branch.case : undefined)
            const b = { x: lay[selEdge.to].x, y: lay[selEdge.to].y + 30 }
            return (
              <button type="button" className="sop-edge-del" style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}
                onClick={() => removeEdge(selEdge.from, selEdge.to)} title="删除连线 (Delete)">断开</button>
            )
          })()}

          {/* 开始节点 */}
          <div className={cls('sop-cv-node', sel === START && 'sel')} data-node={START} style={{ left: lay[START].x, top: lay[START].y, width: NW }}
            role="button" tabIndex={0} aria-label="开始节点" onKeyDown={(e) => { if (e.key === 'Enter') select(START) }}>
            <div className="sop-cv-node-head"><KindIcon kind="start" /><span className="sop-cv-node-name">开始</span><span className="sop-cv-node-kind" title={startLabel}>{startLabel}</span></div>
            <div className="sop-cv-fields">
              {draft.fields.map((f) => (
                <span key={f.key} className="sop-cv-field"><span className="mono">{'{x}'}</span>{f.label || '未命名字段'}{f.required && <em>*</em>}</span>
              ))}
            </div>
            <span className="sop-cv-handle" data-out={START} role="button" aria-label="开始之后加节点" title="拖动连线，或点击添加下一个节点">+</span>
          </div>

          {draft.steps.map((s) => (
            <StepNode key={s.key} s={s} pos={lay[s.key]} catalog={catalog} ctx={ctx} sel={sel === s.key} bad={stepIssues(s.key)} onSelect={() => select(s.key)} />
          ))}
        </div>

        {/* 画布上的浮层 */}
        <div className="sop-cv-ui sop-cv-top-left">
          <IconButton label={creating ? '取消' : '返回'} onClick={back}><IconBack /></IconButton>
          <input className={cls('sop-cv-title', tried && !draft.name.trim() && 'bad')} value={draft.name} placeholder="SOP 名称" aria-label="SOP 名称"
            onChange={(e) => rename(e.target.value)} />
          <span className="sop-cv-status">{status}</span>
        </div>
        <div className="sop-cv-ui sop-cv-top-right">
          {!aiOpen && <Button variant="outline" className="sop-ai-open" onClick={() => setAiOpen(true)}><span className="sop-ai-mark sop-ai-mark-sm" aria-hidden="true">AI</span>AI 协助</Button>}
          <div className="sop-menu-wrap">
            <Button variant="outline" className={cls(hasError && 'sop-btn-danger', !hasError && issues.length > 0 && 'sop-btn-warn')}
              aria-expanded={showIssues} onClick={() => setShowIssues(!showIssues)}>
              {issues.length ? `检查 ${issues.length}` : '检查通过'}
            </Button>
            {showIssues && (
              <div className="menu sop-cv-issues" role="list" aria-label="检查结果">
                {issues.length ? issues.map((x, n) => (
                  <button key={n} type="button" role="listitem" className={cls('menu-item sop-cv-issue', `issue-${x.level}`)} onClick={() => openIssue(x)}>
                    <span className={`sop-issue-dot dot-${x.level}`} aria-label={x.level === 'error' ? '必须改' : '建议'} />{x.text}
                  </button>
                )) : <div className="sop-io-empty">没发现问题</div>}
              </div>
            )}
          </div>
          <Button variant="outline" disabled={saveM.isPending} onClick={() => save(true)}><IconPlay />测试运行</Button>
          <Button variant="primary" disabled={saveM.isPending} onClick={() => save(false)}>{saveLabel}</Button>
        </div>
        {(saveError || gone) && (
          <div className="sop-cv-ui sop-cv-error" role="alert">
            {gone ? '这个 SOP 已经在别处删除，点「另存为新流程」把现在的编排存成一条新流程' : saveError}
          </div>
        )}
        <div className="sop-cv-ui sop-cv-tools">
          <IconButton label="添加节点" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setPalette({ at: { x: r.right + 8, y: r.top }, from: sel ?? (draft.steps.length ? draft.steps[draft.steps.length - 1].key : START) })
          }}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </IconButton>
          <IconButton label="自动整理" onClick={() => { commit({ ...draft, layout: undefined }); fitted.current = false }}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2" y="2.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="10" y="2.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="10" y="9.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M6 4.5h4M8 4.5v7h2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          </IconButton>
          <IconButton label="适配视口" onClick={fit}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
        </div>
        <div className="sop-cv-ui sop-cv-bottom-left">
          <IconButton label="撤销" title="撤销 (⌘Z)" disabled={!past.length} onClick={undo}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3 2.5 5.5 5 8M2.5 5.5h7a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
          <IconButton label="重做" title="重做 (⇧⌘Z)" disabled={!future.length} onClick={redo}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M11 3l2.5 2.5L11 8M13.5 5.5h-7a3.5 3.5 0 0 0 0 7H10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
          <span className="sop-cv-hint">拖空白处平移，⌘ + 滚轮缩放，Delete 删除选中的节点或连线</span>
        </div>
        <div className="sop-cv-ui sop-cv-bottom-right">
          <IconButton label="缩小" onClick={() => zoomAt(zoom / 1.15)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 7h4M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </IconButton>
          <button type="button" className="sop-cv-zoom" onClick={() => zoomAt(1)} title="恢复 100%">{Math.round(zoom * 100)}%</button>
          <IconButton label="放大" onClick={() => zoomAt(zoom * 1.15)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 7h4M7 5v4M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </IconButton>
        </div>
        {!draft.steps.length && (
          <div className="sop-cv-ui sop-cv-empty">
            <div className="empty-title">从开始节点右边的 + 加第一个节点</div>
            <div className="sop-muted">或者在左边用一段话告诉 AI 这个流程怎么走</div>
            {!aiOpen && <Button variant="primary" onClick={() => setAiOpen(true)}>让 AI 帮我建</Button>}
          </div>
        )}
        {toast && <div className="sop-cv-ui sop-cv-toast" role="status">{toast}</div>}
      </div>

      {sel && (
        <NodePanel draft={draft} nodeKey={sel} catalog={catalog} ctx={{ ...ctx, flows: ctx.flows.filter((f) => f.id !== flowId) }} tried={tried}
          triggers={triggers} flowId={flowId} runs={runs}
          onChange={(p) => changeStep(sel, p)} onPatchDraft={(p) => commit({ ...draft, ...p })}
          onRemove={() => removeNode(sel)} onRemoveEdge={removeEdge} onSelect={select}
          onAddNext={(at, from, caseKey) => setPalette({ at, from, caseKey })} onClose={() => setSel(null)} />
      )}
      {palette && <Palette at={palette.at} items={items} onClose={() => setPalette(null)} onPick={(p) => addNode(p, palette.from, palette.caseKey)} />}
      <ConfirmDialog open={!!offAsk} title="不再定时执行？" confirmLabel="保存" onCancel={() => setOffAsk(null)}
        onConfirm={() => { const t = offAsk!.thenRun; setOffAsk(null); save(t, offChoice) }}>
        <div className="sop-off-ask">
          <span>触发方式改成「{triggerLabel}」后，随这个流程的定时任务怎么处理：</span>
          <label><input type="radio" name="sop-sched-off" checked={offChoice === 'disable'} onChange={() => setOffChoice('disable')} />
            <span><b>停用</b>　规则留着，以后改回定时时恢复</span></label>
          <label><input type="radio" name="sop-sched-off" checked={offChoice === 'delete'} onChange={() => setOffChoice('delete')} />
            <span><b>删掉</b>　定时任务页里这一条一起删除，执行记录不保留</span></label>
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={leaving} title="离开编排页？" confirmLabel="不保存，离开" danger onCancel={() => setLeaving(false)}
        onConfirm={() => { setLeaving(false); onCancel() }}>
        有未保存的修改，离开后这些改动会丢掉。
      </ConfirmDialog>
    </div>
  )
}

/** 画布上的步骤节点（SPEC-sop-8.6） */
function StepNode({ s, pos, catalog, ctx, sel, bad, onSelect }: {
  s: SopStepDef
  pos: Pos
  catalog: Catalog
  ctx: FieldCtx
  sel: boolean
  bad: Issue[]
  onSelect: () => void
}) {
  const info = nodeInfo(s.kind)
  const branching = isBranching(catalog, s.kind)
  const hasErr = bad.some((x) => x.level === 'error')
  return (
    <div className={cls('sop-cv-node', `sop-cvk-${s.kind}`, sel && 'sel', hasErr && 'bad')} data-node={s.key}
      style={{ left: pos.x, top: pos.y, width: NW }} role="button" tabIndex={0} aria-label={`节点 ${s.name || '未命名'}`}
      aria-invalid={hasErr || undefined} onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}>
      <span className="sop-cv-in" />
      <div className="sop-cv-node-head">
        <KindIcon kind={s.kind} />
        <span className="sop-cv-node-name ellipsis">{s.name || '未命名'}</span>
        {bad.length > 0 && <span className="sop-cv-warn" title={bad.map((x) => x.text).join('\n')} aria-label={`问题：${bad.map((x) => x.text).join('；')}`}>!</span>}
      </div>
      {branching ? (
        <div className="sop-cv-cases">
          {(s.cases ?? []).map((c) => (
            <div key={c.key} className="sop-cv-case">
              <span className="ellipsis">{c.label || '未命名分支'}</span>
              <span className="sop-cv-handle sop-cv-handle-case" data-out={s.key} data-case={c.key} role="button"
                aria-label={`在「${c.label || '未命名分支'}」分支加节点`} title={`拖动连线，或点击在「${c.label}」分支加节点`}>+</span>
            </div>
          ))}
          <div className="sop-cv-rule ellipsis">
            {s.kind === 'classifier' ? 'AI 分类' : isManualDecide(s) ? '人工判断'
              : s.kind === 'loopback' ? `${s.rule?.trim() ? `条件：${s.rule}` : '还没填回退条件'} · 退回 ${s.config?.target || '未选'}`
                : s.rule?.trim() ? `规则：${s.rule}` : '按内置规则判断'}
          </div>
        </div>
      ) : (
        <>
          <div className="sop-cv-desc ellipsis">{info.summary?.(s.config ?? {}, ctx) || s.desc || <span className="faint">{info.label}</span>}</div>
          <span className="sop-cv-handle" data-out={s.key} role="button" aria-label={`在「${s.name || '未命名'}」之后加节点`} title="拖动连线，或点击添加下一个节点">+</span>
        </>
      )}
    </div>
  )
}

