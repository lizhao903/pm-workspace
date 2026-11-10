// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PageTitle } from './topbar'
import { DataView, triggerLabel } from './sop'
import { NODE_GROUPS, NODE_TYPES, KindIcon, KindTag, claudeTimeout, defaultConfig, isBranching, loopRounds, missingFields, typeOf, type ConfigField, type FieldCtx } from './nodetypes'
import { IM_RELEVANCES, IM_REL_LABEL, SOPS, SOP_FOLDERS, STEP_KIND, UNCATEGORIZED, folderOf, depsOf, emptyIM, imFilterText, imSops, stepLook, isManualDecide, ranks, upstreamOf, type Sop, type SopField, type SopIM, type SopRun, type SopStepDef, type StepKind } from './sopflow'
import { SearchSelect } from './searchselect'
import { IM_CONVERSATIONS } from './data'
import { cls, timeAgo } from './ui'
import { useEnum } from './enumdata'
import { newId } from './ids'
import { RuleFields } from './schedule'
import { describeRule, emptyRule } from './scheduledata'
import { CondEditor, FieldsList, blankCond, condProblems, condText, legacyCond, stepFields } from './sopcond'

/** 新选「定时」时的默认规则：每天 09:00（TSK-0463） */
const defaultSched = () => ({ rule: { ...emptyRule(), freq: 'daily' as const, time: '09:00' }, enabled: true })

// 新建 / 编辑 SOP：编排画布。左边 AI 协助，中间画布（拖动节点、从节点右侧连线或点 + 加下一个节点），右边是选中节点的属性
// AI 的每次改动都先作为「提案」出现在对话里，看过再点应用；应用过的可以撤销
// 原型里的 AI 是本地规则：能从一段描述里拆出步骤、判断分支和并行，也能按指令加步骤、删步骤、改并行、检查流程


/* ---------- 检查 ---------- */

export interface Issue { level: 'error' | 'warn'; text: string; step?: number }

export function checkSop(sop: Sop): Issue[] {
  const out: Issue[] = []
  if (!sop.name.trim()) out.push({ level: 'error', text: '还没有名称' })
  if (!sop.steps.length) out.push({ level: 'error', text: '至少要有一个步骤' })
  sop.fields.forEach((f, i) => { if (!f.label.trim()) out.push({ level: 'error', text: `第 ${i + 1} 个输入字段没有名称` }) })
  const keys = sop.steps.map((s) => s.key)
  sop.steps.forEach((s, i) => {
    if (!s.name.trim()) out.push({ level: 'error', text: `步骤 ${i + 1} 没有名称`, step: i })
    missingFields(s.kind, s.config).forEach((f) => out.push({ level: 'error', text: `「${s.name}」还没填「${f.label}」`, step: i }))
    if (isBranching(s.kind)) {
      const cases = s.cases ?? []
      if (cases.length < 2) out.push({ level: 'error', text: `「${s.name}」至少要有两个分支`, step: i })
      cases.forEach((c) => {
        if (!c.label.trim()) out.push({ level: 'error', text: `「${s.name}」有分支没写名称`, step: i })
        else if (!sop.steps.some((x) => x.branch?.of === s.key && x.branch.case === c.key)) out.push({ level: 'warn', text: `「${s.name}」的「${c.label}」分支下没有步骤，选中它时流程会直接往下走`, step: i })
      })
    }
    if (s.kind === 'loopback') {
      // 条件回退（AUTO-02），同后端 checkLoopback：回退目标不是依赖，不算环，但必须是上游
      const t = s.config?.target?.trim()
      const j = sop.steps.findIndex((x) => x.key === t)
      if (!s.cond && !s.rule?.trim()) out.push({ level: 'error', text: `「${s.name}」还没填回退条件`, step: i })
      if (t && j === i) out.push({ level: 'error', text: `「${s.name}」不能退回到自己`, step: i })
      else if (t && (j < 0 || !upstreamOf(sop, i).includes(j))) out.push({ level: 'error', text: `「${s.name}」只能退回到上游的步骤`, step: i })
      if (loopRounds(s.config?.max_rounds) === null) out.push({ level: 'error', text: `「${s.name}」最多退回几轮要是 1 到 10 的整数`, step: i })
    }
    // 条件（TSK-0490，同后端 declIssues）：结构化条件查写法；旧规则是一句话的拦，旧写法的提示转换
    if (s.kind === 'decide' || s.kind === 'loopback') {
      const rule = s.rule?.trim() ?? ''
      if (s.cond) condProblems(s.cond).forEach((t) => out.push({ level: 'error', text: `「${s.name}」${t}`, step: i }))
      else if (rule && !legacyCond(rule)) out.push({ level: 'error', text: `「${s.name}」的条件「${rule}」是一句话，程序没法照着判断：改成结构化条件（字段 + 运算符 + 值），这句话可以写进说明`, step: i })
      else if (rule) out.push({ level: 'warn', text: `「${s.name}」的条件还是旧写法「${rule}」，执行仍按它判断；建议转成结构化条件`, step: i })
    }
    if (s.kind === 'claude_code' && claudeTimeout(s.config?.timeout) === null) out.push({ level: 'error', text: `「${s.name}」超时写法不对，要写成「30 分钟」「2 小时」这样，最多 24 小时`, step: i })
    if (s.branch && !sop.steps.some((x) => x.key === s.branch!.of && isBranching(x.kind))) out.push({ level: 'error', text: `「${s.name}」挂在一个不存在的判断上`, step: i })
    ;(s.after ?? []).forEach((k) => { if (!keys.includes(k)) out.push({ level: 'error', text: `「${s.name}」依赖的步骤已被删除`, step: i }) })
  })
  if (sop.steps.length && !sop.steps.some((s) => s.kind === 'review' || isManualDecide(s))) out.push({ level: 'warn', text: '整个流程没有人工检查点，执行时不会停下来让人看输出' })
  const starts = sop.steps.filter((s) => !(s.after ?? []).length).length
  if (starts > 1) out.push({ level: 'warn', text: `有 ${starts} 个起点，它们会在开始时同时执行` })
  return out
}

/* ---------- 草稿操作 ---------- */

/** 编辑器里依赖一律写明，不依赖「接在上一步后面」的默认规则，免得插入和删除时意外改连线 */
const explicit = (sop: Sop): Sop => ({ ...sop, steps: sop.steps.map((s, i) => ({ ...s, after: depsOf(sop, i) })) })

let keySeq = 0
const newKey = (sop: Sop) => {
  let k = ''
  do { keySeq += 1; k = `s${keySeq}` } while (sop.steps.some((s) => s.key === k))
  return k
}

function makeStep(sop: Sop, kind: StepKind, name: string, after: string[], extra: Partial<SopStepDef> = {}): SopStepDef {
  const key = newKey(sop)
  return {
    key, name, kind, desc: '', ms: typeOf(kind).ms, after, config: defaultConfig(kind),
    ...(isBranching(kind) ? { cases: typeOf(kind).defaultCases!.map((c) => ({ ...c })), ...(kind === 'decide' || kind === 'loopback' ? { rule: '' } : {}) } : {}),
    ...extra,
  }
}

/** 在第 at 步后面插一步：新步骤接在它后面，原来接它的步骤改接新步骤 */
function insertAfter(sop: Sop, at: number | null, step: Omit<SopStepDef, 'key'> & { key?: string }): Sop {
  const s = { ...step, key: step.key ?? newKey(sop) } as SopStepDef
  if (at === null || !sop.steps.length) return { ...sop, steps: [...sop.steps, { ...s, after: sop.steps.length ? [sop.steps[sop.steps.length - 1].key] : [] }] }
  const prev = sop.steps[at]
  const rewired = sop.steps.map((x) => (x.after?.includes(prev.key) && !(x.branch?.of === prev.key)
    ? { ...x, after: x.after.map((k) => (k === prev.key ? s.key : k)) } : x))
  const steps = [...rewired.slice(0, at + 1), { ...s, after: [prev.key] }, ...rewired.slice(at + 1)]
  return { ...sop, steps }
}

/** 删一步：接它的步骤改接它的上游，挂在它（判断）上的分支一并解开 */
function removeStep(sop: Sop, i: number): Sop {
  const gone = sop.steps[i]
  const up = gone.after ?? []
  return {
    ...sop,
    steps: sop.steps.filter((_, j) => j !== i).map((x) => {
      let after = x.after ?? []
      if (after.includes(gone.key)) after = [...new Set(after.flatMap((k) => (k === gone.key ? up : [k])))]
      const branch = x.branch?.of === gone.key ? undefined : x.branch
      return { ...x, after, branch }
    }),
  }
}

/* ---------- 本地「AI」 ---------- */

interface Reply { text: string; notes?: string[]; proposal?: Sop }

// 从描述里猜节点类型：先认外部动作和数据处理，最后才落到 AI / 自动
const KIND_WORDS: [StepKind, RegExp][] = [
  ['knowledge', /检索|查资料|知识库|查找相关/],
  ['extract', /提取|抽取|抽出/],
  ['http', /接口|HTTP|http|webhook|调用.*系统/],
  ['task', /建任务|创建任务|建一条任务|转任务/],
  ['notify', /通知|发到|发送|推送到|告知/],
  ['wait', /等待|等.*(小时|天|分钟)|延时/],
  ['subflow', /子流程|执行.*SOP/],
  ['review', /检查|确认|审核|审批|校对|复核|人工|核对/],
  ['ai', /AI|ai|生成|提炼|总结|起草|分析|识别|撰写|翻译|分类|摘要|改写/],
]
const guessKind = (t: string): StepKind => KIND_WORDS.find(([, re]) => re.test(t))?.[0] ?? 'auto'
const clean = (t: string) => t.replace(/^(先|再|并且|并|然后|接着|最后|之后|就|则|走|需要|要)+/, '').replace(/[。.!！]+$/, '').trim()
const short = (t: string) => (t.length > 18 ? `${t.slice(0, 18)}…` : t)

