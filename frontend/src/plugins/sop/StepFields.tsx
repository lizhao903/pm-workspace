// 结构化条件和「这一步能拿到的字段」（TSK-0490，SPEC-sop-9.11、9.33）。
// 字段候选来自 POST /api/sop/step-fields：触发方式自动带入的、输入字段、沿依赖往上每一步声明的输出，按来源分组，静态推出来不用跑一次。
// 条件从这里点选字段、选运算符、填值（字段有取值说明时值也是下拉）；旧的一行规则给「转成结构化条件」，写成一句话的只能挪进说明。
// TSK-0491（试跑 / 调试）衔接：字段带 sample（真实值）、declared=false（实际返回但没声明）时这里照样列出，样式另标。
import { useState } from 'react'
import { SOP_COND_OPS, useSopStepFields, type SopCond, type SopCondItem, type SopFieldGroup, type SopFieldInfo, type SopStepDef } from '../../core/data'
import { Button, IconButton, IconClose, Input, cls } from '../../core/ui'
import { blankItem, condProblems, legacyCond, unaryOp } from './cond'
import type { Draft } from './edit'

const typeLabel: Record<string, string> = { string: '文字', number: '数字', bool: '是 / 否', object: '对象', list: '列表', any: '任意' }

/** 字段在下拉里的一行：路径 · 说明 */
const fieldText = (f: SopFieldInfo) => `${f.path}${f.label ? ` · ${f.label}` : ''}`

function findField(groups: readonly SopFieldGroup[], path: string): SopFieldInfo | undefined {
  for (const g of groups) {
    const f = g.fields.find((x) => x.path === path)
    if (f) return f
  }
  return undefined
}

/** 条件编辑：且 / 或、每条「字段 运算符 值」；没有条件的条件分支是人工判断，条件回退必须有 */
export function CondEditor({ step, draft, tried, loop, onChange }: {
  step: SopStepDef
  draft: Draft
  tried: boolean
  /** 条件回退：必须有条件，没有「人工判断」 */
  loop: boolean
  onChange: (p: Partial<SopStepDef>) => void
}) {
  const fields = useSopStepFields(draft, step.key)
  const groups = fields.data ?? []
  const rule = step.rule?.trim() ?? ''
  const legacy = rule ? legacyCond(rule) : null
  const cond = step.cond
  const setCond = (c: SopCond | undefined) => onChange({ cond: c })
  const setItem = (i: number, p: Partial<SopCondItem>) => cond && setCond({ ...cond, items: cond.items.map((x, j) => (j === i ? { ...x, ...p } : x)) })
  const problems = cond ? condProblems(cond) : []

  return (
    <div className="field" role="group" aria-label={loop ? '回退条件' : '判断条件'}>
      <span className="field-label">{loop ? '回退条件' : '判断条件'}
        <span className="sop-field-hint">{loop ? '成立就退回上面选的步骤重做' : '成立走第一个分支，不成立走第二个；没有条件就是人工判断'}</span>
      </span>
      {rule && !cond && (
        legacy ? (
          <div className="sop-cond-legacy" role="note">
            <span>旧写法的规则「{rule}」，执行仍按它判断。建议转成结构化条件，之后从字段里选。</span>
            <Button size="sm" onClick={() => onChange({ cond: legacy, rule: undefined })}>转成结构化条件</Button>
          </div>
        ) : (
          <div className="sop-cond-legacy bad" role="alert">
            <span>「{rule}」是一句话，程序没法照着判断。把这句话挪进说明，再从下面的字段里选条件。</span>
            <Button size="sm" onClick={() => onChange({ rule: undefined, desc: [step.desc?.trim(), rule].filter(Boolean).join('\n'), cond: { logic: 'and', items: [blankItem()] } })}>挪进说明，改用条件</Button>
          </div>
        )
      )}
      {cond ? (
        <div className="sop-cond">
          {cond.items.length > 1 && (
            <div className="sop-cond-logic" role="radiogroup" aria-label="组合方式">
              {(['and', 'or'] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={cond.logic === l} className={cls('sop-chip', cond.logic === l && 'on')}
                  onClick={() => setCond({ ...cond, logic: l })}>{l === 'and' ? '全部满足（且）' : '满足任一条（或）'}</button>
              ))}
            </div>
          )}
          {cond.items.map((it, i) => {
            const f = findField(groups, it.field)
            const known = !it.field || !!f || groups.some((g) => g.fields.some((x) => it.field.startsWith(`${x.path}.`) || it.field.startsWith(`${x.path}[`)))
            return (
              <div key={i} className="sop-cond-row">
                <select className={cls('select', ((tried && !it.field) || !known) && 'bad')} value={it.field} aria-label={`第 ${i + 1} 条条件的字段`}
                  onChange={(e) => {
                    const nf = findField(groups, e.target.value)
                    setItem(i, { field: e.target.value, ...(nf?.values?.length && !nf.values.some((v) => v.value === it.value) ? { value: nf.values[0].value } : {}) })
                  }}>
                  <option value="">选字段</option>
                  {it.field && !f && <option value={it.field}>{it.field}（{known ? '对象下的字段' : '这一步拿不到'}）</option>}
                  {groups.map((g) => (
                    <optgroup key={`${g.source}:${g.step ?? ''}`} label={g.label}>
                      {g.fields.map((x) => <option key={x.path} value={x.path}>{fieldText(x)}</option>)}
                    </optgroup>
                  ))}
                </select>
                <select className="select sop-cond-op" value={it.op} aria-label={`第 ${i + 1} 条条件的运算符`}
                  onChange={(e) => setItem(i, { op: e.target.value as SopCondItem['op'], ...(unaryOp(e.target.value) ? { value: '' } : {}) })}>
                  {SOP_COND_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {!unaryOp(it.op) && (f?.values?.length ? (
                  <select className="select" value={it.value} aria-label={`第 ${i + 1} 条条件的值`} onChange={(e) => setItem(i, { value: e.target.value })}>
                    {!f.values.some((v) => v.value === it.value) && <option value={it.value}>{it.value || '（空）'}</option>}
                    {f.values.map((v) => <option key={v.value} value={v.value}>{v.value === '' ? `（空）${v.label}` : `${v.value} · ${v.label}`}</option>)}
                  </select>
                ) : (
                  <Input value={it.value} placeholder="值" aria-label={`第 ${i + 1} 条条件的值`} onChange={(e) => setItem(i, { value: e.target.value })} />
                ))}
                <IconButton label={`删掉第 ${i + 1} 条条件`} size="sm"
                  onClick={() => setCond(cond.items.length > 1 ? { ...cond, items: cond.items.filter((_, j) => j !== i) } : loop ? { ...cond, items: [blankItem()] } : undefined)}>
                  <IconClose />
                </IconButton>
              </div>
            )
          })}
          {problems.length > 0 && tried && <span className="field-err">{problems.join('；')}</span>}
          <Button size="sm" className="sop-case-add" onClick={() => setCond({ ...cond, items: [...cond.items, blankItem()] })}>加一条条件</Button>
        </div>
      ) : !rule && (
        <div className="sop-cond-none">
          {!loop && <span className="sop-muted">人工判断：执行到这里停下，由人选走哪个分支。</span>}
          <Button size="sm" className="sop-case-add" onClick={() => setCond({ logic: 'and', items: [blankItem()] })}>{loop ? '填回退条件' : '改成按条件自动判断'}</Button>
        </div>
      )}
      {fields.isError && <span className="sop-muted">字段候选没取到，先手填字段路径也行，保存时会校验</span>}
    </div>
  )
}

