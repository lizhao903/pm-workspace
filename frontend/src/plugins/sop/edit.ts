// 编排页的纯函数（SPEC-sop-8 到 11）：节点目录、草稿增删改、连线、自动排版、保存前检查。照原型 web-next/src/sopedit.tsx。
// 节点有哪些、是不是分支节点、哪些配置项必填按 GET /api/sop/node-types（目录 Catalog），展示在 nodes.tsx。
// 保存前的检查是原型 checkSop 那一套（错误拦保存、建议只提示）；后端另查的（key 唯一、依赖无环、分支 case 存在）
// 由保存时的 400 带回来，按步骤 key 记下标到节点上（serverIssuesOf）
import type { SopDraft, SopField, SopIssue, SopNodeType, SopStepDef } from '../../core/data'
import { blankCond, condProblems, legacyCond } from './cond'
import { depsOf, isManualDecide, ranks } from './model'
import { defaultConfig, nodeInfo } from './nodes'

export type Draft = SopDraft
export type Pos = { x: number; y: number }
export type Layout = Record<string, Pos>

/** 画布上开始节点在 layout 里的 key */
export const START = '__start'
/** 节点宽度 */
export const NW = 232
/** 节点之间的列距 */
export const COL_GAP = 84

/* ---------- 节点目录 ---------- */

export type Catalog = { types: SopNodeType[]; byKind: Map<string, SopNodeType> }

export function catalogOf(types: readonly SopNodeType[] | undefined): Catalog {
  const list = [...(types ?? [])]
  return { types: list, byKind: new Map(list.map((t) => [t.kind, t])) }
}
export const isBranching = (cat: Catalog, kind: string) => !!cat.byKind.get(kind)?.branching
export const requiredOf = (cat: Catalog, kind: string) => cat.byKind.get(kind)?.required ?? []
export const isRequired = (cat: Catalog, kind: string, key: string) => requiredOf(cat, kind).some((r) => r.key === key)

/** 编辑器不列的内置节点：notify 由 IM 插件登记的节点代替（SOP-02b） */
export const HIDDEN_KINDS: readonly string[] = ['notify']

export type PaletteItem = { id: string; kind: string; manual?: boolean; label: string; desc: string; group: string }

/** 节点选择器的项：目录里每种一项（隐藏的除外）；条件分支另拆出「人工判断」放在人工组，两者是同一种节点 decide */
export function paletteItems(cat: Catalog): PaletteItem[] {
  const out: PaletteItem[] = cat.types.filter((t) => !HIDDEN_KINDS.includes(t.kind))
    .map((t) => ({ id: t.kind, kind: t.kind, label: nodeInfo(t.kind).label, desc: nodeInfo(t.kind).desc, group: t.group }))
  if (cat.byKind.has('decide')) out.push({ id: 'manual', kind: 'decide', manual: true, label: '人工判断', desc: '由人选这次走哪个分支', group: '人工' })
  return out
}

/** 分组按目录里第一次出现的先后 */
export function groupsOf(items: readonly { group: string }[]) {
  return [...new Set(items.map((x) => x.group))]
}

export function filterPalette(items: readonly PaletteItem[], q: string) {
  const kw = q.trim().toLowerCase()
  return items.filter((p) => !kw || `${p.label}${p.desc}`.toLowerCase().includes(kw))
}

/* ---------- 草稿 ---------- */

/** 新建的草稿：一个必填的多行输入「输入内容」，没有步骤 */
export function newDraft(trigger: string): Draft {
  return {
    name: '', desc: '', trigger,
    fields: [{ key: 'input', label: '输入内容', type: 'textarea', required: true, default: '' }],
    steps: [],
  }
}

/** 编辑器里依赖一律写明，不靠「接在上一步后面」的默认规则，免得插入和删除时意外改连线 */
export const explicit = (d: Draft): Draft => ({ ...d, steps: d.steps.map((s, i) => ({ ...s, after: depsOf(d, i) })) })