function summarize(sop: Sop): string[] {
  const n = (k: StepKind) => sop.steps.filter((s) => s.kind === k).length
  const forks = sop.steps.filter((s) => !isBranching(s.kind) && sop.steps.filter((x) => x.after?.includes(s.key) && !x.branch).length > 1).length
  return [
    `${sop.steps.length} 个步骤：${NODE_TYPES.filter((t) => n(t.kind)).map((t) => `${t.label} ${n(t.kind)}`).join('、')}`,
    ...sop.steps.filter((s) => isBranching(s.kind)).map((d) => `「${d.name}」分出 ${(d.cases ?? []).map((c) => `「${c.label}」`).join('')}`),
    ...(forks ? [`有 ${forks} 处并行分叉`] : []),
  ]
}

/** 从一段自然语言描述拆出流程：按标点和「然后」切句；「如果…否则…」成判断；「同时 / 并行」成并行，下一句汇合 */
function generate(text: string, base: Sop): Sop {
  const sop: Sop = { ...base, steps: [] }
  // 「报销审核流程：收到报销单，…」冒号前是流程名，不当步骤
  const head = /^([^，,。：:]{2,16})[：:](.+)$/s.exec(text.trim())
  if (head) { if (!sop.name.trim()) sop.name = head[1].trim(); text = head[2] }
  const tokens = text.split(/[，,。；;\n]|然后|接着|→|->/).map((t) => t.trim()).filter(Boolean)
  let tails: string[] = []
  let decide: { key: string; yes: string[]; no: string[] | null } | null = null
  let mode: 'main' | 'yes' | 'no' = 'main'
  const push = (kind: StepKind, raw: string, after: string[], extra: Partial<SopStepDef> = {}) => {
    const s = makeStep(sop, kind, short(clean(raw)) || '未命名步骤', after, { desc: raw, ...extra })
    sop.steps.push(s)
    return s.key
  }
  const joinDecide = () => {
    if (!decide) return
    const ends = [...(decide.yes.length ? decide.yes : [decide.key]), ...(decide.no ?? [decide.key])]
    tails = [...new Set(ends)]
    decide = null
    mode = 'main'
  }
  for (const tok of tokens) {
    const ifm = /^(?:如果|若|假如|要是)(.+?)(?:就|则|的话|，|$)(.*)$/.exec(tok)
    if (ifm) {
      joinDecide()
      const cond = ifm[1].replace(/(就|则)$/, '')
      const key = push('decide', `判断${cond}`, tails, { rule: cond, cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], desc: `如果${cond}` })
      decide = { key, yes: [], no: null }
      mode = 'yes'
      if (ifm[2].trim()) decide.yes = [push(guessKind(ifm[2]), ifm[2], [key], { branch: { of: key, case: 'yes' } })]
      continue
    }
    const elsem = /^(?:否则|不然|反之|不是的话)(.*)$/.exec(tok)
    if (elsem && decide) {
      mode = 'no'
      decide.no = elsem[1].trim() ? [push(guessKind(elsem[1]), elsem[1], [decide.key], { branch: { of: decide.key, case: 'no' } })] : []
      continue
    }
    if (decide && (mode === 'no' || /^(最后|之后|完成后|都|统一|最终)/.test(tok))) joinDecide()
    if (decide && mode === 'yes') {
      const prev = decide.yes.length ? decide.yes : [decide.key]
      const extra = decide.yes.length ? {} : { branch: { of: decide.key, case: 'yes' } }
      decide.yes = [push(guessKind(tok), tok, prev, extra)]
      continue
    }
    if (/同时|并行|一起/.test(tok)) {
      const parts = tok.replace(/同时|并行|一起|地/g, '|').split(/[|和、及]|以及/).map((x) => x.trim()).filter((x) => x.length > 1)
      if (parts.length > 1) { tails = parts.map((p) => push(guessKind(p), p, tails)); continue }
    }
    tails = [push(guessKind(tok), tok, tails)]
  }
  return sop
}

function respond(text: string, draft: Sop, selected: number | null): Reply {
  const t = text.trim()
  const has = draft.steps.length > 0
  const named = draft.steps.map((s, i) => [s, i] as const).filter(([s]) => s.name && t.includes(s.name))

  if (has && /^(帮我)?(检查|看看|校验)|有没有问题|哪里不对/.test(t)) {
    const issues = checkSop(draft)
    return issues.length
      ? { text: `看了一遍，有 ${issues.length} 处要注意：`, notes: issues.map((x) => `${x.level === 'error' ? '必须改' : '建议'}：${x.text}`) }
      : { text: '流程结构没问题：每个判断的分支都有步骤，有人工检查点，依赖也都连上了。', notes: summarize(draft) }
  }
  if (has && /删(除|掉)|去掉|不要/.test(t)) {
    if (!named.length) return { text: `没找到你说的步骤。说出步骤名，比如「删掉${draft.steps[0].name}」。` }
    let next = draft
    for (const [s] of named) next = removeStep(next, next.steps.findIndex((x) => x.key === s.key))
    return { text: `删掉 ${named.map(([s]) => `「${s.name}」`).join('')}，接在它后面的步骤改接它的上游。`, proposal: next }
  }
  if (has && /并行|同时/.test(t) && named.length >= 2) {
    const branched = named.filter(([s]) => s.branch)
    if (branched.length && new Set(named.map(([s]) => `${s.branch?.of}|${s.branch?.case}`)).size > 1) {
      return { text: `${named.map(([s]) => `「${s.name}」`).join('')}在判断的不同分支上，每次只会走其中一个，没法并行。要两个都做，先把它们从分支里拿出来（右边卡片「只在某个分支执行」选「不限」）。` }
    }
    const keys = named.map(([s]) => s.key)
    const first = named[0][0]
    const steps = draft.steps.map((s) => {
      if (keys.includes(s.key)) return { ...s, after: first.after ?? [] }
      if (s.after?.some((k) => keys.includes(k))) return { ...s, after: [...new Set([...s.after.filter((k) => !keys.includes(k)), ...keys])] }
      return s
    })
    return { text: `把 ${named.map(([s]) => `「${s.name}」`).join('')}改成并行：它们都接在「${first.after?.length ? draft.steps.find((x) => x.key === first.after![0])?.name : '开始'}」后面，下一步等它们都完成再汇合。`, proposal: { ...draft, steps } }
  }
  const addm = /^(?:在(.+?)(?:之后|后面))?[，,]?\s*(?:加|增加|添加|插入|再加)(?:一个|一步|个)?(.*)$/.exec(t)
  if (has && addm) {
    const anchor = addm[1] ? draft.steps.findIndex((s) => addm[1].includes(s.name) || s.name.includes(addm[1])) : -1
    const at = anchor >= 0 ? anchor : selected ?? draft.steps.length - 1
    const what = addm[2].trim() || '人工检查'
    const ifm = /判断|如果|分支/.test(what)
    const kind: StepKind = ifm ? 'decide' : guessKind(what)
    const name = short(clean(what.replace(/^(的|一个)/, ''))) || STEP_KIND[kind].label
    const step = makeStep(draft, kind, kind === 'review' && name === '人工检查' ? `检查${draft.steps[at].name}` : name, [], { desc: what })
    const next = insertAfter(draft, at, step)
    return {
      text: `在「${draft.steps[at].name}」后面加一步「${step.name}」（${STEP_KIND[kind].label}）。${kind === 'decide' ? '先给了「是 / 否」两个分支，分支下的步骤可以在右边挂上，也可以继续跟我说。' : ''}`,
      proposal: next,
    }
  }
  if (t.length < 6) return { text: '多说一点：描述这个流程从什么开始、每一步做什么、哪里要人看、哪里有分支。也可以让我「加一个人工检查」「检查一下流程」。' }
  const proposal = generate(t, draft)
  if (!proposal.name.trim()) {
    const m = /^(.{2,12}?)(流程|SOP|工作流)/.exec(t)
    proposal.name = m ? `${m[1]}${m[2] === 'SOP' ? '' : m[2]}` : ''
  }
  if (!proposal.steps.length) return { text: '没能从这段话里拆出步骤，换个说法试试，比如「收到报销单，AI 识别发票，如果金额大于 5000 就经理审批，否则直接通过，最后通知申请人」。' }
  return {
    text: has ? `按你的描述重新生成了流程，应用后会替换现在的 ${draft.steps.length} 个步骤：` : '按你的描述拆出了这些步骤：',
    notes: [...summarize(proposal), ...(proposal.steps.some((s) => s.kind === 'review' || isManualDecide(s)) ? [] : ['没有人工检查点，可以让我「加一个人工检查」'])],
    proposal,
  }
}

/* ---------- 界面 ---------- */

interface Msg { id: number; role: 'user' | 'ai'; text: string; notes?: string[]; proposal?: Sop; state?: 'new' | 'applied' | 'undone' }

