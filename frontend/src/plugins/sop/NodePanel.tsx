// 节点属性面板（SPEC-sop-13）：开始节点（触发方式、输入字段、下一步）和步骤节点（设置 / 上次运行）。
// 所有改动交给编排页进撤销历史；配置项按 nodes.tsx 的 fields 渲染，必填以后端节点目录为准。
// 上次运行：这个流程最近一次走到这一步（不是 pending）的执行，详情按需取
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { useSopRun, type SopField, type SopRunBrief, type SopStepDef } from '../../core/data'
import { Button, Checkbox, IconButton, IconClose, Input, Pill, Select, Textarea, cls } from '../../core/ui'
import { changeKind, childrenOf, isBranching, isRequired, LOOPBACK, START, type Catalog, type Draft, HIDDEN_KINDS, fieldTypePatch, upstreamSteps } from './edit'
import { stepLook, timeAgo } from './model'
import { nodeInfo, useLiveOptions, type ConfigField, type FieldCtx } from './nodes'
import { KindIcon } from './parts'
import { DataView } from './RunView'

type AddAt = (at: { x: number; y: number }, from: string, caseKey?: string) => void

export type TriggerOption = { value: string; label: string }

const NO_CFG: Record<string, string> = {}

/** 配置项：按字段类型渲染，值一律存成字符串（数字、多选也是） */
function ConfigInput({ field, value, cfg, ctx, required, bad, onChange }: {
  field: ConfigField
  value: string
  /** 这个节点的整份配置，选项依赖别的配置项时用 */
  cfg: Record<string, string>
  ctx: FieldCtx
  required: boolean
  bad: boolean
  onChange: (v: string) => void
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
          spellCheck={field.type !== 'code'} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input type={field.type === 'number' ? 'number' : 'text'} invalid={bad} value={value} placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)} />
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

export function NodePanel({ readOnly = false, draft, nodeKey, catalog, ctx, tried, triggers, flowId, runs, onChange, onPatchDraft, onRemove, onRemoveEdge, onSelect, onAddNext, onClose }: {
  readOnly?: boolean
  draft: Draft
  nodeKey: string
  catalog: Catalog
  ctx: FieldCtx
  tried: boolean
  triggers: TriggerOption[]
  /** 新建还没保存时没有 */
  flowId?: string
  runs: readonly SopRunBrief[]
  onChange: (p: Partial<SopStepDef>) => void
  onPatchDraft: (p: Partial<Draft>) => void
  onRemove: () => void
  onRemoveEdge: (from: string, to: string) => void
  onSelect: (k: string) => void
  onAddNext: AddAt
  onClose: () => void
}) {
  const [tab, setTab] = useState<{ key: string; tab: 'set' | 'last' }>({ key: nodeKey, tab: 'set' })
  // 换节点时回到「设置」
  const cur = tab.key === nodeKey ? tab.tab : 'set'
  const s = draft.steps.find((x) => x.key === nodeKey)
  const kids = childrenOf(draft, nodeKey)
  const addBtn = (caseKey?: string) => (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    onAddNext({ x: r.left - 300, y: r.top }, nodeKey, caseKey)
  }

  if (nodeKey === START) {
    const fieldPatch = (i: number, p: Partial<SopField>) => onPatchDraft({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) })
    const trigOpts = triggers.some((t) => t.value === draft.trigger) || !draft.trigger ? triggers : [{ value: draft.trigger, label: draft.trigger }, ...triggers]
    return (
      <aside className="sop-node-panel" aria-label="开始节点">
        <Head kind="start" title={<span className="sop-np-name-static">开始</span>} onClose={onClose} />
        <fieldset disabled={readOnly} className="sop-np-body sop-np-fields form">
          <div className="sop-muted">执行时要填的内容，第一批节点拿它当输入。</div>
          <label className="field">
            <span className="field-label">触发方式</span>
            <Select value={draft.trigger} options={trigOpts} onValueChange={(v) => onPatchDraft({ trigger: v })} />
          </label>
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
        </fieldset>
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
  // 类型下拉按目录分组，隐藏的（notify）只在当前就是它时列出
  const kinds = catalog.types.filter((t) => !HIDDEN_KINDS.includes(t.kind) || t.kind === s.kind)
  const groups = [...new Set(kinds.map((t) => t.group))]

  return (
    <aside className="sop-node-panel" aria-label="节点属性">
      <Head kind={s.kind} onClose={onClose}
        title={<input className="sop-np-name" readOnly={readOnly} value={s.name} placeholder="节点名称" aria-label="节点名称" onChange={(e) => onChange({ name: e.target.value })} />}
        actions={!readOnly && <IconButton label="删除节点" title="删除节点 (Delete)" className="sop-np-del" onClick={onRemove}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </IconButton>} />
      <div className="sop-np-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={cur === 'set'} className={cls(cur === 'set' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'set' })}>设置</button>
        <button type="button" role="tab" aria-selected={cur === 'last'} className={cls(cur === 'last' && 'on')} onClick={() => setTab({ key: nodeKey, tab: 'last' })}>上次运行</button>
      </div>
      {cur === 'set' ? (
        <fieldset disabled={readOnly} className="sop-np-body sop-np-fields form">
          <label className="field">
            <span className="field-label">kind</span>
            <Input value={s.kind} readOnly aria-label="kind" />
          </label>
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
                onChange={(v) => onChange({ config: { ...(s.config ?? {}), ...Object.fromEntries((f.clears ?? []).map((k) => [k, ''])), [f.key]: v } })} />
            )
          })}
          <label className="field">
            <span className="field-label">{info.descLabel ?? '说明'}</span>
            <Textarea rows={s.kind === 'ai' ? 6 : 2} value={s.desc ?? ''} placeholder={info.descHint ?? '给看流程的人一句话说明'}
              onChange={(e) => onChange({ desc: e.target.value })} />
          </label>
          {branching && (
            <>
              {s.kind === 'decide' && (
                <label className="field">
                  <span className="field-label">判断规则<span className="sop-field-hint">留空就是人工判断</span></span>
                  <Input value={s.rule ?? ''} placeholder="比如：金额大于 5000" onChange={(e) => onChange({ rule: e.target.value })} />
                </label>
              )}
              {loop && (
                <label className="field">
                  <span className="field-label">回退条件<span className="sop-field-hint">成立就退回上面选的步骤重做，写法同条件分支</span></span>
                  <Input value={s.rule ?? ''} placeholder="result.verdict 等于 reject" invalid={tried && !s.rule?.trim()} onChange={(e) => onChange({ rule: e.target.value })} />
                </label>
              )}
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
        </fieldset>
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
