// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 结构化条件和「这一步能拿到的字段」（TSK-0490，规格 SPEC-sop-9.11、9.21、9.33）。
// 条件分支、条件回退的条件存成「字段 + 运算符 + 值」的结构（cond），可多条且 / 或；不做自然语言转规则，一句话只能写进说明。
// 字段候选是静态声明推出来的：触发方式自动带入的、输入字段、上游每一步声明的输出（正式产品是 GET /api/sop/node-types 的 outputs、
// POST /api/sop/step-fields）。原型里的声明只列常用的几种节点，写在 OUTPUTS 里。
import { getPath } from './nodetypes'
import './sopcond.css'
import type { Json, Sop, SopStepDef } from './sopflow'

export type CondOp = 'eq' | 'ne' | 'contains' | 'not_contains' | 'empty' | 'not_empty'
export type CondItem = { field: string; op: CondOp; value: string }
export type SopCond = { logic: 'and' | 'or'; items: CondItem[] }

export const COND_OPS: { value: CondOp; label: string }[] = [
  { value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }, { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' }, { value: 'empty', label: '为空' }, { value: 'not_empty', label: '不为空' },
]
export const unaryOp = (op: string) => op === 'empty' || op === 'not_empty'
const opLabel = (op: string) => COND_OPS.find((o) => o.value === op)?.label ?? op
export const blankCond = (): SopCond => ({ logic: 'and', items: [{ field: '', op: 'eq', value: '' }] })

const txt = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))
const empty = (v: unknown) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length)

/** 求值，口径同后端 evalCond */
export function evalCond(c: SopCond, input: Json): boolean {
  const one = (it: CondItem) => {
    const got = getPath(input, it.field)
    switch (it.op) {
      case 'eq': return txt(got) === it.value
      case 'ne': return txt(got) !== it.value
      case 'contains': case 'not_contains': {
        const ok = Array.isArray(got) ? got.some((x) => txt(x) === it.value) : txt(got).includes(it.value)
        return ok === (it.op === 'contains')
      }
      default: return empty(got) === (it.op === 'empty')
    }
  }
  return c.logic === 'or' ? c.items.some(one) : c.items.every(one)
}

export function condText(c: SopCond): string {
  const q = (v: string) => (v === '' || /\s/.test(v) ? JSON.stringify(v) : v)
  return c.items.map((it) => `${it.field || '（没选字段）'} ${opLabel(it.op)}${unaryOp(it.op) ? '' : ` ${q(it.value)}`}`).join(c.logic === 'or' ? ' 或 ' : ' 且 ')
}

const RULE_RE = /^\s*(\S+)\s+(不等于|等于|不包含|包含)\s+(.*?)\s*$/
/** 旧的一行规则换成等价的结构化条件；一句话回 null */
export function legacyCond(rule: string): SopCond | null {
  const m = RULE_RE.exec(rule)
  if (!m) return null
  let v = m[3]
  for (const [a, b] of [['"', '"'], ["'", "'"], ['「', '」']]) if (v.length >= 2 && v.startsWith(a) && v.endsWith(b)) v = v.slice(1, -1)
  return { logic: 'and', items: [{ field: m[1], op: ({ 等于: 'eq', 不等于: 'ne', 包含: 'contains', 不包含: 'not_contains' } as const)[m[2] as '等于'], value: v }] }
}

/** 条件的写法问题（字段拿不拿得到另查） */
export function condProblems(c: SopCond): string[] {
  const out: string[] = []
  if (!c.items.length) out.push('条件是空的')
  c.items.forEach((it, i) => {
    if (!it.field.trim()) out.push(`第 ${i + 1} 条条件没选字段`)
    if ((it.op === 'contains' || it.op === 'not_contains') && !it.value) out.push(`第 ${i + 1} 条条件「${opLabel(it.op)}」后面要有值`)
  })
  return out
}

export type FieldInfo = { path: string; type: string; label: string; values?: { value: string; label: string }[] }
export type FieldGroup = { source: 'trigger' | 'input' | 'step' | 'loopback'; label: string; fields: FieldInfo[] }