/** 新步骤的 key：s 加序号，跳过已有的 */
export function newKey(d: Pick<Draft, 'steps'>, taken: readonly string[] = []) {
  const used = new Set([...d.steps.map((s) => s.key), ...taken])
  let n = d.steps.length + 1
  while (used.has(`s${n}`)) n += 1
  return `s${n}`
}

/** 新节点：名称、默认配置、分支节点带默认分支（条件回退另带一条待选字段的结构化条件；条件分支的条件由调用方给，人工判断不给） */
export function makeStep(d: Draft, cat: Catalog, kind: string, name: string, after: string[], extra: Partial<SopStepDef> = {}): SopStepDef {
  const t = cat.byKind.get(kind)
  return {
    key: newKey(d), name, kind, desc: '', after, config: defaultConfig(kind),
    ...(t?.branching ? { cases: (t.default_cases ?? []).map((c) => ({ ...c })), ...(kind === LOOPBACK ? { cond: blankCond() } : {}) } : {}),
    ...extra,
  }
}

/** 在第 at 步后面插一步：新步骤接在它后面，原来接它的（分支出口除外）改接新步骤 */
export function insertAfter(d: Draft, at: number | null, step: SopStepDef): Draft {
  if (at === null || !d.steps.length) {
    return { ...d, steps: [...d.steps, { ...step, after: d.steps.length ? [d.steps[d.steps.length - 1].key] : [] }] }
  }
  const prev = d.steps[at]
  const rewired = d.steps.map((x) => (x.after?.includes(prev.key) && x.branch?.of !== prev.key
    ? { ...x, after: x.after.map((k) => (k === prev.key ? step.key : k)) } : x))
  return { ...d, steps: [...rewired.slice(0, at + 1), { ...step, after: [prev.key] }, ...rewired.slice(at + 1)] }
}

/** 删一步：接它的步骤改接它的上游，挂在它（判断）上的分支一并解开；它的位置也去掉 */
export function removeStep(d: Draft, key: string): Draft {
  const gone = d.steps.find((s) => s.key === key)
  if (!gone) return d
  const up = gone.after ?? []
  const steps = d.steps.filter((s) => s.key !== key).map((x) => {
    let after = x.after ?? []
    if (after.includes(key)) after = [...new Set(after.flatMap((k) => (k === key ? up : [k])))]
    const branch = x.branch?.of === key ? undefined : x.branch
    return { ...x, after, branch }
  })
  const layout = d.layout && Object.fromEntries(Object.entries(d.layout).filter(([k]) => k !== key))
  return { ...d, steps, layout }
}

/** 改完连线后按依赖稳定重排步骤（引擎和「上游只能选前面的」都靠这个顺序）；有环时按原顺序取一个，不死循环 */
export function topo(d: Draft): Draft {
  const keys = new Set(d.steps.map((s) => s.key))
  const done = new Set<string>()
  const out: SopStepDef[] = []
  let rest = [...d.steps]
  while (rest.length) {
    const ready = rest.filter((s) => (s.after ?? []).every((k) => done.has(k) || !keys.has(k)))
    const pick = ready.length ? ready : [rest[0]]
    for (const s of pick) { out.push(s); done.add(s.key) }
    rest = rest.filter((s) => !done.has(s.key))
  }
  return { ...d, steps: out }
}

/** key 的全部上游 */
export function ancestors(d: Draft, key: string, seen = new Set<string>()): Set<string> {
  for (const k of d.steps.find((s) => s.key === key)?.after ?? []) {
    if (!seen.has(k)) { seen.add(k); ancestors(d, k, seen) }
  }
  return seen
}

/** 子节点：开始节点的是没有上游的步骤 */
export const childrenOf = (d: Draft, key: string) =>
  d.steps.filter((x) => (key === START ? !(x.after ?? []).length : x.after?.includes(key)))

