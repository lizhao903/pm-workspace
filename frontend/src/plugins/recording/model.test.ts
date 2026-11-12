// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import {
  LIST_FILTERS, MODEL_STATUS_TEXT, clampPct, confidencePct, confidenceTone, confirmedTodos, fileKindText, fmtBytes, fmtCreatedAt,
  fmtDuration, fmtMB, jobText, layoutFlow, lowConfidenceTodos, matchesFilter, mediaErrorText, minutesThreshold, pendingTodos,
  recordingPath, speakerColor, speakerDisplayName, speakerIndex, speakerMap, speakerSimilarityPct, statusText, statusTone,
  todoKindText, todoObjectPath, todoStatusText, treeRows, wrapLabel, type ListFilter,
} from './model'

describe('录音转写页的纯函数', () => {
  it('fmtDuration：分:秒，超过一小时带小时', () => {
    expect(fmtDuration(0)).toBe('0:00')
    expect(fmtDuration(999)).toBe('0:00')
    expect(fmtDuration(65_000)).toBe('1:05')
    expect(fmtDuration(59_999 + 1)).toBe('1:00')
    expect(fmtDuration(3_600_000)).toBe('1:00:00')
    expect(fmtDuration(3_723_999)).toBe('1:02:03')
    expect(fmtDuration(-1)).toBe('0:00')
    expect(fmtDuration(Number.NaN)).toBe('0:00')
  })

  it('状态文案和颜色', () => {
    expect(statusText('uploaded')).toBe('待转写')
    expect(statusText('transcribing')).toBe('转写中')
    expect(statusText('transcribed')).toBe('已转写')
    expect(statusText('failed')).toBe('失败')
    expect(statusText('unknown')).toBe('unknown')
    expect(statusTone('failed')).toBe('var(--danger)')
    expect(statusTone('transcribed')).toBe('var(--ok)')
    expect(statusTone('transcribing')).toBe('var(--warn)')
  })

  it('后台任务文案跟着状态和进度走', () => {
    expect(jobText(null)).toBe('')
    expect(jobText({ kind: 'transcribe', status: 'pending', progress: 0, attempts: 0, last_error: '' })).toBe('排队等待转写')
    expect(jobText({ kind: 'transcribe', status: 'running', progress: 41, attempts: 0, last_error: '' })).toBe('转写中 41%')
    expect(jobText({ kind: 'transcribe', status: 'running', progress: 999, attempts: 0, last_error: '' })).toBe('转写中 100%')
    expect(jobText({ kind: 'transcribe', status: 'done', progress: 100, attempts: 1, last_error: '' })).toBe('转写完成')
    expect(jobText({ kind: 'transcribe', status: 'failed', progress: 0, attempts: 3, last_error: 'x' })).toBe('转写失败')
  })

  it('fmtMB 按 MB 取整，fmtCreatedAt 用本机时区', () => {
    expect(fmtMB(487_601_967)).toBe('465 MB')
    expect(fmtMB(0)).toBe('0 MB')
    expect(fmtMB(Number.NaN)).toBe('0 MB')
    // 不带时区的时间按本地时间解析，测试里不依赖机器时区
    expect(fmtCreatedAt('2026-11-10T08:05:00')).toBe('11-10 08:05')
    expect(fmtCreatedAt('2026-01-02T03:04:05')).toBe('01-02 03:04')
    expect(fmtCreatedAt('not-a-time')).toBe('')
  })

  it('列表筛选：转写中含排队/转写中/生成纪要，已完成含已转写/已完成', () => {
    const filter = (f: ListFilter, s: string) => matchesFilter(f, s)
    expect(filter('', 'failed')).toBe(true)
    for (const s of ['uploaded', 'transcribing', 'summarizing']) expect(filter('transcribing', s)).toBe(true)
    expect(filter('transcribing', 'transcribed')).toBe(false)
    for (const s of ['transcribed', 'ready']) expect(filter('done', s)).toBe(true)
    expect(filter('done', 'failed')).toBe(false)
    expect(filter('failed', 'failed')).toBe(true)
    expect(filter('failed', 'ready')).toBe(false)
    expect(LIST_FILTERS.map((f) => f.label)).toEqual(['全部', '转写中', '已完成', '失败'])
  })

  it('进度限定 0–100 的整数', () => {
    expect(clampPct(41.6)).toBe(42)
    expect(clampPct(-5)).toBe(0)
    expect(clampPct(500)).toBe(100)
    expect(clampPct(Number.NaN)).toBe(0)
  })

  it('详情路径带转义', () => {
    expect(recordingPath()).toBe('/recording')
    expect(recordingPath('rec_abc')).toBe('/recording/rec_abc')
    expect(recordingPath('a/b c')).toBe('/recording/a%2Fb%20c')
  })

  it('麦克风错误转成中文可操作提示', () => {
    expect(mediaErrorText({ name: 'NotAllowedError' })).toContain('权限被拒绝')
    expect(mediaErrorText({ name: 'NotFoundError' })).toContain('没有找到麦克风')
    expect(mediaErrorText({ name: 'NotReadableError' })).toContain('被别的程序占用')
    expect(mediaErrorText(new Error('boom'))).toContain('boom')
    expect(MODEL_STATUS_TEXT.downloading).toBe('下载中')
  })
})