const REL = [{ value: 'me', label: '@我' }, { value: 'all', label: '@所有人' }, { value: 'dm', label: '私聊' }, { value: '', label: '无关（空串）' }]
/** IM 触发自动带进输入的字段（同后端 Triggers） */
export const IM_FIELDS: FieldInfo[] = [
  { path: 'message_id', type: 'string', label: '消息 id' }, { path: 'channel', type: 'string', label: '渠道' },
  { path: 'connector_id', type: 'string', label: '连接器 id' }, { path: 'conversation_id', type: 'string', label: '会话 id（cv_ 开头）' },
  { path: 'stakeholder_id', type: 'string', label: '发信人联系人 id' }, { path: 'relevance', type: 'string', label: '和我的关系', values: REL },
  { path: 'at', type: 'string', label: '发送时间' },
]
/** 常用节点声明的输出（同后端 spec.go、各插件 sopspec.go 的一部分） */
const OUTPUTS: Record<string, (s: SopStepDef) => FieldInfo[]> = {
  ai: (s) => [{ path: s.config?.output || 'result', type: 'string', label: '模型的回答' }],
  template: (s) => [{ path: s.config?.output || 'text', type: 'string', label: '拼好的文字' }],
  extract: (s) => (s.config?.fields ?? '').split(/[,，、\s]+/).filter(Boolean).map((f) => ({ path: `extracted.${f}`, type: 'string', label: `提取出的「${f}」` })),
  http: () => [{ path: 'http.status', type: 'number', label: 'HTTP 状态码' }, { path: 'http.body', type: 'any', label: '响应体' }],
  task: () => [{ path: 'task.id', type: 'string', label: '任务 id' }, { path: 'task.ref', type: 'string', label: '任务编号' }],
  claude_code: () => [{ path: 'status', type: 'string', label: '执行结果' }, { path: 'summary', type: 'string', label: '摘要' },
    { path: 'result.verdict', type: 'string', label: '结论', values: [{ value: 'pass', label: '通过' }, { value: 'reject', label: '退回' }] }],
  im_get_message: () => [{ path: 'message.text', type: 'string', label: '正文' }, { path: 'message.sender', type: 'string', label: '发信人' },
    { path: 'message.conversation', type: 'string', label: '会话名' }, { path: 'message.relevance', type: 'string', label: '和我的关系（中文）',
      values: [{ value: '@我', label: '@我' }, { value: '@所有人', label: '@所有人' }, { value: '私聊', label: '私聊' }, { value: '无关', label: '无关' }] },
    { path: 'message.project_id', type: 'string', label: '归到的项目 id' }],
  im_mark_message: () => [{ path: 'marked.state', type: 'string', label: '标成了什么' }],
}

/** 第 i 步能拿到的字段：触发方式自动带入、输入字段、沿依赖往上每一步声明的输出、被条件回退退回时的 feedback */
export function stepFields(sop: Sop, i: number, upstream: (i: number) => number[]): FieldGroup[] {
  const out: FieldGroup[] = []
  if (sop.trigger === 'im') out.push({ source: 'trigger', label: 'IM 消息自动带入', fields: IM_FIELDS })
  const auto = sop.trigger === 'im' ? IM_FIELDS.map((f) => f.path) : []
  const inputs = sop.fields.filter((f) => !auto.includes(f.key)).map((f) => ({ path: f.key, type: 'string', label: f.label, values: f.options }))
  if (inputs.length) out.push({ source: 'input', label: '输入字段', fields: inputs })
  if (i < 0) return out
  for (const j of upstream(i)) {
    const s = sop.steps[j]
    const fields = OUTPUTS[s.kind]?.(s) ?? []
    if (fields.length) out.push({ source: 'step', label: `「${s.name || s.key}」的输出`, fields })
  }
  if (sop.steps.some((x) => x.kind === 'loopback' && x.config?.target === sop.steps[i].key)) {
    out.push({ source: 'loopback', label: '被条件回退退回重做时带上', fields: [{ path: 'feedback', type: 'object', label: '退回时的意见' }] })
  }
  return out
}