export type Connect = { ok: true; draft: Draft } | { ok: false; toast?: string }

/** 从 from（分支出口时带 caseKey）连到 to；连到自己、连到开始、重复连不连也不提示 */
export function connect(d: Draft, from: string, to: string, caseKey?: string): Connect {
  if (from === to || to === START) return { ok: false }
  const target = d.steps.find((s) => s.key === to)
  if (!target) return { ok: false }
  if (from === START) return { ok: false, toast: (target.after ?? []).length ? '这个节点已经有上游了，不用再从开始连' : undefined }
  if (ancestors(d, from).has(to)) return { ok: false, toast: '不能连回上游，会形成环' }
  if (target.after?.includes(from) && !caseKey) return { ok: false }
  const after = [...new Set([...(target.after ?? []), from])]
  return {
    ok: true,
    draft: topo({ ...d, steps: d.steps.map((s) => (s.key === to ? { ...s, after, ...(caseKey ? { branch: { of: from, case: caseKey } } : {}) } : s)) }),
  }
}

/** 断开一条依赖；从分支出口来的同时解开分支。开始节点连出的线不能断 */
export function removeEdge(d: Draft, from: string, to: string): Draft {
  if (from === START) return d
  return {
    ...d,
    steps: d.steps.map((s) => (s.key === to ? { ...s, after: (s.after ?? []).filter((k) => k !== from), branch: s.branch?.of === from ? undefined : s.branch } : s)),
  }
}

/** 换类型：保留名称和说明，配置换成新类型的默认值；变成分支节点时补默认分支（已有的保留），变成非分支时去掉分支和规则 */
export function changeKind(cat: Catalog, s: SopStepDef, kind: string): Partial<SopStepDef> {
  const t = cat.byKind.get(kind)
  return {
    kind, config: defaultConfig(kind),
    ...(t?.branching
      // 条件回退的两个出口 key 固定（pass / over），换成它或从它换走时一律用默认出口
      ? { cases: s.cases?.length && kind !== LOOPBACK && s.kind !== LOOPBACK ? s.cases : (t.default_cases ?? []).map((c) => ({ ...c })),
        ...(kind === 'decide' || kind === LOOPBACK ? { rule: s.rule, cond: s.cond ?? (kind === LOOPBACK ? blankCond() : undefined) } : { rule: undefined, cond: undefined }) }
      : { cases: undefined, rule: undefined, cond: undefined }),
  }
}

/** 开始节点的下拉字段改类型：改成下拉时没有选项先给一个空的 */
export function fieldTypePatch(f: SopField, type: SopField['type'], newOptKey: () => string): Partial<SopField> {
  return type === 'select' && !f.options?.length ? { type, options: [{ value: newOptKey(), label: '' }] } : { type }
}

/* ---------- 画布排版 ---------- */

export function nodeH(d: Draft, cat: Catalog, key: string) {
  if (key === START) return 50 + Math.max(1, d.fields.length) * 26
  const s = d.steps.find((x) => x.key === key)
  return s && isBranching(cat, s.kind) ? 50 + (s.cases?.length ?? 2) * 30 : 82
}
/** 第 i 个分支出口的纵向位置（相对节点顶部） */
export const caseY = (i: number) => 52 + i * 30 + 13

/** 按依赖分列排开；开始节点在最左 */
export function autoLayout(d: Draft, cat: Catalog): Layout {
  const rk = ranks(d)
  const cols: string[][] = []
  d.steps.forEach((s, i) => { (cols[rk[i]] ??= []).push(s.key) })
  // 有环时可能空出某一列（数组的洞），map 会跳过洞，用 Array.from 补成空列
  const filled = Array.from(cols, (c) => c ?? [])
  const out: Layout = { [START]: { x: 60, y: 0 } }
  const heights = filled.map((c) => c.reduce((a, k) => a + nodeH(d, cat, k) + 28, -28))
  const tallest = Math.max(nodeH(d, cat, START), ...heights)
  out[START].y = 80 + (tallest - nodeH(d, cat, START)) / 2
  filled.forEach((col, c) => {
    let y = 80 + (tallest - heights[c]) / 2
    col.forEach((k) => { out[k] = { x: 60 + (c + 1) * (NW + COL_GAP), y }; y += nodeH(d, cat, k) + 28 })
  })
  return out
}