describe('M4a：候选、文件、置信度', () => {
  const todo = (index: number, over: Partial<Parameters<typeof todoObjectPath>[0]> = {}) => ({
    index, kind: 'task' as const, title: `候选 ${index}`, detail: '', confidence: 0.8, status: 'pending' as const,
    project_id: '', project_title: '', object_id: '', object_ref: '', reason: '', owner_name: '', due_at: '',
    created_at: '', updated_at: '', ...over,
  })

  it('置信度百分比与颜色分档', () => {
    expect(confidencePct(0.86)).toBe(86)
    expect(confidencePct(0)).toBe(0)
    expect(confidencePct(2)).toBe(100)
    expect(confidencePct(Number.NaN)).toBe(0)
    expect(confidenceTone(0.9)).toBe('var(--ok)')
    expect(confidenceTone(0.5)).toBe('var(--warn)')
    expect(confidenceTone(0.1)).toBe('var(--faint)')
  })

  it('阈值：合法 0–1 用设置值，否则回退 0.7', () => {
    expect(minutesThreshold(0.85)).toBe(0.85)
    expect(minutesThreshold(0)).toBe(0)
    expect(minutesThreshold(1)).toBe(1)
    expect(minutesThreshold(undefined)).toBe(0.7)
    expect(minutesThreshold(1.2)).toBe(0.7)
    expect(minutesThreshold(Number.NaN)).toBe(0.7)
  })

  it('候选分组：待确认 / 已确认 / 低于阈值', () => {
    const todos = [
      todo(0, { confidence: 0.9 }),
      todo(1, { confidence: 0.3 }),
      todo(2, { status: 'confirmed', object_id: 'obj_1', object_ref: 'TSK-1' }),
      todo(3, { status: 'ignored' }),
    ]
    expect(pendingTodos(todos).map((t) => t.index)).toEqual([0, 1])
    expect(confirmedTodos(todos).map((t) => t.index)).toEqual([2])
    expect(lowConfidenceTodos(todos, 0.7).map((t) => t.index)).toEqual([1])
    expect(todoObjectPath(todos[2])).toBe('/tasks?t=obj_1')
    expect(todoObjectPath(todos[0])).toBe('')
  })

  it('文案：候选种类/状态、待办种类、文件种类', () => {
    expect(todoKindText('project')).toBe('项目候选')
    expect(todoKindText('task')).toBe('任务候选')
    expect(todoKindText('goal')).toBe('目标候选')
    expect(todoKindText('other')).toBe('other')
    expect(todoStatusText('pending')).toBe('待确认')
    expect(todoStatusText('confirmed')).toBe('已确认')
    expect(todoStatusText('ignored')).toBe('已忽略')
    expect(fileKindText('minutes_json')).toBe('纪要 JSON')
    expect(fileKindText('diagram_flow')).toBe('流程图源码')
    expect(fileKindText('unknown_x')).toBe('unknown_x')
  })

  it('文件大小按 B/KB/MB', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(1_572_864)).toBe('1.5 MB')
    expect(fmtBytes(Number.NaN)).toBe('0 B')
  })

  it('纪要任务文案用「生成纪要」', () => {
    expect(jobText({ kind: 'summarize', status: 'pending', progress: 0, attempts: 0, last_error: '' })).toBe('排队等待生成纪要')
    expect(jobText({ kind: 'summarize', status: 'running', progress: 30, attempts: 0, last_error: '' })).toBe('生成纪要中 30%')
    expect(jobText({ kind: 'summarize', status: 'done', progress: 100, attempts: 0, last_error: '' })).toBe('生成纪要完成')
  })
})