const EXAMPLES = [
  '报销审核流程：收到报销单，AI 识别发票金额，如果金额大于 5000 就经理审批，否则财务直接复核，最后打款并通知申请人',
  '竞品周报：同时抓取三家竞品官网更新和应用商店评论，AI 总结变化，人工校对，然后发到产品群',
  '客户投诉处理：AI 分类投诉，如果是紧急问题就电话回访，否则工单跟进，最后人工确认已解决',
]

function AiPanel({ hidden, draft, selected, onApply, onUndo, canUndo, onClose }: {
  hidden: boolean
  draft: Sop
  selected: number | null
  onApply: (s: Sop) => void
  onUndo: () => void
  canUndo: boolean
  onClose: () => void
}) {
  const [msgs, setMsgs] = useState<Msg[]>([{
    id: 0, role: 'ai',
    text: draft.steps.length
      ? `正在编辑「${draft.name}」。可以让我加步骤、删步骤、把几步改成并行，或者检查一下流程。`
      : '用一段话描述这个流程：从什么开始、每一步做什么、哪里要人看、哪里有分支或可以同时做。我先拆成步骤给你看，你确认后再放到画布上。',
  }])
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(1)

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, thinking])

  const send = (t = text) => {
    if (!t.trim() || thinking) return
    setMsgs((m) => [...m, { id: seq.current++, role: 'user', text: t.trim() }])
    setText('')
    setThinking(true)
    window.setTimeout(() => {
      const r = respond(t, draft, selected)
      setMsgs((m) => [...m, { id: seq.current++, role: 'ai', ...r, state: r.proposal ? 'new' : undefined }])
      setThinking(false)
    }, 700)
  }
  const mark = (id: number, state: Msg['state']) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, state } : x)))
  const lastApplied = [...msgs].reverse().find((m) => m.state === 'applied')?.id

  const chips = draft.steps.length
    ? ['检查一下流程', `在${draft.steps[selected ?? draft.steps.length - 1].name}之后加一个人工检查`, '加一个判断分支']
    : []

  return (
    <aside className="ai-panel" hidden={hidden}>
      <div className="ai-head">
        <span className="ai-mark">AI</span>
        <span className="ai-title">AI 协助</span>
        <span className="spacer" />
        <button className="icon-btn ai-close" onClick={onClose} title="收起">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="ai-msgs" ref={listRef}>
        {msgs.map((m) => (
          <div key={m.id} className={cls('ai-msg', `ai-${m.role}`)}>
            <div className="ai-bubble">
              <div>{m.text}</div>
              {m.notes && <ul className="ai-notes">{m.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              {m.proposal && (
                <div className={cls('ai-proposal', m.state === 'undone' && 'undone')}>
                  <ol className="ai-steps">
                    {m.proposal.steps.map((s) => {
                      const of = s.branch && m.proposal!.steps.find((x) => x.key === s.branch!.of)
                      const par = (s.after?.length ?? 0) > 1
                      return (
                        <li key={s.key}>
                          <span className="ellipsis">{s.name}</span>
                          <KindTag kind={s.kind} />
                          {of && <span className="ai-step-note">{of.cases?.find((c) => c.key === s.branch!.case)?.label} 分支</span>}
                          {par && <span className="ai-step-note">汇合</span>}
                        </li>
                      )
                    })}
                  </ol>
                  <div className="act-row">
                    {m.state === 'new' && <>
                      <button className="act act-primary" onClick={() => { onApply(m.proposal!); mark(m.id, 'applied') }}>应用到流程</button>
                      <button className="act act-quiet" onClick={() => mark(m.id, 'undone')}>不用了</button>
                    </>}
                    {m.state === 'applied' && <>
                      <span className="ai-state">已应用</span>
                      {m.id === lastApplied && canUndo && <button className="act act-quiet" onClick={() => { onUndo(); mark(m.id, 'undone') }}>撤销</button>}
                    </>}
                    {m.state === 'undone' && <span className="ai-state">未采用</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {thinking && <div className="ai-msg ai-ai"><div className="ai-bubble ai-typing"><span /><span /><span /></div></div>}
        {msgs.length === 1 && !draft.steps.length && (
          <div className="ai-examples">
            <div className="ai-examples-title">试试这些描述</div>
            {EXAMPLES.map((e) => <button key={e} className="ai-example" onClick={() => send(e)}>{e}</button>)}
          </div>
        )}
      </div>
      <div className="ai-input">
        {chips.length > 0 && (
          <div className="ai-chips">{chips.map((c) => <button key={c} className="fchip" onClick={() => send(c)}>{c}</button>)}</div>
        )}
        <div className="ai-box">
          <textarea rows={3} value={text} placeholder={draft.steps.length ? '比如：把 A 和 B 改成并行 / 删掉 C / 在 D 之后加一个人工检查' : '描述这个流程…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
          <div className="ai-box-foot">
            <span className="field-hint-line">⌘Enter 发送；AI 的改动要你点「应用」才生效</span>
            <button className="act act-primary" disabled={!text.trim() || thinking} onClick={() => send()}>发送</button>
          </div>
        </div>
      </div>
    </aside>
  )
}

/* ---------- 画布：节点种类 ---------- */

const START = '__start'
const NW = 232

type PaletteItem = { id: string; kind: StepKind; manual?: boolean; label: string; desc: string; group: string }
// 节点表里每种类型一项；条件分支另拆出一个「人工判断」放在人工组，两者是同一种节点，只差有没有规则
const PALETTE: PaletteItem[] = [
  ...NODE_TYPES.map((t) => ({ id: t.kind, kind: t.kind, label: t.label, desc: t.desc, group: t.group })),
  { id: 'manual', kind: 'decide', manual: true, label: '人工判断', desc: '由人选这次走哪个分支', group: '人工' },
]

const nodeH = (sop: Sop, key: string) => {
  if (key === START) return 50 + Math.max(1, sop.fields.length) * 26
  const s = sop.steps.find((x) => x.key === key)
  return s && isBranching(s.kind) ? 50 + (s.cases?.length ?? 2) * 30 : 82
}
const caseY = (i: number) => 52 + i * 30 + 13

/** 没摆过位置的节点按依赖分列排开；开始节点在最左 */
function autoLayout(sop: Sop): Record<string, { x: number; y: number }> {
  const rk = ranks(sop)
  const cols: string[][] = []
  sop.steps.forEach((s, i) => { (cols[rk[i]] ??= []).push(s.key) })
  const out: Record<string, { x: number; y: number }> = { [START]: { x: 60, y: 0 } }
  const heights = cols.map((c) => c.reduce((a, k) => a + nodeH(sop, k) + 28, -28))
  const tallest = Math.max(nodeH(sop, START), ...heights)
  out[START].y = 80 + (tallest - nodeH(sop, START)) / 2
  cols.forEach((col, c) => {
    let y = 80 + (tallest - heights[c]) / 2
    col.forEach((k) => { out[k] = { x: 60 + (c + 1) * (NW + 84), y }; y += nodeH(sop, k) + 28 })
  })
  return out
}

/** 改完连线后按依赖重新排步骤顺序（稳定），引擎和「上游只能选前面的」都靠这个顺序 */
function topo(sop: Sop): Sop {
  const done = new Set<string>()
  const out: SopStepDef[] = []
  let rest = [...sop.steps]
  while (rest.length) {
    const ready = rest.filter((s) => (s.after ?? []).every((k) => done.has(k) || !sop.steps.some((x) => x.key === k)))
    const pick = ready.length ? ready : [rest[0]]
    for (const s of pick) { out.push(s); done.add(s.key) }
    rest = rest.filter((s) => !done.has(s.key))
  }
  return { ...sop, steps: out }
}

const ancestors = (sop: Sop, key: string, seen = new Set<string>()): Set<string> => {
  for (const k of sop.steps.find((s) => s.key === key)?.after ?? []) if (!seen.has(k)) { seen.add(k); ancestors(sop, k, seen) }
  return seen
}

/* ---------- 节点选择器 ---------- */

function Palette({ at, onPick, onClose }: { at: { x: number; y: number }; onPick: (p: PaletteItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc, true) }
  }, [onClose])
  const items = PALETTE.filter((p) => !q.trim() || `${p.label}${p.desc}`.includes(q.trim()))
  const groups = NODE_GROUPS.filter((g) => items.some((p) => p.group === g))
  // 贴着屏幕边缘时往里收
  const left = Math.min(at.x, window.innerWidth - 300)
  const top = Math.min(at.y, window.innerHeight - 380)
  return (
    <div ref={ref} className="palette" style={{ left: Math.max(8, left), top: Math.max(8, top) }}>
      <div className="search search-full search-sm">
        <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        <input autoFocus placeholder="搜索节点" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && items[0]) onPick(items[0]) }} />
      </div>
      <div className="palette-list">
        {groups.map((g) => (
          <div key={g}>
            <div className="palette-group">{g}</div>
            {items.filter((p) => p.group === g).map((p) => (
              <button key={p.id} className="palette-item" onClick={() => onPick(p)}>
                {p.manual ? <span className="kind-icon" style={{ width: 22, height: 22, background: '#b0570b' }}><svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 3v3.5a2 2 0 0 0 2 2h4M10 8.5 12.5 6M10 8.5 12.5 11M4 6.5V13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span> : <KindIcon kind={p.kind} size={22} />}
                <span className="palette-text"><span>{p.label}</span><span className="palette-desc">{p.desc}</span></span>
              </button>
            ))}
          </div>
        ))}
        {!items.length && <div className="io-empty">没有匹配的节点</div>}
      </div>
      <div className="palette-tip">从同一个节点连出多条线就是并行；一个节点连进多条线就是汇合</div>
    </div>
  )
}

/* ---------- 右侧属性面板 ---------- */

/** 节点配置项：按字段类型渲染，值统一存成字符串 */
function ConfigInput({ field, value, cfg, ctx, bad, onChange }: { field: ConfigField; value: string; cfg: Record<string, string>; ctx: FieldCtx; bad?: boolean; onChange: (v: string) => void }) {
  const label = <span className="field-label">{field.label}{field.required && <em>*</em>}{field.hint && <span className="field-hint">{field.hint}</span>}</span>
  if (field.type === 'multi') {
    const on = value.split(',').filter(Boolean)
    return (
      <div className="field">
        {label}
        <div className="dep-list">
          {field.options!(ctx, cfg).map((o) => (
            <label key={o.value} className={cls('dep-chip', on.includes(o.value) && 'on')}>
              <input type="checkbox" checked={on.includes(o.value)} onChange={() => onChange((on.includes(o.value) ? on.filter((x) => x !== o.value) : [...on, o.value]).join(','))} />{o.label}
            </label>
          ))}
        </div>
      </div>
    )
  }
  return (
    <label className="field">
      {label}
      {field.type === 'select' ? (
        <select value={value} className={cls(bad && 'bad')} onChange={(e) => onChange(e.target.value)}>
          {!field.options!(ctx, cfg).some((o) => o.value === '') && <option value="">请选择</option>}
          {field.options!(ctx, cfg).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : field.type === 'textarea' || field.type === 'code' ? (
        <textarea rows={field.type === 'code' ? 5 : 3} className={cls(field.type === 'code' && 'code-input', bad && 'bad')} spellCheck={field.type !== 'code'} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type={field.type === 'number' ? 'number' : 'text'} className={cls(bad && 'bad')} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {bad && <span className="field-err">必填</span>}
    </label>
  )
}

function NodePanel({ draft, nodeKey, runs, sopList, tried, onChange, onPatchSop, onRemove, onRemoveEdge, onSelect, onAddNext, onClose }: {
  sopList: { id: string; name: string }[]
  tried: boolean
  draft: Sop
  nodeKey: string
  runs: SopRun[]
  onChange: (p: Partial<SopStepDef>) => void
  onPatchSop: (p: Partial<Sop>) => void
  onRemove: () => void
  onRemoveEdge: (from: string, to: string) => void
  onSelect: (k: string) => void
  onAddNext: (at: { x: number; y: number }, from: string, caseKey?: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'set' | 'last'>('set')
  // 最近编辑的文字配置项：「这一步能拿到的字段」点了往它末尾追加 {{路径}}（TSK-0490）
  const [lastCfg, setLastCfg] = useState<string | null>(null)
  useEffect(() => { setTab('set'); setLastCfg(null) }, [nodeKey])
  const s = draft.steps.find((x) => x.key === nodeKey)
  const kids = draft.steps.filter((x) => (nodeKey === START ? !(x.after ?? []).length : x.after?.includes(nodeKey)))
  const addBtn = (caseKey?: string) => (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onAddNext({ x: r.left - 300, y: r.top }, nodeKey, caseKey) }
  const fieldPatch = (i: number, p: Partial<SopField>) => onPatchSop({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) })
  // 触发方式读 sop_trigger 枚举，存 key；停用的不再出现，当前用着的照常显示
  const triggers = useEnum('sop_trigger')
  const triggerOpts = triggers.filter((t) => t.enabled || t.key === draft.trigger)
  const optKey = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

  const last = useMemo(() => {
    const r = runs.filter((x) => x.sop_id === draft.id).sort((a, b) => b.started_at - a.started_at)
      .find((x) => x.steps.some((st) => st.key === nodeKey && st.status !== 'pending'))
    return r ? { run: r, step: r.steps.find((st) => st.key === nodeKey)! } : null
  }, [runs, draft.id, nodeKey])

  const head = (kind: StepKind | 'start', title: ReactNode, actions?: ReactNode) => (
    <div className="np-head">
      <KindIcon kind={kind} size={26} />
      <div className="np-title">{title}</div>
      {actions}
      <button className="icon-btn" onClick={onClose} title="关闭">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  )

  if (nodeKey === START) {
    return (
      <aside className="node-panel">
        {head('start', <span className="np-name-static">开始</span>)}
        <div className="np-body form">
          <div className="list-sub">执行时要填的内容，第一批节点拿它当输入。</div>
          {/* 文件夹（TSK-0482，SPEC-sop-9.32）：流程库里按它分类，保存时一起存；文件夹在流程库里建 */}
          <div className="field">
            <span className="field-label">文件夹</span>
            <SearchSelect variant="field" value={folderOf(draft) ?? ''} noneLabel={UNCATEGORIZED} placeholder={UNCATEGORIZED} searchPlaceholder="搜文件夹"
              aria-label="文件夹" emptyText="还没有文件夹，在流程库里新建" options={SOP_FOLDERS.map((f) => ({ value: f.id, label: f.name }))}
              onChange={(v) => onPatchSop({ folder_id: v || null })} />
          </div>
          <label className="field">
            <span className="field-label">触发方式</span>
            <select value={draft.trigger} onChange={(e) => onPatchSop(e.target.value === 'schedule' && !draft.sched ? { trigger: e.target.value, sched: defaultSched() } : e.target.value === 'im' && !draft.im ? { trigger: e.target.value, im: emptyIM() } : { trigger: e.target.value })}>
              {!triggerOpts.some((t) => t.key === draft.trigger) && <option value={draft.trigger}>{draft.trigger}</option>}
              {triggerOpts.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          {/* 定时（TSK-0463）：规则在这里配，接下来 5 次；保存时写进随流程管理的定时任务，定时任务页看到、改到的是同一条 */}
          {draft.trigger === 'schedule' && (draft.sched ? (
            <div className="sop-start-sched">
              <RuleFields compact count={5} rule={draft.sched.rule} onChange={(rule) => onPatchSop({ sched: { ...draft.sched!, rule } })} />
              <label className="switch-row">
                <span><span className="field-label">到点自动执行</span><span className="switch-hint">{draft.sched.enabled ? '保存后按规则自动执行' : '已停用：保存后不会自动执行'}</span></span>
                <span className="switch-line"><input type="checkbox" checked={draft.sched.enabled} onChange={(e) => onPatchSop({ sched: { ...draft.sched!, enabled: e.target.checked } })} /><span className="switch" /></span>
              </label>
              {draft.fields.some((f) => f.required && !(f.default ?? '').trim()) && (
                <div className="sop-start-sched-warn">定时执行时不填输入：{draft.fields.filter((f) => f.required && !(f.default ?? '').trim()).map((f) => `「${f.label || f.key}」`).join('、')}是必填又没有默认值，到点会执行失败。给它们填默认值，或改成不必填</div>
              )}
              <span className="field-hint-line">保存后在「任务 / 定时任务」里也能看到这一条，两边改的是同一条</span>
            </div>
          ) : (
            <div className="sop-start-sched unset">
              <span>定时，未配置：随流程管理的定时任务不在了（可能在定时任务页删掉了），到点不会执行。</span>
              <button className="act" onClick={() => onPatchSop({ sched: defaultSched() })}>设定时间</button>
            </div>
          ))}
          {/* IM 消息（TSK-0481）：只接哪些会话、与我的关系、第几个判断、命中后拦截后面的 IM 流程 */}
          {draft.trigger === 'im' && <StartIM sop={draft} onChange={(im) => onPatchSop({ im })} />}
          <div className="field">
            <span className="field-label">输入字段</span>
            <div className="field-list">
              {draft.fields.map((f, i) => (
                <div key={f.key} className="field-item">
                <div className="field-line">
                  <input value={f.label} placeholder="字段名称" onChange={(e) => fieldPatch(i, { label: e.target.value })} />
                  <select value={f.type} onChange={(e) => {
                    const type = e.target.value as SopField['type']
                    fieldPatch(i, type === 'select' && !f.options?.length ? { type, options: [{ value: optKey(), label: '' }] } : { type })
                  }}>
                    <option value="text">单行</option>
                    <option value="textarea">多行</option>
                    <option value="select">下拉</option>
                  </select>
                  <label className="check"><input type="checkbox" checked={!!f.required} onChange={(e) => fieldPatch(i, { required: e.target.checked })} />必填</label>
                  <button className="icon-btn icon-btn-sm" disabled={draft.fields.length < 2} title="删除" onClick={() => onPatchSop({ fields: draft.fields.filter((_, j) => j !== i) })}>
                    <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  </button>
                </div>
                {/* 下拉字段：逐项编辑选项，选项的值建好就不变，改的只是显示名 */}
                {f.type === 'select' && (
                  <div className="field-opts">
                    {(f.options ?? []).map((o, k) => (
                      <div key={o.value} className="field-opt">
                        <input value={o.label} placeholder={`选项 ${k + 1}`} onChange={(e) => fieldPatch(i, { options: f.options!.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} />
                        <button className="icon-btn icon-btn-sm" disabled={(f.options?.length ?? 0) < 2} title="删除这个选项"
                          onClick={() => fieldPatch(i, { options: f.options!.filter((_, j) => j !== k), ...(f.default === o.value ? { default: '' } : {}) })}>
                          <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        </button>
                      </div>
                    ))}
                    <button className="act act-quiet case-add" onClick={() => fieldPatch(i, { options: [...(f.options ?? []), { value: optKey(), label: '' }] })}>加一个选项</button>
                  </div>
                )}
                </div>
              ))}
              <button className="act act-quiet case-add" onClick={() => onPatchSop({ fields: [...draft.fields, { key: `f${Date.now().toString(36)}`, label: '', type: 'text' }] })}>加一个字段</button>
            </div>
          </div>
          <NextList kids={kids} onSelect={onSelect} onAdd={addBtn()} />
        </div>
      </aside>
    )
  }
  if (!s) return null
  const ups = (s.after ?? []).map((k) => draft.steps.find((x) => x.key === k)).filter(Boolean) as SopStepDef[]
  const sIndex = draft.steps.findIndex((x) => x.key === s.key)
  const ancestors = upstreamOf(draft, sIndex).map((j) => ({ key: draft.steps[j].key, name: draft.steps[j].name }))

  return (
    <aside className="node-panel">
      {head(s.kind, <input className="np-name" value={s.name} placeholder="节点名称" onChange={(e) => onChange({ name: e.target.value })} />,
        <button className="icon-btn btn-danger-ghost" onClick={onRemove} title="删除节点 (Delete)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>)}
      <div className="np-tabs">
        <button className={cls(tab === 'set' && 'on')} onClick={() => setTab('set')}>设置</button>
        <button className={cls(tab === 'last' && 'on')} onClick={() => setTab('last')}>上次运行</button>
      </div>
      {tab === 'set' ? (
        <div className="np-body form">
          <label className="field">
            <span className="field-label">类型<span className="field-hint">{typeOf(s.kind).desc}</span></span>
            <select value={s.kind} onChange={(e) => {
              const k = e.target.value as StepKind
              // 换类型：保留名字和说明，配置换成新类型的默认值；变成分支节点时补上默认分支
              // 条件回退的两个出口 key 固定（pass / over），换成它或从它换走时一律用默认出口
              onChange({ kind: k, ms: typeOf(k).ms, config: { ...defaultConfig(k) }, ...(isBranching(k) ? { cases: s.cases?.length && k !== 'loopback' && s.kind !== 'loopback' ? s.cases : typeOf(k).defaultCases!.map((c) => ({ ...c })) } : { cases: undefined, rule: undefined }) })
            }}>
              {NODE_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {NODE_TYPES.filter((t) => t.group === g).map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {(typeOf(s.kind).fields ?? []).filter((f) => !f.hidden?.(s.config ?? {})).map((f) => (
            <div key={f.key} onFocus={() => setLastCfg(f.key)}>
              <ConfigInput field={f} value={s.config?.[f.key] ?? ''} cfg={s.config ?? {}} ctx={{ sops: sopList, ups: ancestors }} bad={tried && f.required && !s.config?.[f.key]?.trim()}
                onChange={(v) => onChange({ config: { ...(s.config ?? {}), ...Object.fromEntries((f.clears ?? []).map((k) => [k, ''])), [f.key]: v } })} />
            </div>
          ))}
          <label className="field">
            <span className="field-label">{typeOf(s.kind).descLabel ?? '说明'}</span>
            <textarea rows={s.kind === 'ai' ? 6 : 2} value={s.desc}
              placeholder={{ auto: '比如：调用飞书接口发到项目群', ai: '比如：按客户的语气起草一条回复，告知已记录和大致排期。可以引用上游输出的字段', review: '比如：核对待办的负责人和截止时间' }[s.kind as string] ?? '给看流程的人一句话说明'}
              onChange={(e) => onChange({ desc: e.target.value })} />
          </label>
          {isBranching(s.kind) && (
            <>
              {(s.kind === 'decide' || s.kind === 'loopback') && (
                <CondEditor step={s} loop={s.kind === 'loopback'} tried={tried} onChange={onChange}
                  groups={stepFields(draft, draft.steps.indexOf(s), (i) => upstreamOf(draft, i))} />
              )}
              <div className="field">
                <span className="field-label">{s.kind === 'classifier' ? '类别' : s.kind === 'loopback' ? '出口' : '分支'}<span className="field-hint">{s.kind === 'classifier' ? '每一类一个出口；类别名写清楚，分类更准' : s.kind === 'loopback' ? '条件不成立走「通过」；退回轮次用完还成立走「超限」，没接步骤时这一步失败' : ''}</span></span>
                <div className="case-list">
                  {(s.cases ?? []).map((c) => (
                    <div key={c.key} className="case-row">
                      <input value={c.label} onChange={(e) => onChange({ cases: s.cases!.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)) })} />
                      <span className="case-count">{draft.steps.filter((x) => x.branch?.of === s.key && x.branch.case === c.key).length} 个节点</span>
                      <button className="act act-quiet" onClick={addBtn(c.key)}>加节点</button>
                      {(s.cases ?? []).length > 2 && s.kind !== 'loopback' && <button className="act act-quiet" onClick={() => onChange({ cases: s.cases!.filter((x) => x.key !== c.key) })}>删除</button>}
                    </div>
                  ))}
                  {s.kind !== 'loopback' && <button className="act act-quiet case-add" onClick={() => onChange({ cases: [...(s.cases ?? []), { key: `c${Date.now().toString(36)}`, label: `分支 ${(s.cases?.length ?? 0) + 1}` }] })}>加一个分支</button>}
                </div>
              </div>
            </>
          )}
          <FieldsList groups={stepFields(draft, draft.steps.indexOf(s), (i) => upstreamOf(draft, i))}
            onPick={(p) => {
              const k = lastCfg && (typeOf(s.kind).fields ?? []).some((f) => f.key === lastCfg) ? lastCfg : null
              if (k) onChange({ config: { ...(s.config ?? {}), [k]: `${s.config?.[k] ?? ''}{{${p}}}` } })
              else void navigator.clipboard?.writeText(`{{${p}}}`)
            }} />
          <div className="field">
            <span className="field-label">上游<span className="field-hint">{ups.length > 1 ? '汇合：等这几个都完成才开始' : '从画布上拖线可以再连一个上游'}</span></span>
            <div className="np-links">
              {ups.length ? ups.map((u) => (
                <span key={u.key} className="np-link">
                  <button onClick={() => onSelect(u.key)}><KindIcon kind={u.kind} size={16} />{u.name}{s.branch?.of === u.key && ` · ${u.cases?.find((c) => c.key === s.branch!.case)?.label}`}</button>
                  <button className="np-link-x" title="断开" onClick={() => onRemoveEdge(u.key, s.key)}>
                    <svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                  </button>
                </span>
              )) : <span className="np-link"><button onClick={() => onSelect(START)}><KindIcon kind="start" size={16} />开始</button></span>}
            </div>
          </div>
          {!isBranching(s.kind) && <NextList kids={kids} onSelect={onSelect} onAdd={addBtn()} />}
        </div>
      ) : (
        <div className="np-body">
          {last ? (
            <div className="np-last">
              <div className="np-last-head">
                <span className="pill" style={{ '--c': stepLook(last.step).color } as React.CSSProperties}><span className="pill-dot" />{stepLook(last.step).label}</span>
                <span className="list-sub">{last.run.title} · {timeAgo(new Date(last.run.started_at).toISOString())}</span>
              </div>
              {last.step.route && <div className="insp-route">走「{s.cases?.find((c) => c.key === last.step.route)?.label ?? last.step.route}」分支</div>}
              <div className="section-label">输入</div>
              <div className="insp-body">{last.step.input ? <DataView data={last.step.input} /> : <div className="io-empty">没有输入</div>}</div>
              <div className="section-label">输出</div>
              <div className="insp-body">{last.step.output ? <DataView data={last.step.output} /> : <div className="io-empty">{last.step.error ?? '没有输出'}</div>}</div>
            </div>
          ) : <div className="io-empty">这个节点还没运行过。点右上角「测试运行」跑一次，这里会留下它的输入和输出。</div>}
        </div>
      )}
    </aside>
  )
}

function NextList({ kids, onSelect, onAdd }: { kids: SopStepDef[]; onSelect: (k: string) => void; onAdd: (e: React.MouseEvent) => void }) {
  return (
    <div className="field">
      <span className="field-label">下一步<span className="field-hint">{kids.length > 1 ? `并行 ${kids.length} 路` : '添加此节点之后要做的事'}</span></span>
      <div className="np-links">
        {kids.map((k) => <span key={k.key} className="np-link"><button onClick={() => onSelect(k.key)}><KindIcon kind={k.kind} size={16} />{k.name}</button></span>)}
        <button className="np-add" onClick={onAdd}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          选择下一个节点
        </button>
      </div>
    </div>
  )
}

/**
 * 开始节点的「IM 消息」（TSK-0481，SPEC-sop-9.27 到 9.31）。会话多选，名字和渠道里的编号都能搜（Slack 的 C0…）；
 * 与我的关系「只要 / 除了」加四种勾选，都不勾是不限；顺序下拉写明在谁之前、之后；拦截开关。不符合条件的消息不发起、不留记录
 */
const CONV_OPTIONS = [
  ...(IM_CONVERSATIONS.cn_slack ?? []).filter((c) => c.kind !== 'mpim').map((c) => ({ value: `#${c.name}`, label: `#${c.name}`, hint: `slack · ${c.id}` })),
  { value: '远川试点项目群', label: '远川试点项目群', hint: 'lark · oc_7f3a9c21' },
]
function StartIM({ sop, onChange }: { sop: Sop; onChange: (im: SopIM) => void }) {
  const im = sop.im ?? emptyIM()
  const others = imSops(SOPS).filter((s) => s.id !== sop.id)
  const saved = SOPS.find((s) => s.id === sop.id)
  const cur = im.order || (saved?.trigger === 'im' ? saved.im?.order : 0) || others.length + 1
  const patch = (p: Partial<SopIM>) => onChange({ ...im, ...p })
  const blockers = others.slice(0, cur - 1).filter((s) => s.im?.stop)
  return (
    <div className="sop-start-sched">
      <div className="field">
        <span className="field-label">只接这些会话</span>
        <SearchSelect multiple value={im.conversations} placeholder="全部会话" searchPlaceholder="搜群名或会话编号（如 C0…）" options={CONV_OPTIONS}
          onChange={(v) => patch({ conversations: v })} />
      </div>
      <div className="field">
        <span className="field-label">与我的关系</span>
        <div className="sop-start-im-rel">
          <select value={im.relevance_mode} onChange={(e) => patch({ relevance_mode: e.target.value === 'exclude' ? 'exclude' : 'include' })}>
            <option value="include">只要</option>
            <option value="exclude">除了</option>
          </select>
          {IM_RELEVANCES.map((r) => (
            <label key={r} className="check"><input type="checkbox" checked={im.relevance.includes(r)}
              onChange={(e) => patch({ relevance: IM_RELEVANCES.filter((x) => (x === r ? e.target.checked : im.relevance.includes(x))) })} />{IM_REL_LABEL[r]}</label>
          ))}
        </div>
        <span className="field-hint-line">{im.relevance.length ? '' : '都不勾是不限。'}不符合会话和关系的消息不会发起这个流程，也不留执行记录</span>
      </div>
      <label className="field">
        <span className="field-label">执行顺序</span>
        <select value={cur} onChange={(e) => patch({ order: Number(e.target.value) })}>
          {Array.from({ length: others.length + 1 }, (_, k) => k + 1).map((n) => (
            <option key={n} value={n}>{n === 1 ? (others.length ? `第 1 个（在「${others[0].name}」之前）` : '第 1 个（目前只有它）') : `第 ${n} 个（在「${others[n - 2].name}」之后）`}</option>
          ))}
        </select>
        <span className="field-hint-line">来一条消息时，IM 流程按这个顺序逐个判断、发起</span>
      </label>
      <label className="switch-row">
        <span><span className="field-label">命中后不再触发后面的 IM 流程</span><span className="switch-hint">{im.stop ? '这条流程接住（条件符合并发起了）的消息，排在后面的 IM 流程不再处理；不影响 IM 插件自己的处理和 Agent 的 IM 触发' : '不拦截：后面的 IM 流程照常判断'}</span></span>
        <span className="switch-line"><input type="checkbox" checked={im.stop} onChange={(e) => patch({ stop: e.target.checked })} /><span className="switch" /></span>
      </label>
      {blockers.length > 0 && <div className="sop-start-sched-warn">排在前面的{blockers.map((s) => `「${s.name}」`).join('、')}会拦截：它们接住的消息不会再到这个流程</div>}
    </div>
  )
}

/* ---------- 编辑器 ---------- */

/** folderId：在流程库的某个文件夹里点的新建，新流程默认放进去（TSK-0482） */
export function newSopDraft(folderId: string | null = null): Sop {
  return {
    id: newId('sop'), name: '', desc: '', trigger: 'manual', folder_id: folderId,
    fields: [{ key: 'input', label: '输入内容', type: 'textarea', required: true, default: '' }],
    steps: [],
  }
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'node'; key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; before: Sop }
  | { kind: 'link'; from: string; caseKey?: string; sx: number; sy: number; at: { x: number; y: number } }

export function SopEditor({ initial, creating, runs, sopList, hasSchedule = false, onCancel, onSave }: {
  initial: Sop
  creating: boolean
  runs: SopRun[]
  /** 子流程节点可选的 SOP */
  sopList: { id: string; name: string }[]
  /** 这个流程现在有随它管理的定时任务（TSK-0463）：改成别的触发方式保存前先问停用还是删掉 */
  hasSchedule?: boolean
  onCancel: () => void
  /** off：从定时改成别的触发方式时，那条定时任务停用还是删掉 */
  onSave: (sop: Sop, thenRun: boolean, off?: 'disable' | 'delete') => void
}) {
  const [offAsk, setOffAsk] = useState<{ thenRun: boolean } | null>(null)
  const [offChoice, setOffChoice] = useState<'disable' | 'delete'>('disable')
  const [schedSaved, setSchedSaved] = useState(hasSchedule)
  const [draft, setDraft] = useState<Sop>(() => explicit(initial))
  const [past, setPast] = useState<Sop[]>([])
  const [future, setFuture] = useState<Sop[]>([])
  const [savedJson, setSavedJson] = useState(() => (creating ? '' : JSON.stringify(explicit(initial))))
  const [sel, setSel] = useState<string | null>(null)
  const [selEdge, setSelEdge] = useState<{ from: string; to: string } | null>(null)
  const [aiOpen, setAiOpen] = useState(() => window.matchMedia('(min-width: 1101px)').matches)
  const [palette, setPalette] = useState<{ at: { x: number; y: number }; from: string; caseKey?: string } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [link, setLink] = useState<{ x: number; y: number } | null>(null)
  const [showIssues, setShowIssues] = useState(false)
  const [tried, setTried] = useState(false)
  const [toast, setToast] = useState('')
  const canvasRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const issues = checkSop(draft)
  const errors = issues.filter((x) => x.level === 'error')
  const dirty = JSON.stringify(draft) !== savedJson
  const lay = useMemo(() => ({ ...autoLayout(draft), ...(draft.layout ?? {}) }), [draft])
  const triggers = useEnum('sop_trigger')

  const commit = useCallback((next: Sop) => { setPast((p) => [...p.slice(-49), draft]); setFuture([]); setDraft(next) }, [draft])
  const undo = () => { const prev = past[past.length - 1]; if (!prev) return; setFuture((f) => [draft, ...f]); setPast((p) => p.slice(0, -1)); setDraft(prev) }
  // AI 提案的撤销只撤这次提案：记下应用后的草稿，之后有别的改动就不再给「撤销」
  const [aiMark, setAiMark] = useState<Sop | null>(null)
  // 流程名连续输入只记一步撤销
  const nameEdit = useRef<Sop | null>(null)
  const rename = (name: string) => { const next = { ...draft, name }; if (nameEdit.current === draft) setDraft(next); else commit(next); nameEdit.current = next }
  const redo = () => { const nx = future[0]; if (!nx) return; setPast((p) => [...p, draft]); setFuture((f) => f.slice(1)); setDraft(nx) }
  const say = (t: string) => { setToast(t); window.setTimeout(() => setToast(''), 2400) }

  const changeStep = (key: string, p: Partial<SopStepDef>) => commit({ ...draft, steps: draft.steps.map((s) => (s.key === key ? { ...s, ...p } : s)) })
  const toWorld = (cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: (cx - r.left - pan.x) / zoom, y: (cy - r.top - pan.y) / zoom }
  }

  const addNode = (item: PaletteItem, from: string, caseKey?: string) => {
    const step = makeStep(draft, item.kind, item.manual ? '人工判断' : item.id === 'rule' ? '条件分支' : item.label, from === START ? [] : [from],
      { ...(caseKey ? { branch: { of: from, case: caseKey } } : {}), ...(item.kind === 'decide' && !item.manual ? { cond: blankCond() } : {}) })
    // 同一个节点后面已经有几个子节点就往下错开几格，不管它们在哪个分支，免得叠在一起
    const siblings = draft.steps.filter((x) => (from === START ? !(x.after ?? []).length : x.after?.includes(from))).length
    const base = lay[from] ?? { x: 60, y: 80 }
    const layout = { ...lay, [step.key]: { x: base.x + NW + 84, y: base.y + siblings * 108 } }
    commit(topo({ ...draft, steps: [...draft.steps, step], layout }))
    setSel(step.key)
    setPalette(null)
    // 新节点落在视口外（多半在右边，被属性面板挡住）时把画布挪过去
    const el = canvasRef.current
    if (el) {
      const p = layout[step.key]
      const sx = pan.x + p.x * zoom
      const sy = pan.y + p.y * zoom
      // 属性面板打开后画布会变窄，按变窄后的宽度算
      const w = el.clientWidth - (sel ? 0 : 380)
      const dx = sx + NW * zoom > w - 40 ? w - 40 - (sx + NW * zoom) : 0
      const dy = sy + 120 * zoom > el.clientHeight - 60 ? el.clientHeight - 60 - (sy + 120 * zoom) : sy < 70 ? 70 - sy : 0
      if (dx || dy) setPan({ x: pan.x + dx, y: pan.y + dy })
    }
  }

  const connect = (from: string, to: string, caseKey?: string) => {
    if (from === to || to === START) return
    const target = draft.steps.find((s) => s.key === to)!
    if (from === START) { if ((target.after ?? []).length) say('这个节点已经有上游了，不用再从开始连'); return }
    if (ancestors(draft, from).has(to)) { say('不能连回上游，会形成环'); return }
    if (target.after?.includes(from) && !caseKey) return
    const after = [...new Set([...(target.after ?? []), from])]
    commit(topo({ ...draft, steps: draft.steps.map((s) => (s.key === to ? { ...s, after, ...(caseKey ? { branch: { of: from, case: caseKey } } : {}) } : s)) }))
  }

  const removeEdge = (from: string, to: string) => {
    if (from === START) return
    commit({ ...draft, steps: draft.steps.map((s) => (s.key === to ? { ...s, after: (s.after ?? []).filter((k) => k !== from), branch: s.branch?.of === from ? undefined : s.branch } : s)) })
    setSelEdge(null)
  }
  const removeNode = (key: string) => {
    if (key === START) return
    const i = draft.steps.findIndex((s) => s.key === key)
    const next = removeStep(draft, i)
    const layout = { ...(draft.layout ?? {}) }
    delete layout[key]
    commit({ ...next, layout })
    setSel(null)
  }

  // 键盘：删除选中的节点或连线，撤销 / 重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select')
      if (typing) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selEdge || (sel && sel !== START))) {
        e.preventDefault()
        if (selEdge) removeEdge(selEdge.from, selEdge.to)
        else if (sel) removeNode(sel)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 适配视口：把所有节点放进画布可见区域
  const fit = useCallback(() => {
    const el = canvasRef.current
    if (!el) return
    const keys = [START, ...draft.steps.map((s) => s.key)]
    const xs = keys.map((k) => lay[k].x)
    const ys = keys.map((k) => lay[k].y)
    const w = Math.max(...xs) + NW - Math.min(...xs)
    const h = Math.max(...keys.map((k) => lay[k].y + nodeH(draft, k))) - Math.min(...ys)
    // 缩得太小字就看不清了，宁可让宽流程超出视口、拖着看
    const z = Math.max(0.7, Math.min(1, (el.clientWidth - 120) / w, (el.clientHeight - 160) / h))
    const free = el.clientWidth - w * z
    setZoom(z)
    setPan({ x: (free > 120 ? free / 2 : 64) - Math.min(...xs) * z, y: (el.clientHeight - h * z) / 2 - Math.min(...ys) * z + 10 })
  }, [draft, lay])
  const fitted = useRef(false)
  useEffect(() => { if (!fitted.current) { fitted.current = true; fit() } }, [fit])

  const zoomAt = (z: number, cx?: number, cy?: number) => {
    const el = canvasRef.current!
    const r = el.getBoundingClientRect()
    const px = cx ?? r.left + r.width / 2
    const py = cy ?? r.top + r.height / 2
    const nz = Math.max(0.4, Math.min(1.8, z))
    const w = toWorld(px, py)
    setZoom(nz)
    setPan({ x: px - r.left - w.x * nz, y: py - r.top - w.y * nz })
  }
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) zoomAt(zoom * (e.deltaY > 0 ? 0.92 : 1.08), e.clientX, e.clientY)
    else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement
    if (e.button !== 0) return
    const handle = t.closest<HTMLElement>('[data-out]')
    const node = t.closest<HTMLElement>('[data-node]')
    if (handle) {
      const r = handle.getBoundingClientRect()
      drag.current = { kind: 'link', from: handle.dataset.out!, caseKey: handle.dataset.case || undefined, sx: e.clientX, sy: e.clientY, at: { x: r.right + 8, y: r.top - 10 } }
      setLink(toWorld(e.clientX, e.clientY))
    } else if (node && !t.closest('button, input')) {
      const key = node.dataset.node!
      drag.current = { kind: 'node', key, sx: e.clientX, sy: e.clientY, ox: lay[key].x, oy: lay[key].y, moved: false, before: draft }
    } else if (!node && !t.closest('.cv-ui, .edge-hit, .edge-del')) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
      setSel(null); setSelEdge(null)
    } else return
    canvasRef.current?.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') setPan({ x: d.px + e.clientX - d.sx, y: d.py + e.clientY - d.sy })
    else if (d.kind === 'node') {
      const dx = (e.clientX - d.sx) / zoom
      const dy = (e.clientY - d.sy) / zoom
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      d.moved = true
      setDraft((cur) => ({ ...cur, layout: { ...lay, [d.key]: { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) } } }))
    } else setLink(toWorld(e.clientX, e.clientY))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'node') {
      if (d.moved) { setPast((p) => [...p.slice(-49), d.before]); setFuture([]) } else { setSel(d.key); setSelEdge(null) }
    } else if (d.kind === 'link') {
      setLink(null)
      // 几乎没动就是点了 +：打开节点选择器；拖出去了才算连线
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) { setPalette({ at: d.at, from: d.from, caseKey: d.caseKey }); return }
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node]')
      if (target) connect(d.from, target.dataset.node!, d.caseKey)
      else setPalette({ at: { x: e.clientX + 8, y: e.clientY - 20 }, from: d.from, caseKey: d.caseKey })
    }
  }

  // 连线：开始节点连到所有没有上游的节点；判断节点从分支对应的出口连出
  const edges = [
    ...draft.steps.filter((s) => !(s.after ?? []).length).map((s) => ({ from: START, to: s.key, caseKey: undefined as string | undefined })),
    ...draft.steps.flatMap((s) => (s.after ?? []).map((k) => ({ from: k, to: s.key, caseKey: s.branch?.of === k ? s.branch.case : undefined }))),
  ]
  const outPt = (key: string, caseKey?: string) => {
    const p = lay[key]
    const st = draft.steps.find((x) => x.key === key)
    const ci = caseKey && st?.cases ? st.cases.findIndex((c) => c.key === caseKey) : -1
    return { x: p.x + NW, y: p.y + (ci >= 0 ? caseY(ci) : 30) }
  }
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const m = Math.max(40, Math.abs(b.x - a.x) / 2)
    return `M${a.x},${a.y} C${a.x + m},${a.y} ${b.x - m},${b.y} ${b.x},${b.y}`
  }
  const applyAi = (s: Sop) => {
    const next = { ...s, name: draft.name.trim() ? draft.name : s.name, layout: undefined }
    commit(next)
    setAiMark(next)
    setSel(null)
    // AI 整体替换后位置都变了，重新适配一次视口
    fitted.current = false
  }
  const save = (thenRun: boolean, off?: 'disable' | 'delete') => {
    setTried(true)
    if (errors.length) { setShowIssues(true); return }
    if (!creating && schedSaved && draft.trigger !== 'schedule' && !off) { setOffAsk({ thenRun }); return }
    setSchedSaved(draft.trigger === 'schedule' ? !!draft.sched : off === 'disable')
    const out = { ...draft, layout: lay }
    setSavedJson(JSON.stringify(out))
    if (aiMark === draft) setAiMark(out)
    if (nameEdit.current === draft) nameEdit.current = out
    setDraft(out)
    onSave(out, thenRun, off)
  }

  // 屏幕不够宽时，选中节点打开属性面板就先收起 AI 面板，给画布留地方
  useEffect(() => { if (sel && window.innerWidth < 1600) setAiOpen(false) }, [sel])

  const selStep = sel && sel !== START ? draft.steps.find((s) => s.key === sel) : null
  const stepIssues = (key: string) => issues.filter((x) => x.step !== undefined && draft.steps[x.step]?.key === key)

  return (
    <div className={cls('sop-editor', aiOpen && 'with-ai', sel && 'with-panel')}>
      <PageTitle parent="SOP">{creating ? '新建 SOP' : `编排 · ${draft.name || '未命名'}`}</PageTitle>
      {/* 收起只是藏起来，对话和没决定的提案在本次编排页里留着 */}
      <AiPanel hidden={!aiOpen} draft={draft} selected={selStep ? draft.steps.indexOf(selStep) : null} onApply={applyAi}
        onUndo={() => { undo(); setAiMark(null) }} canUndo={aiMark !== null && aiMark === draft && past.length > 0} onClose={() => setAiOpen(false)} />
      <div ref={canvasRef} className={cls('canvas', drag.current?.kind === 'pan' && 'panning')}
        style={{ backgroundSize: `${20 * zoom}px ${20 * zoom}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}>
        <div className="cv-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="cv-edges">
            {edges.map((ed) => {
              const a = outPt(ed.from, ed.caseKey)
              const b = { x: lay[ed.to].x, y: lay[ed.to].y + 30 }
              const on = selEdge?.from === ed.from && selEdge.to === ed.to
              const d = curve(a, b)
              return (
                <g key={`${ed.from}-${ed.to}`}>
                  <path d={d} className={cls('cv-edge', on && 'on', ed.caseKey && 'branch')} />
                  {ed.from !== START && <path d={d} className="edge-hit" onPointerDown={(e) => { e.stopPropagation(); setSelEdge({ from: ed.from, to: ed.to }); setSel(null) }} />}
                </g>
              )
            })}
            {link && drag.current?.kind === 'link' && <path d={curve(outPt(drag.current.from, drag.current.caseKey), link)} className="cv-edge on dashed" />}
          </svg>
          {selEdge && (() => {
            const a = outPt(selEdge.from, draft.steps.find((s) => s.key === selEdge.to)?.branch?.of === selEdge.from ? draft.steps.find((s) => s.key === selEdge.to)!.branch!.case : undefined)
            const b = { x: lay[selEdge.to].x, y: lay[selEdge.to].y + 30 }
            return <button className="edge-del" style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }} onClick={() => removeEdge(selEdge.from, selEdge.to)} title="删除连线 (Delete)">断开</button>
          })()}

          {/* 开始节点 */}
          <div className={cls('cv-node', sel === START && 'sel')} data-node={START} style={{ left: lay[START].x, top: lay[START].y, width: NW }}>
            <div className="cv-node-head"><KindIcon kind="start" /><span className="cv-node-name">开始</span><span className="cv-node-kind">{draft.trigger === 'schedule' ? (draft.sched ? `${triggerLabel(triggers, draft.trigger)} · ${describeRule(draft.sched.rule)}` : `${triggerLabel(triggers, draft.trigger)}，未配置`)
              : draft.trigger === 'im' && draft.im ? `${triggerLabel(triggers, draft.trigger)} · ${imFilterText(draft.im)}${draft.im.stop ? ' · 拦截后续' : ''}` : triggerLabel(triggers, draft.trigger)}</span></div>
            <div className="cv-fields">{draft.fields.map((f) => <span key={f.key} className="cv-field"><span className="mono">{'{x}'}</span>{f.label || '未命名字段'}{f.required && <em>*</em>}</span>)}</div>
            <span className="cv-handle" data-out={START} title="拖动连线，或点击添加下一个节点">+</span>
          </div>

          {draft.steps.map((s) => {
            const p = lay[s.key]
            const bad = stepIssues(s.key)
            return (
              <div key={s.key} className={cls('cv-node', `cvk-${s.kind}`, sel === s.key && 'sel', bad.some((x) => x.level === 'error') && 'bad')} data-node={s.key} style={{ left: p.x, top: p.y, width: NW }}>
                <span className="cv-in" />
                <div className="cv-node-head">
                  <KindIcon kind={s.kind} />
                  <span className="cv-node-name ellipsis">{s.name || '未命名'}</span>
                  {bad.length > 0 && <span className="cv-warn" title={bad.map((x) => x.text).join('\n')}>!</span>}
                </div>
                {isBranching(s.kind) ? (
                  <div className="cv-cases">
                    {(s.cases ?? []).map((c) => (
                      <div key={c.key} className="cv-case">
                        <span className="ellipsis">{c.label || '未命名分支'}</span>
                        <span className="cv-handle cv-handle-case" data-out={s.key} data-case={c.key} title={`拖动连线，或点击在「${c.label}」分支加节点`}>+</span>
                      </div>
                    ))}
                    <div className="cv-rule ellipsis">{s.kind === 'classifier' ? 'AI 分类' : isManualDecide(s) ? '人工判断' : s.kind === 'loopback' ? `${s.cond ? `条件：${condText(s.cond)}` : s.rule?.trim() ? `条件：${s.rule}` : '还没填回退条件'} · 退回 ${draft.steps.find((x) => x.key === s.config?.target)?.name ?? '未选'}` : s.cond ? `条件：${condText(s.cond)}` : s.rule?.trim() ? `规则：${s.rule}` : '按内置规则判断'}</div>
                  </div>
                ) : (
                  <>
                    <div className="cv-desc ellipsis">{typeOf(s.kind).summary?.(s.config ?? {}) || s.desc || <span className="faint">{typeOf(s.kind).label}</span>}</div>
                    <span className="cv-handle" data-out={s.key} title="拖动连线，或点击添加下一个节点">+</span>
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* 画布上的浮层 */}
        <div className="cv-ui cv-top-left">
          <button className="icon-btn" onClick={onCancel} title={creating ? '取消' : '返回'}>
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <input className={cls('cv-title', tried && !draft.name.trim() && 'bad')} value={draft.name} placeholder="SOP 名称" onChange={(e) => rename(e.target.value)} />
          <span className="cv-status">{creating && !savedJson ? '未保存' : dirty ? '有未保存的修改' : '已保存'}</span>
        </div>
        <div className="cv-ui cv-top-right">
          {!aiOpen && <button className="act ai-open" onClick={() => setAiOpen(true)}><span className="ai-mark ai-mark-sm">AI</span>AI 协助</button>}
          <div className="menu-wrap">
            <button className={cls('act', errors.length > 0 && 'act-danger', !errors.length && issues.length > 0 && 'act-warn')} onClick={() => setShowIssues(!showIssues)}>
              {issues.length ? `检查 ${issues.length}` : '检查通过'}
            </button>
            {showIssues && (
              <div className="menu cv-issues">
                {issues.length ? issues.map((x, n) => (
                  <button key={n} className={cls('menu-item cv-issue', `issue-${x.level}`)} onClick={() => { if (x.step !== undefined) setSel(draft.steps[x.step].key); setShowIssues(false) }}>
                    <span className={`issue-dot dot-${x.level}`} />{x.text}
                  </button>
                )) : <div className="io-empty">没发现问题</div>}
              </div>
            )}
          </div>
          <button className="btn btn-outline" onClick={() => save(true)}>
            <svg viewBox="0 0 16 16" width="11" height="11"><path d="M4.5 3v10l8-5Z" fill="currentColor" /></svg>
            测试运行
          </button>
          <button className="btn btn-primary" onClick={() => save(false)}>{creating && !savedJson ? '发布' : '保存'}</button>
          {/* 从定时改成别的触发方式（TSK-0463）：保存前问那条定时任务停用还是删掉 */}
          {offAsk && (
            <div className="menu cv-issues sop-off-ask" role="dialog" aria-label="不再定时执行？">
              <b>不再定时执行？</b>
              <span className="list-sub">触发方式改成「{triggerLabel(triggers, draft.trigger)}」后，随这个流程的定时任务怎么处理：</span>
              <label><input type="radio" name="sop-off" checked={offChoice === 'disable'} onChange={() => setOffChoice('disable')} /><span><b>停用</b>　规则留着，以后改回定时时恢复</span></label>
              <label><input type="radio" name="sop-off" checked={offChoice === 'delete'} onChange={() => setOffChoice('delete')} /><span><b>删掉</b>　定时任务页里这一条一起删除</span></label>
              <div className="act-row">
                <button className="btn btn-ghost" onClick={() => setOffAsk(null)}>取消</button>
                <button className="btn btn-primary" onClick={() => { const t = offAsk.thenRun; setOffAsk(null); save(t, offChoice) }}>保存</button>
              </div>
            </div>
          )}
        </div>
        <div className="cv-ui cv-tools">
          <button className="icon-btn" title="添加节点" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPalette({ at: { x: r.right + 8, y: r.top }, from: sel ?? (draft.steps.length ? draft.steps[draft.steps.length - 1].key : START) }) }}>
            <svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          <button className="icon-btn" title="自动整理" onClick={() => { commit({ ...draft, layout: undefined }); fitted.current = false }}>
            <svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="2.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="10" y="2.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="10" y="9.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M6 4.5h4M8 4.5v7h2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
          <button className="icon-btn" title="适配视口" onClick={fit}>
            <svg viewBox="0 0 16 16" width="15" height="15"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className="cv-ui cv-bottom-left">
          <button className="icon-btn" disabled={!past.length} onClick={undo} title="撤销 (⌘Z)">
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M5 3 2.5 5.5 5 8M2.5 5.5h7a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button className="icon-btn" disabled={!future.length} onClick={redo} title="重做 (⇧⌘Z)">
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M11 3l2.5 2.5L11 8M13.5 5.5h-7a3.5 3.5 0 0 0 0 7H10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <span className="cv-hint">拖空白处平移，⌘ + 滚轮缩放，Delete 删除选中的节点或连线</span>
        </div>
        <div className="cv-ui cv-bottom-right">
          <button className="icon-btn" onClick={() => zoomAt(zoom / 1.15)} title="缩小">
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 7h4M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          <button className="cv-zoom" onClick={() => zoomAt(1)} title="恢复 100%">{Math.round(zoom * 100)}%</button>
          <button className="icon-btn" onClick={() => zoomAt(zoom * 1.15)} title="放大">
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 7h4M7 5v4M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
        {!draft.steps.length && (
          <div className="cv-ui cv-empty">
            <div className="empty-title">从开始节点右边的 + 加第一个节点</div>
            <div className="list-sub">或者在左边用一段话告诉 AI 这个流程怎么走</div>
            {!aiOpen && <button className="act act-primary" onClick={() => setAiOpen(true)}>让 AI 帮我建</button>}
          </div>
        )}
        {toast && <div className="cv-ui cv-toast">{toast}</div>}
      </div>

      {sel && (
        <NodePanel draft={draft} nodeKey={sel} runs={runs} sopList={sopList.filter((x) => x.id !== draft.id)} tried={tried}
          onChange={(p) => changeStep(sel, p)} onPatchSop={(p) => commit({ ...draft, ...p })}
          onRemove={() => removeNode(sel)} onRemoveEdge={removeEdge} onSelect={setSel}
          onAddNext={(at, from, caseKey) => setPalette({ at, from, caseKey })} onClose={() => setSel(null)} />
      )}
      {palette && <Palette at={palette.at} onClose={() => setPalette(null)} onPick={(p) => addNode(p, palette.from, palette.caseKey)} />}
    </div>
  )
}