/** 画布用的位置：手动摆过的优先，其余自动排 */
export const layoutOf = (d: Draft, cat: Catalog): Layout => ({ ...autoLayout(d, cat), ...(d.layout ?? {}) })

/** 适配视口：最小缩到 70%（宁可超出视口拖着看），最大 100% */
export function fitView(d: Draft, cat: Catalog, lay: Layout, w: number, h: number) {
  const keys = [START, ...d.steps.map((s) => s.key)].filter((k) => lay[k])
  const xs = keys.map((k) => lay[k].x)
  const ys = keys.map((k) => lay[k].y)
  const bw = Math.max(...xs) + NW - Math.min(...xs)
  const bh = Math.max(...keys.map((k) => lay[k].y + nodeH(d, cat, k))) - Math.min(...ys)
  const zoom = Math.max(0.7, Math.min(1, (w - 120) / bw, (h - 160) / bh))
  const free = w - bw * zoom
  return { zoom, pan: { x: (free > 120 ? free / 2 : 64) - Math.min(...xs) * zoom, y: (h - bh * zoom) / 2 - Math.min(...ys) * zoom + 10 } }
}

/* ---------- 检查 ---------- */

/** code 是后端按节点声明查的分类（TSK-0490），legacy_rule 时节点面板给「转成结构化条件」 */
export type Issue = { level: 'error' | 'warn'; text: string; step?: number; code?: string }

const nameOf = (s: SopStepDef) => s.name.trim() || s.key

/** 保存前的检查（SPEC-sop-8.21、8.22）：错误不让保存，建议只提示 */
export function checkDraft(d: Draft, cat: Catalog): Issue[] {
  const out: Issue[] = []
  if (!d.name.trim()) out.push({ level: 'error', text: '还没有名称' })
  if (!d.steps.length) out.push({ level: 'error', text: '至少要有一个步骤' })
  d.fields.forEach((f, i) => { if (!f.label.trim()) out.push({ level: 'error', text: `第 ${i + 1} 个输入字段没有名称` }) })
  const keys = new Set(d.steps.map((s) => s.key))
  d.steps.forEach((s, i) => {
    if (!s.name.trim()) out.push({ level: 'error', text: `步骤 ${i + 1} 没有名称`, step: i })
    if (cat.types.length && !cat.byKind.has(s.kind)) out.push({ level: 'error', text: `「${nameOf(s)}」的类型 ${s.kind} 不存在`, step: i })
    for (const r of requiredOf(cat, s.kind)) {
      if (!s.config?.[r.key]?.trim()) out.push({ level: 'error', text: `「${nameOf(s)}」还没填「${r.label}」`, step: i })
    }
    if (isBranching(cat, s.kind)) {
      const cases = s.cases ?? []
      if (cases.length < 2) out.push({ level: 'error', text: `「${nameOf(s)}」至少要有两个分支`, step: i })
      cases.forEach((c) => {
        if (!c.label.trim()) out.push({ level: 'error', text: `「${nameOf(s)}」有分支没写名称`, step: i })
        else if (!d.steps.some((x) => x.branch?.of === s.key && x.branch.case === c.key)) {
          out.push({ level: 'warn', text: `「${nameOf(s)}」的「${c.label}」分支下没有步骤，选中它时流程会直接往下走`, step: i })
        }
      })
    }
    if (s.kind === 'decide') out.push(...condIssues(s, i))
    if (s.kind === LOOPBACK) out.push(...loopbackIssues(d, i))
    if ((s.kind === 'claude_code' || s.kind === 'task_run') && claudeTimeoutMs(s.config?.timeout) === null) {
      out.push({ level: 'error', text: `「${nameOf(s)}」超时写法不对，要写成「30 分钟」「2 小时」这样，最多 24 小时`, step: i })
    }
    if (s.branch && !d.steps.some((x) => x.key === s.branch!.of && isBranching(cat, x.kind))) {
      out.push({ level: 'error', text: `「${nameOf(s)}」挂在一个不存在的判断上`, step: i })
    }
    if ((s.after ?? []).some((k) => !keys.has(k))) out.push({ level: 'error', text: `「${nameOf(s)}」依赖的步骤已被删除`, step: i })
  })
  if (d.steps.length && !d.steps.some((s) => s.kind === 'review' || isManualDecide(s))) {
    out.push({ level: 'warn', text: '整个流程没有人工检查点，执行时不会停下来让人看输出' })
  }
  const starts = d.steps.filter((s) => !(s.after ?? []).length).length
  if (starts > 1) out.push({ level: 'warn', text: `有 ${starts} 个起点，它们会在开始时同时执行` })
  return out
}