describe('M4a：流程图布局与树形图', () => {
  it('wrapLabel 折成最多两行，超长截断', () => {
    expect(wrapLabel('现状')).toEqual(['现状'])
    expect(wrapLabel('一二三四五六七八九十一二三四')).toEqual(['一二三四五六七八九十一二三四'])
    expect(wrapLabel('一二三四五六七八九十一二三四五六')).toEqual(['一二三四五六七八九十一二三四', '五六'])
    expect(wrapLabel('一二三四五六七八九十一二三四五六七八九十一')).toEqual(['一二三四五六七八九十一二三四', '五六七八九十一'])
    expect(wrapLabel('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十')).toEqual(['一二三四五六七八九十一二三四', '五六七八九十一二三四五六七…'])
    expect(wrapLabel('   ')).toEqual([''])
  })

  it('layoutFlow：分层、坐标、边和坏数据清洗', () => {
    const flow = layoutFlow({
      title: '讨论脉络',
      nodes: [
        { id: 'n1', label: '现状', kind: 'start' },
        { id: 'n2', label: '要不要做', kind: 'decision' },
        { id: 'n3', label: '结论', kind: 'end' },
        { id: 'n1', label: '重复 id', kind: 'process' },
      ],
      edges: [
        { from: 'n1', to: 'n2', label: '提问' },
        { from: 'n2', to: 'n3', label: '' },
        { from: 'n2', to: 'missing', label: '坏边' },
        { from: 'n3', to: 'n3', label: '自环' },
      ],
    })
    expect(flow).not.toBeNull()
    if (!flow) return
    expect(flow.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(flow.nodes[0].kind).toBe('start')
    expect(flow.nodes[1].kind).toBe('decision')
    expect(flow.nodes[0].x).toBeLessThan(flow.nodes[1].x)
    expect(flow.nodes[1].x).toBeLessThan(flow.nodes[2].x)
    expect(flow.nodes[0].lines).toEqual(['现状'])
    expect(flow.edges).toHaveLength(2)
    expect(flow.width).toBeGreaterThan(0)
    expect(flow.height).toBeGreaterThan(0)
  })

  it('layoutFlow：空/坏数据返回 null，节点最多 10 个', () => {
    expect(layoutFlow(null)).toBeNull()
    expect(layoutFlow(undefined)).toBeNull()
    expect(layoutFlow({ title: '', nodes: [], edges: [] })).toBeNull()
    expect(layoutFlow({ title: '', nodes: [null, 1, {}, { id: '' }] as never, edges: [] })).toBeNull()
    const ten = layoutFlow({
      title: '',
      nodes: Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, label: `节点${i}`, kind: 'process' })),
      edges: [],
    })
    expect(ten?.nodes).toHaveLength(10)
  })

  it('treeRows：深度最多 3 层、每层最多 8 个、坏数据丢弃', () => {
    const rows = treeRows({
      title: '项目树',
      root: {
        label: '会议', children: [
          { label: '项目 A', children: [{ label: '任务 A1', children: [{ label: '太深', children: [] }] }] },
          { label: '项目 B', children: [] },
          ...Array.from({ length: 10 }, (_, i) => ({ label: `候选 ${i}`, children: [] })),
          { label: '   ', children: [] },
        ],
      },
    })
    expect(rows[0]).toEqual({ id: 'root', label: '会议', depth: 0, hasChildren: true })
    expect(rows.filter((r) => r.depth === 0)).toHaveLength(1)
    // 每层最多 8 个：项目 A、项目 B + 6 个候选
    expect(rows.filter((r) => r.depth === 1)).toHaveLength(8)
    expect(rows.some((r) => r.label === '太深')).toBe(false)
    expect(treeRows(null)).toEqual([])
    expect(treeRows({ title: '', root: { label: '', children: [] } })).toEqual([])
    expect(treeRows({ title: '', root: null } as never)).toEqual([])
  })
})

