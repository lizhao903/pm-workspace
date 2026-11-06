// 节点属性面板（SPEC-sop-13）：开始节点（触发方式、输入字段、下一步）和步骤节点（设置 / 上次运行）。
// 所有改动交给编排页进撤销历史；配置项按 nodes.tsx 的 fields 渲染，必填以后端节点目录为准。
// 上次运行：这个流程最近一次走到这一步（不是 pending）的执行，详情按需取
import { useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { useSopRun, type SopDebug, type SopField, type SopRunBrief, type SopStepDef } from '../../core/data'
import { Button, Checkbox, IconButton, IconClose, Input, Pill, SearchSelect, Select, Textarea, cls } from '../../core/ui'
import { changeKind, childrenOf, isBranching, isRequired, LOOPBACK, START, type Catalog, type Draft, HIDDEN_KINDS, fieldTypePatch, upstreamSteps } from './edit'
import { UNCATEGORIZED, stepLook, timeAgo } from './model'
import { nodeInfo, useLiveOptions, type ConfigField, type FieldCtx } from './nodes'
import { KindIcon } from './parts'
import { DataView } from './RunView'
import { SCHEDULE, defaultSched } from './schedule'
import { StartSchedule } from './StartSchedule'
import { IM, emptyIM } from './imtrigger'
import { StartIM } from './StartIM'
import { CondEditor, FieldsPanel } from './StepFields'
import { DEBUG_LOOK, DebugStartView, DebugStepView } from './Debug'

type AddAt = (at: { x: number; y: number }, from: string, caseKey?: string) => void

export type TriggerOption = { value: string; label: string }

const NO_CFG: Record<string, string> = {}

/** 配置项：按字段类型渲染，值一律存成字符串（数字、多选也是） */
function ConfigInput({ field, value, cfg, ctx, required, bad, onChange, onFocus }: {
  field: ConfigField
  value: string
  /** 这个节点的整份配置，选项依赖别的配置项时用 */
  cfg: Record<string, string>
  ctx: FieldCtx
  required: boolean
  bad: boolean
  onChange: (v: string) => void
  /** 文字类配置项获得焦点：「这一步能拿到的字段」点了往这里插 {{路径}}（TSK-0490） */
  onFocus?: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void
}) {
  const label = (
    <span className="field-label">
      {field.label}{required && <em aria-hidden="true">*</em>}
      {field.hint && <span className="sop-field-hint">{field.hint}</span>}
    </span>
  )
  useLiveOptions(field.live)
  const { load } = field
  useEffect(() => { load?.(ctx, cfg) }, [load, ctx, cfg])
  const options = field.options?.(ctx, cfg) ?? []
  if (field.type === 'multi') {
    const on = value.split(',').filter(Boolean)
    return (
      <div className="field" role="group" aria-label={field.label}>
        {label}
        <div className="sop-chips">
          {options.map((o) => (
            <label key={o.value} className={cls('sop-chip', on.includes(o.value) && 'on')}>
              <input type="checkbox" checked={on.includes(o.value)}
                onChange={() => onChange((on.includes(o.value) ? on.filter((x) => x !== o.value) : [...on, o.value]).join(','))} />
              {o.label}
            </label>
          ))}
          {!options.length && <span className="sop-muted">没有可选的</span>}
        </div>
      </div>
    )
  }
  // 当前值不在选项里（Agent、流程被删了）时照常列出，免得悄悄换成别的
  const selOpts = [
    ...(!options.some((o) => o.value === '') ? [{ value: '', label: '请选择' }] : []),
    ...(value && !options.some((o) => o.value === value) ? [{ value, label: value }] : []),
    ...options,
  ]
  return (
    <label className="field">
      {label}
      {field.type === 'select' ? (
        <Select value={value} invalid={bad} options={selOpts} onValueChange={onChange} />
      ) : field.type === 'textarea' || field.type === 'code' ? (
        <Textarea rows={field.type === 'code' ? 5 : 3} className={cls(field.type === 'code' && 'sop-code-input')} invalid={bad}
          spellCheck={field.type !== 'code'} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} />
      ) : (
        <Input type={field.type === 'number' ? 'number' : 'text'} invalid={bad} value={value} placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)} onFocus={field.type === 'number' ? undefined : onFocus} />
      )}
      {bad && <span className="field-err">必填</span>}
    </label>
  )
}