/** 条件编辑（SPEC-sop-9.11、9.21）：且 / 或、每条「字段 运算符 值」，字段从这一步能拿到的里选；旧规则一键转，一句话挪进说明 */
export function CondEditor({ step, groups, loop, tried, onChange }: {
  step: SopStepDef
  groups: FieldGroup[]
  loop: boolean
  tried: boolean
  onChange: (p: Partial<SopStepDef>) => void
}) {
  const rule = step.rule?.trim() ?? ''
  const legacy = rule ? legacyCond(rule) : null
  const c = step.cond
  const find = (p: string) => groups.flatMap((g) => g.fields).find((f) => f.path === p)
  const setItem = (i: number, p: Partial<CondItem>) => c && onChange({ cond: { ...c, items: c.items.map((x, j) => (j === i ? { ...x, ...p } : x)) } })
  return (
    <div className="field">
      <span className="field-label">{loop ? '回退条件' : '判断条件'}<span className="field-hint">{loop ? '成立就退回上面选的步骤重做' : '成立走第一个分支，不成立走第二个；没有条件就是人工判断'}</span></span>
      {rule && !c && (legacy ? (
        <div className="cond-legacy">旧写法的规则「{rule}」，执行仍按它判断。<button type="button" className="act act-quiet" onClick={() => onChange({ cond: legacy, rule: undefined })}>转成结构化条件</button></div>
      ) : (
        <div className="cond-legacy bad">「{rule}」是一句话，程序没法照着判断。<button type="button" className="act act-quiet"
          onClick={() => onChange({ rule: undefined, desc: [step.desc?.trim(), rule].filter(Boolean).join('\n'), cond: blankCond() })}>挪进说明，改用条件</button></div>
      ))}
      {c ? (
        <div className="cond-list">
          {c.items.length > 1 && (
            <div className="cond-logic">
              {(['and', 'or'] as const).map((l) => <button key={l} type="button" className={`chip${c.logic === l ? ' on' : ''}`} onClick={() => onChange({ cond: { ...c, logic: l } })}>{l === 'and' ? '全部满足（且）' : '满足任一条（或）'}</button>)}
            </div>
          )}
          {c.items.map((it, i) => {
            const f = find(it.field)
            return (
              <div key={i} className="cond-row">
                <select className={tried && !it.field ? 'bad' : undefined} value={it.field} aria-label={`第 ${i + 1} 条条件的字段`}
                  onChange={(e) => { const nf = find(e.target.value); setItem(i, { field: e.target.value, ...(nf?.values?.length ? { value: nf.values[0].value } : {}) }) }}>
                  <option value="">选字段</option>
                  {it.field && !f && <option value={it.field}>{it.field}（这一步拿不到）</option>}
                  {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.fields.map((x) => <option key={x.path} value={x.path}>{x.path} · {x.label}</option>)}</optgroup>)}
                </select>
                <select value={it.op} aria-label={`第 ${i + 1} 条条件的运算符`} onChange={(e) => setItem(i, { op: e.target.value as CondOp, ...(unaryOp(e.target.value) ? { value: '' } : {}) })}>
                  {COND_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {!unaryOp(it.op) && (f?.values?.length ? (
                  <select value={it.value} aria-label={`第 ${i + 1} 条条件的值`} onChange={(e) => setItem(i, { value: e.target.value })}>
                    {f.values.map((v) => <option key={v.value} value={v.value}>{v.value === '' ? `（空）${v.label}` : `${v.value} · ${v.label}`}</option>)}
                  </select>
                ) : <input value={it.value} placeholder="值" aria-label={`第 ${i + 1} 条条件的值`} onChange={(e) => setItem(i, { value: e.target.value })} />)}
                <button type="button" className="act act-quiet" aria-label={`删掉第 ${i + 1} 条条件`}
                  onClick={() => onChange({ cond: c.items.length > 1 ? { ...c, items: c.items.filter((_, j) => j !== i) } : loop ? blankCond() : undefined })}>×</button>
              </div>
            )
          })}
          <button type="button" className="act act-quiet case-add" onClick={() => onChange({ cond: { ...c, items: [...c.items, { field: '', op: 'eq', value: '' }] } })}>加一条条件</button>
        </div>
      ) : !rule && (
        <div className="cond-none">
          {!loop && <span className="muted">人工判断：执行到这里停下，由人选走哪个分支。</span>}
          <button type="button" className="act act-quiet case-add" onClick={() => onChange({ cond: blankCond() })}>{loop ? '填回退条件' : '改成按条件自动判断'}</button>
        </div>
      )}
    </div>
  )
}

/** 这一步能拿到的字段（SPEC-sop-9.33）：按来源分组，点了把 {{路径}} 交给调用方（插到最近编辑的配置项，或复制） */
export function FieldsList({ groups, onPick }: { groups: FieldGroup[]; onPick: (path: string) => void }) {
  return (
    <div className="field">
      <span className="field-label">这一步能拿到的字段<span className="field-hint">点字段插入 {'{{路径}}'}；按节点声明列出，不用先跑一次</span></span>
      {!groups.length ? <span className="muted">还没有能用的字段</span> : (
        <div className="fields-groups">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="fields-group-head">{g.label}</div>
              {g.fields.map((f) => (
                <button key={f.path} type="button" className="field-pick" onClick={() => onPick(f.path)}>
                  <code>{f.path}</code><span className="muted">{f.label}{f.values?.length ? `（${f.values.map((v) => `${v.value || '空'}=${v.label}`).join('、')}）` : ''}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
