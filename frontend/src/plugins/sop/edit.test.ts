import { describe, expect, it } from 'vitest'
import type { SopNodeType, SopStepDef } from '../../core/data'
import {
  START, autoLayout, catalogOf, changeKind, checkDraft, connect, explicit, insertAfter, makeStep, mergeIssues, newDraft, paletteItems,
  removeEdge, removeStep, serverIssuesOf, topo, type Draft,
} from './edit'

const TYPES: SopNodeType[] = [
  { kind: 'auto', group: '基础', branching: false, required: [] },
  { kind: 'template', group: '知识与数据', branching: false, required: [{ key: 'template', label: '模板' }] },
  { kind: 'decide', group: '逻辑', branching: true, default_cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], required: [] },
  { kind: 'review', group: '人工', branching: false, required: [] },
  { kind: 'http', group: '外部', branching: false, required: [{ key: 'url', label: '地址' }] },
  { kind: 'notify', group: '外部', branching: false, required: [{ key: 'to', label: '发给' }] },
  { kind: 'doc', group: '外部', branching: false, required: [] },
  { kind: 'demo_ping', group: '外部', branching: false, required: [] },
]
const cat = catalogOf(TYPES)
const step = (key: string, kind: string, after: string[] = [], extra: Partial<SopStepDef> = {}): SopStepDef => ({ key, name: key, kind, desc: '', after, ...extra })
const draft = (steps: SopStepDef[], name = '流程'): Draft => ({ ...newDraft('手动'), name, steps })

describe('节点目录', () => {
  it('隐藏 notify，条件分支另拆出人工判断放在人工组，插件节点照常列出', () => {
    const items = paletteItems(cat)
    expect(items.map((x) => x.id)).toEqual(['auto', 'template', 'decide', 'review', 'http', 'doc', 'demo_ping', 'manual'])
    expect(items.find((x) => x.id === 'manual')).toMatchObject({ kind: 'decide', group: '人工', label: '人工判断' })
    expect(items.find((x) => x.id === 'doc')?.label).toBe('写文档')
    expect(items.find((x) => x.id === 'demo_ping')?.label).toBe('demo_ping')
  })

  it('新节点带默认配置；分支节点带目录里的默认分支', () => {
    const d = draft([])
    expect(makeStep(d, cat, 'http', 'HTTP 请求', []).config).toEqual({ method: 'POST' })
    const dec = makeStep(d, cat, 'decide', '条件分支', [])
    expect(dec.cases).toEqual([{ key: 'yes', label: '是' }, { key: 'no', label: '否' }])
    expect(dec.rule).toBe('')
  })

  it('换类型：保留名称，配置换成新类型的默认值；变成非分支时去掉分支和规则', () => {
    const s = step('a', 'decide', [], { cases: [{ key: 'x', label: '甲' }, { key: 'y', label: '乙' }], rule: 'r' })
    expect(changeKind(cat, s, 'http')).toEqual({ kind: 'http', config: { method: 'POST' }, cases: undefined, rule: undefined })
    expect(changeKind(cat, step('b', 'auto'), 'decide')).toMatchObject({ kind: 'decide', cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], rule: '' })
  })
})

describe('草稿操作', () => {
  it('依赖一律写明：没写 after 的接在上一步后面', () => {
    const d = explicit(draft([{ key: 'a', name: 'a', kind: 'auto' }, { key: 'b', name: 'b', kind: 'auto' }]))
    expect(d.steps.map((s) => s.after)).toEqual([[], ['a']])
  })

  it('插在中间：原来接它的改接新步骤，分支出口不动', () => {
    const d = draft([step('a', 'decide', [], { cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }] }), step('b', 'auto', ['a'], { branch: { of: 'a', case: 'yes' } }), step('c', 'auto', ['a'])])
    const next = insertAfter(d, 0, step('n', 'review'))
    expect(next.steps.map((s) => [s.key, s.after])).toEqual([['a', []], ['n', ['a']], ['b', ['a']], ['c', ['n']]])
  })

  it('删一步：接它的改接它的上游，挂在它上的分支解开，位置也去掉', () => {
    const d = { ...draft([step('a', 'decide', [], { cases: [] }), step('b', 'auto', ['a'], { branch: { of: 'a', case: 'yes' } }), step('c', 'auto', ['b'])]), layout: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } }
    const next = removeStep(d, 'a')
    expect(next.steps.map((s) => [s.key, s.after, s.branch])).toEqual([['b', [], undefined], ['c', ['b'], undefined]])
    expect(next.layout).toEqual({ b: { x: 2, y: 2 } })
  })

  it('连线：连回上游提示会成环，从开始连到已有上游的提示，重复连不连', () => {
    const d = draft([step('a', 'auto'), step('b', 'auto', ['a']), step('c', 'auto', ['b'])])
    expect(connect(d, 'c', 'a')).toEqual({ ok: false, toast: '不能连回上游，会形成环' })
    expect(connect(d, START, 'b')).toEqual({ ok: false, toast: '这个节点已经有上游了，不用再从开始连' })
    expect(connect(d, 'a', 'b')).toEqual({ ok: false })
    expect(connect(d, 'a', 'a')).toEqual({ ok: false })
    const r = connect(d, 'a', 'c')
    expect(r.ok && r.draft.steps.find((s) => s.key === 'c')?.after).toEqual(['b', 'a'])
  })

  it('从分支出口连线挂到这个分支；断开时一并解开', () => {
    const d = draft([step('a', 'decide', [], { cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }] }), step('b', 'auto')])
    const r = connect(d, 'a', 'b', 'no')
    expect(r.ok && r.draft.steps.find((s) => s.key === 'b')).toMatchObject({ after: ['a'], branch: { of: 'a', case: 'no' } })
    const cut = removeEdge(r.ok ? r.draft : d, 'a', 'b')
    expect(cut.steps.find((s) => s.key === 'b')).toMatchObject({ after: [], branch: undefined })
  })

  it('按依赖稳定重排；有环时不死循环', () => {
    expect(topo(draft([step('b', 'auto', ['a']), step('a', 'auto')])).steps.map((s) => s.key)).toEqual(['a', 'b'])
    expect(topo(draft([step('a', 'auto', ['b']), step('b', 'auto', ['a'])])).steps.map((s) => s.key)).toEqual(['a', 'b'])
  })

  it('自动排版：按依赖分列；有环时位置也都是数字', () => {
    const lay = autoLayout(draft([step('a', 'auto'), step('b', 'auto', ['a']), step('c', 'auto', ['a'])]), cat)
    expect(lay.b.x).toBe(lay.c.x)
    expect(lay.b.x).toBeGreaterThan(lay.a.x)
    const cyc = autoLayout(draft([step('a', 'auto', ['b']), step('b', 'review', ['a'])]), cat)
    for (const p of Object.values(cyc)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })
})