function NextList({ kids, onSelect, onAdd }: { kids: SopStepDef[]; onSelect: (k: string) => void; onAdd: (e: MouseEvent) => void }) {
  return (
    <div className="field">
      <span className="field-label">下一步<span className="sop-field-hint">{kids.length > 1 ? `并行 ${kids.length} 路` : '添加此节点之后要做的事'}</span></span>
      <div className="sop-np-links">
        {kids.map((k) => (
          <span key={k.key} className="sop-np-link">
            <button type="button" onClick={() => onSelect(k.key)}><KindIcon kind={k.kind} size={16} />{k.name || '未命名'}</button>
          </span>
        ))}
        <button type="button" className="sop-np-add" onClick={onAdd}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          选择下一个节点
        </button>
      </div>
    </div>
  )
}

function Head({ kind, title, actions, onClose }: { kind: string; title: ReactNode; actions?: ReactNode; onClose: () => void }) {
  return (
    <div className="sop-np-head">
      <KindIcon kind={kind} size={26} />
      <div className="sop-np-title">{title}</div>
      {actions}
      <IconButton label="关闭" onClick={onClose}><IconClose /></IconButton>
    </div>
  )
}

let optSeq = 0
const optKey = () => `o${Date.now().toString(36)}${(optSeq += 1).toString(36)}`
const fieldKey = () => `f${Date.now().toString(36)}${(optSeq += 1).toString(36)}`