/** 这一步能拿到的字段：按来源分组，点一下插进刚才编辑的配置项（{{路径}}），没在编辑配置项时复制到剪贴板 */
export function FieldsPanel({ draft, stepKey, onPick }: {
  draft: Draft
  /** 步骤 key；开始节点是 __start（第一步拿到的） */
  stepKey: string
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  const fields = useSopStepFields(draft, stepKey)
  const groups = fields.data ?? []
  const total = groups.reduce((n, g) => n + g.fields.length, 0)
  return (
    <div className="field sop-fields-panel">
      <button type="button" className="field-label sop-fields-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        这一步能拿到的字段{total > 0 && ` · ${total} 个`}
        <span className="sop-field-hint">点字段插入 {'{{路径}}'}；按节点声明列出，不用先跑一次</span>
      </button>
      {open && (fields.isPending ? <span className="sop-muted">加载中</span> : !groups.length ? <span className="sop-muted">还没有能用的字段</span> : (
        <div className="sop-fields-groups">
          {groups.map((g) => (
            <div key={`${g.source}:${g.step ?? ''}`} className="sop-fields-group">
              <div className="sop-fields-group-head">{g.label}{g.open && <span className="sop-field-hint">可能还有没列出的字段</span>}</div>
              {g.fields.map((f) => (
                <button key={f.path} type="button" className={cls('sop-field-pick', !f.declared && 'undeclared')} title={[f.label, f.example && `例：${f.example}`].filter(Boolean).join('\n')}
                  onClick={() => onPick(f.path)}>
                  <code>{f.path}</code>
                  <span className="sop-field-type">{typeLabel[f.type] ?? f.type}</span>
                  <span className="sop-field-desc ellipsis">{f.label}{f.values?.length ? `（${f.values.map((v) => (v.value === '' ? `空=${v.label}` : `${v.value}=${v.label}`)).join('、')}）` : ''}</span>
                  {f.sample !== undefined && <span className="sop-field-sample ellipsis">{JSON.stringify(f.sample)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