/* ---------- 条件回退（AUTO-02）、Claude Code 执行（AUTO-01） ---------- */

export const LOOPBACK = 'loopback'

/** 最多退回几轮：留空 3，1 到 10 的整数；写法不对回 null（同后端 loopRounds） */
export function loopRounds(s?: string): number | null {
  if (!s?.trim()) return 3
  const n = Number(s.trim())
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null
}

/** Claude Code 节点的超时：留空 2 小时，「30 分钟」「2 小时」「1 天」，也认 90s、1h30m，最多 24 小时；写法不对回 null（同后端 claudeTimeout） */
export function claudeTimeoutMs(s?: string): number | null {
  if (!s?.trim()) return 2 * 3600e3
  const unit: Record<string, number> = { 秒: 1e3, 秒钟: 1e3, 分: 60e3, 分钟: 60e3, 时: 3600e3, 小时: 3600e3, 天: 86400e3, 周: 7 * 86400e3 }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(秒钟?|分钟|分|小时|时|天|周)\s*$/.exec(s)
  let ms: number | null = null
  if (m) ms = Number(m[1]) * unit[m[2]]
  else if (/^(\d+(\.\d+)?(h|m|s|ms))+$/.test(s.trim())) {
    ms = 0
    for (const [, n, u] of s.trim().matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(n) * { h: 3600e3, m: 60e3, s: 1e3, ms: 1 }[u as 'h' | 'm' | 's' | 'ms']
  }
  return ms !== null && ms > 0 && ms <= 86400e3 ? ms : null
}

/** 第 i 步沿依赖往上的所有步骤（不含自己），按步骤顺序 */
export function upstreamSteps(d: Pick<Draft, 'steps'>, i: number): SopStepDef[] {
  const up = ancestors(d as Draft, d.steps[i]?.key ?? '')
  return d.steps.filter((s) => up.has(s.key))
}

/** 条件分支、条件回退的条件（TSK-0490，同后端 declIssues 的前几条）：结构化条件的写法；旧规则是一句话的拦，旧写法的提示换掉。
 * 字段这一步拿不拿得到由后端按节点声明查，保存时带回来 */
export function condIssues(s: SopStepDef, i: number): Issue[] {
  const name = nameOf(s)
  const rule = s.rule?.trim() ?? ''
  if (s.cond && rule) return [{ level: 'error', text: `「${name}」同时有结构化条件和旧规则，删掉旧规则`, step: i, code: 'cond' }]
  if (s.cond) return condProblems(s.cond).map((t) => ({ level: 'error' as const, text: `「${name}」${t}`, step: i, code: 'cond' }))
  if (!rule) return []
  return legacyCond(rule)
    ? [{ level: 'warn', text: `「${name}」的条件还是旧写法「${rule}」，执行仍按它判断；建议转成结构化条件`, step: i, code: 'legacy_rule' }]
    : [{ level: 'error', text: `「${name}」的条件「${rule}」是一句话，程序没法照着判断：改成结构化条件（字段 + 运算符 + 值），这句话可以写进说明`, step: i, code: 'rule_text' }]
}

/** 条件回退的检查，同后端 checkLoopback：条件、目标是上游（回退不是依赖，不算环）、上限、两个出口 */
export function loopbackIssues(d: Pick<Draft, 'steps'>, i: number): Issue[] {
  const s = d.steps[i]
  const name = nameOf(s)
  const out: Issue[] = []
  if (!s.cond && !s.rule?.trim()) out.push({ level: 'error', text: `「${name}」还没填回退条件`, step: i })
  else out.push(...condIssues(s, i))
  const t = s.config?.target?.trim()
  if (t) {
    if (t === s.key) out.push({ level: 'error', text: `「${name}」不能退回到自己`, step: i })
    else if (!d.steps.some((x) => x.key === t)) out.push({ level: 'error', text: `「${name}」退回的步骤已被删除`, step: i })
    else if (!upstreamSteps(d, i).some((x) => x.key === t)) out.push({ level: 'error', text: `「${name}」只能退回到上游的步骤`, step: i })
  }
  if (loopRounds(s.config?.max_rounds) === null) out.push({ level: 'error', text: `「${name}」最多退回几轮要是 1 到 10 的整数`, step: i })
  const keys = (s.cases ?? []).map((c) => c.key)
  if (!keys.includes('pass') || !keys.includes('over')) out.push({ level: 'error', text: `「${name}」出口要有「通过」和「超限」`, step: i })
  return out
}

/** 后端带回来的问题（保存被拒、保存成功的警告、打开时的问题，TSK-0490）：下标换成步骤 key 记下，之后步骤重排、增删也标得到 */
export type ServerIssue = { text: string; key?: string; level: 'error' | 'warn'; code?: string }
export const serverIssuesOf = (issues: readonly SopIssue[], d: Pick<Draft, 'steps'>): ServerIssue[] =>
  issues.map((x) => ({
    text: x.text, level: x.level === 'warning' ? 'warn' as const : 'error' as const, ...(x.code ? { code: x.code } : {}),
    ...(x.step !== undefined && d.steps[x.step] ? { key: d.steps[x.step].key } : {}),
  }))

/** 前端检查加上后端带回来的；后端的那条前端也查出来了（同一步同一类，或同样的话）就不重复列；步骤删掉了的不再列。错误在前 */
export function mergeIssues(local: readonly Issue[], server: readonly ServerIssue[], d: Draft): Issue[] {
  const seen = new Set(local.map((x) => x.text))
  const same = new Set(local.filter((x) => x.code && x.step !== undefined).map((x) => `${x.step}:${x.code}`))
  const extra: Issue[] = []
  for (const x of server) {
    if (seen.has(x.text)) continue
    const code = x.code ? { code: x.code } : {}
    if (x.key === undefined) { extra.push({ level: x.level, text: x.text, ...code }); continue }
    const i = d.steps.findIndex((s) => s.key === x.key)
    if (i < 0 || (x.code && same.has(`${i}:${x.code}`))) continue
    // 条件的写法类问题前端也查（condIssues），前端没查出来说明已经改掉了，后端那条是旧的
    if (x.code === 'legacy_rule' || x.code === 'rule_text' || x.code === 'cond') continue
    extra.push({ level: x.level, text: x.text, step: i, ...code })
  }
  const all = [...local, ...extra]
  return [...all.filter((x) => x.level === 'error'), ...all.filter((x) => x.level !== 'error')]
}

/** 草稿有没有改过：按 JSON 比 */
export const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)