export function NodePanel({ draft, nodeKey, catalog, ctx, tried, triggers, flowId, runs, debug, onChange, onPatchDraft, onRemove, onRemoveEdge, onSelect, onAddNext, onClose }: {
  draft: Draft
  nodeKey: string
  catalog: Catalog
  ctx: FieldCtx
  tried: boolean
  triggers: TriggerOption[]
  /** 新建还没保存时没有 */
  flowId?: string
  runs: readonly SopRunBrief[]
  /** 编排页当前的调试结果（TSK-0491）：有时多一页「调试」，字段候选叠真实值 */
  debug?: SopDebug
  onChange: (p: Partial<SopStepDef>) => void
  onPatchDraft: (p: Partial<Draft>) => void
  onRemove: () => void
  onRemoveEdge: (from: string, to: string) => void
  onSelect: (k: string) => void
  onAddNext: AddAt
  onClose: () => void
}) {
  const [tab, setTab] = useState<{ key: string; tab: 'set' | 'last' | 'debug' }>({ key: '', tab: 'set' })
  // 最近编辑的文字配置项（或说明）：「这一步能拿到的字段」点了往它的光标处插 {{路径}}（TSK-0490）
  const focused = useRef<{ node: string; key: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null)
  const [copied, setCopied] = useState('')
  // 换节点时回到「设置」
  const s = draft.steps.find((x) => x.key === nodeKey)
  const dstep = debug?.steps.find((x) => x.key === nodeKey)
  // 有调试结果时换节点默认看「调试」，就地看到这一步的真实输入输出（TSK-0491）
  const cur = tab.key === nodeKey ? (tab.tab === 'debug' && !debug ? 'set' : tab.tab) : debug && (dstep || nodeKey === START) ? 'debug' : 'set'
  // 这一步拿到的真实输入，字段候选和条件下拉叠真实值、列出没声明的
  const sample = nodeKey === START ? debug?.input : dstep?.input ?? undefined
  const kids = childrenOf(draft, nodeKey)
  const addBtn = (caseKey?: string) => (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    onAddNext({ x: r.left - 300, y: r.top }, nodeKey, caseKey)
  }

  const copyPath = (path: string) => {
    const t = `{{${path}}}`
    void navigator.clipboard?.writeText(t).catch(() => {})
    setCopied(`已复制 ${t}`)
  }

  if (nodeKey === START) {
    const fieldPatch = (i: number, p: Partial<SopField>) => onPatchDraft({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) })
    const trigOpts = triggers.some((t) => t.value === draft.trigger) || !draft.trigger ? triggers : [{ value: draft.trigger, label: draft.trigger }, ...triggers]
    return (
      <aside className="sop-node-panel" aria-label="开始节点">
        <Head kind="start" title={<span className="sop-np-name-static">开始</span>} onClose={onClose} />
        {debug && (
          <div className="sop-np-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={cur !== 'debug'} className={cls(cur !== 'debug' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'set' })}>设置</button>
            <button type="button" role="tab" aria-selected={cur === 'debug'} className={cls(cur === 'debug' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'debug' })}>调试</button>
          </div>
        )}
        {cur === 'debug' && debug ? <DebugStartView res={debug} /> : (
        <div className="sop-np-body form">
          <div className="sop-muted">执行时要填的内容，第一批节点拿它当输入。</div>
          {/* 文件夹（TSK-0482）：流程库里按它分类，保存时一起存；文件夹在流程库里建 */}
          <div className="field">
            <span className="field-label">文件夹</span>
            <SearchSelect variant="field" value={draft.folder_id ?? ''} placeholder={UNCATEGORIZED} noneLabel={UNCATEGORIZED} searchPlaceholder="搜文件夹"
              aria-label="文件夹" emptyText="还没有文件夹，在流程库里新建" missingLabel={() => '文件夹已删除，换一个'}
              options={(ctx.folders ?? []).map((f) => ({ value: f.id, label: f.name }))}
              onChange={(v) => onPatchDraft({ folder_id: v || null })} />
          </div>
          <label className="field">
            <span className="field-label">触发方式</span>
            <Select value={draft.trigger} options={trigOpts}
              onValueChange={(v) => onPatchDraft(v === SCHEDULE && !draft.sched ? { trigger: v, sched: defaultSched() } : v === IM && !draft.im ? { trigger: v, im: emptyIM() } : { trigger: v })} />
          </label>
          {/* 定时（TSK-0463）：时间规则在这里配，保存时写进随流程管理的定时任务 */}
          {draft.trigger === SCHEDULE && (
            <StartSchedule sched={draft.sched} fields={draft.fields} onChange={(sched) => onPatchDraft({ sched })} />
          )}
          {/* IM 消息（TSK-0481）：会话、与我的关系过滤，执行顺序与拦截 */}
          {draft.trigger === IM && (
            <StartIM im={draft.im ?? emptyIM()} flowId={flowId} imFlows={ctx.imFlows ?? []} onChange={(im) => onPatchDraft({ im })} />
          )}
          <div className="field">
            <span className="field-label">输入字段</span>
            <div className="sop-field-list">
              {draft.fields.map((f, i) => (
                <div key={f.key} className="sop-field-item">
                  <div className="sop-field-line">
                    <Input value={f.label} placeholder="字段名称" aria-label={`第 ${i + 1} 个字段名称`} invalid={tried && !f.label.trim()}
                      onChange={(e) => fieldPatch(i, { label: e.target.value })} />
                    <Select value={f.type} aria-label={`第 ${i + 1} 个字段类型`} options={[{ value: 'text', label: '单行' }, { value: 'textarea', label: '多行' }, { value: 'select', label: '下拉' }]}
                      onValueChange={(v) => fieldPatch(i, fieldTypePatch(f, v as SopField['type'], optKey))} />
                    <Checkbox checked={!!f.required} onCheckedChange={(c) => fieldPatch(i, { required: c })}>必填</Checkbox>
                    <IconButton label="删除这个字段" size="sm" disabled={draft.fields.length < 2}
                      onClick={() => onPatchDraft({ fields: draft.fields.filter((_, j) => j !== i) })}><IconClose /></IconButton>
                  </div>
                  {/* 下拉字段：逐项编辑选项，选项的值建好就不变，改的只是显示名 */}
                  {f.type === 'select' && (
                    <div className="sop-field-opts">
                      {(f.options ?? []).map((o, k) => (
                        <div key={o.value} className="sop-field-opt">
                          <Input value={o.label} placeholder={`选项 ${k + 1}`} aria-label={`选项 ${k + 1}`}
                            onChange={(e) => fieldPatch(i, { options: f.options!.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} />
                          <IconButton label="删除这个选项" size="sm" disabled={(f.options?.length ?? 0) < 2}
                            onClick={() => fieldPatch(i, { options: f.options!.filter((_, j) => j !== k), ...(f.default === o.value ? { default: '' } : {}) })}><IconClose /></IconButton>
                        </div>
                      ))}
                      <Button size="sm" className="sop-case-add" onClick={() => fieldPatch(i, { options: [...(f.options ?? []), { value: optKey(), label: '' }] })}>加一个选项</Button>
                    </div>
                  )}
                </div>
              ))}
              <Button size="sm" className="sop-case-add" onClick={() => onPatchDraft({ fields: [...draft.fields, { key: fieldKey(), label: '', type: 'text' }] })}>加一个字段</Button>
            </div>
          </div>
          <NextList kids={kids} onSelect={onSelect} onAdd={addBtn()} />
          <FieldsPanel draft={draft} stepKey={START} sample={sample} onPick={(p) => copyPath(p)} />
          {copied && <span className="sop-muted" role="status">{copied}</span>}
        </div>
        )}
      </aside>
    )
  }
  if (!s) return null
  const info = nodeInfo(s.kind)
  const branching = isBranching(catalog, s.kind)
  const ups = (s.after ?? []).map((k) => draft.steps.find((x) => x.key === k)).filter((x): x is SopStepDef => !!x)
  const loop = s.kind === LOOPBACK
  // 条件回退选退回目标：这个节点沿依赖往上的所有步骤（AUTO-02）
  const nodeCtx: FieldCtx = loop ? { ...ctx, ups: upstreamSteps(draft, draft.steps.indexOf(s)).map((x) => ({ key: x.key, name: x.name })) } : ctx
  const track = (key: string) => (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { focused.current = { node: s.key, key, el: e.target } }
  // 点字段：插到最近编辑的文字配置项（或说明）的光标处，没编辑过就复制
  const pick = (path: string) => {
    const f = focused.current
    if (!f || f.node !== s.key) { copyPath(path); return }
    const t = `{{${path}}}`
    const cur = f.key === '__desc' ? s.desc ?? '' : s.config?.[f.key] ?? ''
    const at = Math.min(f.el.selectionStart ?? cur.length, cur.length)
    const next = cur.slice(0, at) + t + cur.slice(f.el.selectionEnd ?? at)
    if (f.key === '__desc') onChange({ desc: next })
    else onChange({ config: { ...(s.config ?? {}), [f.key]: next } })
    setCopied(`已插入 ${t}`)
  }
  // 类型下拉按目录分组，隐藏的（notify）只在当前就是它时列出
  const kinds = catalog.types.filter((t) => !HIDDEN_KINDS.includes(t.kind) || t.kind === s.kind)
  const groups = [...new Set(kinds.map((t) => t.group))]

  return (
    <aside className="sop-node-panel" aria-label="节点属性">
      <Head kind={s.kind} onClose={onClose}
        title={<input className="sop-np-name" value={s.name} placeholder="节点名称" aria-label="节点名称" onChange={(e) => onChange({ name: e.target.value })} />}
        actions={<IconButton label="删除节点" title="删除节点 (Delete)" className="sop-np-del" onClick={onRemove}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </IconButton>} />
      <div className="sop-np-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={cur === 'set'} className={cls(cur === 'set' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'set' })}>设置</button>
        <button type="button" role="tab" aria-selected={cur === 'last'} className={cls(cur === 'last' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'last' })}>上次运行</button>
        {debug && (
          <button type="button" role="tab" aria-selected={cur === 'debug'} className={cls(cur === 'debug' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'debug' })}>
            调试{dstep ? ` · ${DEBUG_LOOK[dstep.status].label}` : ''}
          </button>
        )}
      </div>
      {cur === 'set' ? (
        <div className="sop-np-body form">
          <label className="field">
            <span className="field-label">类型<span className="sop-field-hint">{info.desc}</span></span>
            <select className="select" value={s.kind} onChange={(e) => onChange(changeKind(catalog, s, e.target.value))}>
              {!catalog.byKind.has(s.kind) && <option value={s.kind}>{info.label}</option>}
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {kinds.filter((t) => t.group === g).map((t) => <option key={t.kind} value={t.kind}>{nodeInfo(t.kind).label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {info.fields.filter((f) => !f.hidden?.(s.config ?? NO_CFG)).map((f) => {
            const req = isRequired(catalog, s.kind, f.key)
            return (
              <ConfigInput key={f.key} field={f} value={s.config?.[f.key] ?? ''} cfg={s.config ?? NO_CFG} ctx={nodeCtx} required={req} bad={tried && req && !s.config?.[f.key]?.trim()}
                onFocus={f.type === 'select' || f.type === 'multi' ? undefined : track(f.key)}
                onChange={(v) => onChange({ config: { ...(s.config ?? {}), ...Object.fromEntries((f.clears ?? []).map((k) => [k, ''])), [f.key]: v } })} />
            )
          })}
          <label className="field">
            <span className="field-label">{info.descLabel ?? '说明'}</span>
            <Textarea rows={s.kind === 'ai' ? 6 : 2} value={s.desc ?? ''} placeholder={info.descHint ?? '给看流程的人一句话说明'}
              onChange={(e) => onChange({ desc: e.target.value })} onFocus={track('__desc')} />
          </label>
          {branching && (
            <>
              {(s.kind === 'decide' || loop) && <CondEditor step={s} draft={draft} tried={tried} loop={loop} sample={sample} onChange={onChange} />}
              <div className="field" role="group" aria-label={s.kind === 'classifier' ? '类别' : loop ? '出口' : '分支'}>
                <span className="field-label">{s.kind === 'classifier' ? '类别' : loop ? '出口' : '分支'}
                  {s.kind === 'classifier' && <span className="sop-field-hint">每一类一个出口；类别名写清楚，分类更准</span>}
                  {loop && <span className="sop-field-hint">条件不成立走「通过」；退回轮次用完还成立走「超限」，没接步骤时这一步失败</span>}
                </span>
                <div className="sop-case-list">
                  {(s.cases ?? []).map((c, ci) => (
                    <div key={c.key} className="sop-case-row">
                      <Input value={c.label} aria-label={`第 ${ci + 1} 个分支名称`} invalid={tried && !c.label.trim()}
                        onChange={(e) => onChange({ cases: s.cases!.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)) })} />
                      <span className="sop-case-count">{draft.steps.filter((x) => x.branch?.of === s.key && x.branch.case === c.key).length} 个节点</span>
                      <Button size="sm" onClick={addBtn(c.key)}>加节点</Button>
                      {(s.cases ?? []).length > 2 && !loop && <Button size="sm" onClick={() => onChange({ cases: s.cases!.filter((x) => x.key !== c.key) })}>删除</Button>}
                    </div>
                  ))}
                  {!loop && <Button size="sm" className="sop-case-add"
                    onClick={() => onChange({ cases: [...(s.cases ?? []), { key: `c${Date.now().toString(36)}`, label: `分支 ${(s.cases?.length ?? 0) + 1}` }] })}>加一个分支</Button>}
                </div>
              </div>
            </>
          )}
          <div className="field">
            <span className="field-label">上游<span className="sop-field-hint">{ups.length > 1 ? '汇合：等这几个都完成才开始' : '从画布上拖线可以再连一个上游'}</span></span>
            <div className="sop-np-links">
              {ups.length ? ups.map((u) => (
                <span key={u.key} className="sop-np-link">
                  <button type="button" onClick={() => onSelect(u.key)}>
                    <KindIcon kind={u.kind} size={16} />{u.name || '未命名'}
                    {s.branch?.of === u.key && ` · ${u.cases?.find((c) => c.key === s.branch!.case)?.label ?? s.branch.case}`}
                  </button>
                  <IconButton label={`断开 ${u.name || '未命名'}`} size="sm" className="sop-np-link-x" onClick={() => onRemoveEdge(u.key, s.key)}><IconClose /></IconButton>
                </span>
              )) : (
                <span className="sop-np-link"><button type="button" onClick={() => onSelect(START)}><KindIcon kind="start" size={16} />开始</button></span>
              )}
            </div>
          </div>
          {!branching && <NextList kids={kids} onSelect={onSelect} onAdd={addBtn()} />}
          <FieldsPanel draft={draft} stepKey={s.key} sample={sample} onPick={pick} />
          {copied && <span className="sop-muted" role="status">{copied}</span>}
        </div>
      ) : cur === 'debug' && debug ? (
        dstep ? <DebugStepView s={dstep} res={debug} /> : <div className="sop-np-body"><div className="sop-io-empty">这次调试时还没有这一步，再调试一次</div></div>
      ) : (
        <LastRun flowId={flowId} stepKey={s.key} step={s} runs={runs} />
      )}
    </aside>
  )
}