describe('保存前检查', () => {
  it('新建的空草稿：没有名称、没有步骤', () => {
    expect(checkDraft(newDraft('手动'), cat).map((x) => x.text)).toEqual(['还没有名称', '至少要有一个步骤'])
  })

  it('必填配置按后端目录查，只有空白也算没填；类型不存在、依赖被删、挂在不存在的判断上都是错误', () => {
    const d = draft([
      step('a', 'http', [], { name: '调接口', config: { url: '  ' } }),
      step('b', 'nope', ['a']),
      step('c', 'review', ['x'], { branch: { of: 'zz', case: 'yes' } }),
    ])
    const errs = checkDraft(d, cat).filter((x) => x.level === 'error')
    expect(errs).toEqual([
      { level: 'error', text: '「调接口」还没填「地址」', step: 0 },
      { level: 'error', text: '「b」的类型 nope 不存在', step: 1 },
      { level: 'error', text: '「c」挂在一个不存在的判断上', step: 2 },
      { level: 'error', text: '「c」依赖的步骤已被删除', step: 2 },
    ])
  })

  it('分支：少于两个、没写名称是错误；分支下没有步骤、没有人工检查点、多个起点是建议', () => {
    const d = draft([
      // 有规则的判断不算人工检查点（规则留空才是人工判断）
      step('d', 'decide', [], { name: '判断', rule: 'x 等于 1', cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '' }] }),
      step('e', 'decide', [], { name: '单支', rule: 'x 等于 2', cases: [{ key: 'only', label: '唯一' }] }),
      step('f', 'auto', ['d'], { branch: { of: 'd', case: 'yes' } }),
    ])
    const out = checkDraft(d, cat)
    expect(out.filter((x) => x.level === 'error').map((x) => x.text)).toEqual(['「判断」有分支没写名称', '「单支」至少要有两个分支'])
    expect(out.filter((x) => x.level === 'warn').map((x) => x.text)).toEqual([
      '「单支」的「唯一」分支下没有步骤，选中它时流程会直接往下走',
      '整个流程没有人工检查点，执行时不会停下来让人看输出',
      '有 2 个起点，它们会在开始时同时执行',
    ])
  })

  it('后端的问题按步骤 key 记下：步骤重排后还标在原来的节点上，删掉的不再列，前端已有的不重复', () => {
    const d = draft([step('a', 'auto', ['b']), step('b', 'review', ['a'])])
    const server = serverIssuesOf([{ text: '依赖成环：「a」 → 「b」 → 「a」', step: 0 }, { text: '还没有名称' }, { text: '整条流程的问题' }], d)
    expect(server[0]).toEqual({ text: '依赖成环：「a」 → 「b」 → 「a」', key: 'a' })
    const moved = { ...d, name: '', steps: [d.steps[1], d.steps[0]] }
    const all = mergeIssues(checkDraft(moved, cat), server, moved)
    expect(all.filter((x) => x.text === '还没有名称')).toHaveLength(1)
    expect(all).toContainEqual({ level: 'error', text: '依赖成环：「a」 → 「b」 → 「a」', step: 1 })
    expect(all).toContainEqual({ level: 'error', text: '整条流程的问题' })
    const gone = removeStep(moved, 'a')
    expect(mergeIssues([], server, gone).map((x) => x.text)).toEqual(['还没有名称', '整条流程的问题'])
  })
})