describe('M5：说话人颜色、显示名与映射', () => {
  it('speakerIndex 先认 spk_N，非标准 label 用稳定哈希', () => {
    expect(speakerIndex('spk_1')).toBe(0)
    expect(speakerIndex('spk_12')).toBe(11)
    expect(speakerIndex(' spk_3 ')).toBe(2)
    expect(speakerIndex('guest')).toBe(speakerIndex('guest'))
    expect(speakerIndex('guest')).toBeGreaterThanOrEqual(0)
  })

  it('speakerColor 同 label 同色，按序号循环调色板', () => {
    expect(speakerColor('spk_1')).toBe('var(--accent)')
    expect(speakerColor('spk_2')).toBe('var(--ok)')
    expect(speakerColor('spk_5')).toBe('#8b5cf6')
    // 8 个颜色循环：spk_9 回到第一个
    expect(speakerColor('spk_9')).toBe(speakerColor('spk_1'))
    expect(speakerColor('other')).toBe(speakerColor('other'))
  })

  it('speakerDisplayName 优先级：改名 > 联系人名 > 说话人 N', () => {
    expect(speakerDisplayName({ label: 'spk_1', name: '老王', contact_name: '张三' })).toBe('老王')
    expect(speakerDisplayName({ label: 'spk_1', name: '  ', contact_name: '张三' })).toBe('张三')
    expect(speakerDisplayName({ label: 'spk_3', name: '', contact_name: '' })).toBe('说话人 3')
    expect(speakerDisplayName({ label: 'guest', name: '', contact_name: '' })).toBe('guest')
  })

  it('speakerSimilarityPct 取整并夹到 0–100，坏值按 0', () => {
    expect(speakerSimilarityPct(0.856)).toBe(86)
    expect(speakerSimilarityPct(1)).toBe(100)
    expect(speakerSimilarityPct(0)).toBe(0)
    expect(speakerSimilarityPct(-0.4)).toBe(0)
    expect(speakerSimilarityPct(1.5)).toBe(100)
    expect(speakerSimilarityPct(Number.NaN)).toBe(0)
  })

  it('speakerMap 过滤坏数据，段落 label 能查到人', () => {
    const list = [
      { label: 'spk_1', name: '老王', contact_id: '', contact_name: '', similarity: 0, segments: 2, duration_ms: 1, detected: false },
      null,
      { label: '', name: '没有 label' },
    ] as unknown as Parameters<typeof speakerMap>[0]
    const map = speakerMap(list)
    expect(map.size).toBe(1)
    expect(map.get('spk_1')?.name).toBe('老王')
    expect(speakerMap(null).size).toBe(0)
    expect(speakerMap(undefined).size).toBe(0)
  })

  it('jobText 看任务种类：diarize 叫「说话人识别」', () => {
    expect(jobText({ kind: 'diarize', status: 'pending', progress: 0, attempts: 0, last_error: '' })).toBe('排队等待说话人识别')
    expect(jobText({ kind: 'diarize', status: 'running', progress: 40, attempts: 0, last_error: '' })).toBe('说话人识别中 40%')
    expect(jobText({ kind: 'diarize', status: 'failed', progress: 0, attempts: 0, last_error: '缺 funasr' })).toBe('说话人识别失败')
  })
})