function LastRun({ flowId, stepKey, step, runs }: { flowId?: string; stepKey: string; step: SopStepDef; runs: readonly SopRunBrief[] }) {
  const brief = useMemo(() => (flowId ? [...runs].filter((r) => r.flow_id === flowId)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .find((r) => r.steps.some((x) => x.key === stepKey && x.status !== 'pending')) : undefined), [runs, flowId, stepKey])
  const run = useSopRun(brief?.id ?? null)
  if (!brief) return <div className="sop-np-body"><div className="sop-io-empty">这个节点还没运行过。点右上角「测试运行」跑一次，这里会留下它的输入和输出。</div></div>
  const rs = run.data?.steps.find((x) => x.key === stepKey)
  const look = stepLook(rs?.status ?? brief.steps.find((x) => x.key === stepKey)!.status)
  return (
    <div className="sop-np-body">
      <div className="sop-np-last">
        <div className="sop-np-last-head">
          <Pill label={look.label} color={look.color} />
          <span className="sop-muted">{brief.title} · {timeAgo(brief.started_at)}</span>
        </div>
        {run.isPending ? <div className="sop-io-empty">加载中</div> : run.isError || !rs ? <div className="sop-io-empty">这次执行没取到</div> : (
          <>
            {rs.route && <div className="sop-insp-route">走「{step.cases?.find((c) => c.key === rs.route)?.label ?? rs.route}」分支</div>}
            <div className="sop-section-label">输入</div>
            <div className="sop-insp-body">{rs.input ? <DataView data={rs.input} /> : <div className="sop-io-empty">没有输入</div>}</div>
            <div className="sop-section-label">输出</div>
            <div className="sop-insp-body">{rs.output ? <DataView data={rs.output} /> : <div className="sop-io-empty">{rs.error || '没有输出'}</div>}</div>
          </>
        )}
      </div>
    </div>
  )
}
