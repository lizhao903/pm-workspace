// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { AgentProvider } from '../../../core/data'
import { checkDir, embedOptions, fitOverlap, flatCategories, inFilter, kbState, markParts, parseEmbed, plain, splitChunks } from './model'

describe('切块', () => {
  it('空正文没有段；短正文一段', () => {
    expect(splitChunks('  \n', 300, 50)).toEqual([])
    expect(splitChunks('一句话', 300, 50)).toEqual([{ start: 0, end: 3 }])
  })

  it('在段长 60% 之后的句号处断开，相邻两段重叠', () => {
    const text = '甲'.repeat(7) + '。' + '乙'.repeat(10)
    // 段长 10：窗口 [6,10) 里第 7 位是句号，第一段到 8；重叠 3，下一段从 5 起
    expect(splitChunks(text, 10, 3)).toEqual([{ start: 0, end: 8 }, { start: 5, end: 15 }, { start: 12, end: 18 }])
  })

  it('重叠不超过段长一半；按码点算，emoji 这类字符算一个字', () => {
    expect(splitChunks('a'.repeat(10), 4, 100)).toEqual([{ start: 0, end: 4 }, { start: 2, end: 6 }, { start: 4, end: 8 }, { start: 6, end: 10 }])
    expect(splitChunks('\u{1F600}'.repeat(3), 2, 0)).toEqual([{ start: 0, end: 2 }, { start: 2, end: 3 }])
  })

  it('改段长时重叠压到一半以内', () => {
    expect(fitOverlap(200, 100)).toBe(100)
    expect(fitOverlap(200, 50)).toBe(50)
    expect(fitOverlap(100, 100)).toBe(50)
  })
})

describe('状态和筛选', () => {
  it('有失败先报失败，其次待索引，否则已索引', () => {
    expect(kbState({ failed: 2, pending: 1 }).label).toBe('2 篇失败')
    expect(kbState({ failed: 0, pending: 3 }).label).toBe('3 篇待索引')
    expect(kbState({ failed: 0, pending: 0 }).label).toBe('已索引')
  })

  it('已排除单独一栏，其余按状态', () => {
    const d = { status: 'indexed', excluded: true } as Parameters<typeof inFilter>[0]
    expect(inFilter(d, '')).toBe(true)
    expect(inFilter(d, 'excluded')).toBe(true)
    expect(inFilter(d, 'pending')).toBe(false)
  })
})

describe('挂目录', () => {
  it('去掉末尾斜杠；相对路径、挂过的拦下', () => {
    expect(checkDir(' /a/b/ ', [])).toEqual({ path: '/a/b' })
    expect(checkDir('a/b', []).error).toBe('填绝对路径，以 / 开头')
    expect(checkDir('/a/b//', [{ path: '/a/b' }]).error).toBe('这个目录已经挂上了')
  })
})

describe('检索结果', () => {
  it('去掉 Markdown 记号，按检索词切开（不分大小写）', () => {
    expect(plain('# 标题\n- **权限** 变更 `x`')).toBe('标题 权限 变更 x')
    expect(markParts('API 权限变更', ['api', '变更'])).toEqual(['', 'API', ' 权限', '变更', ''])
    expect(markParts('没有词', [])).toEqual(['没有词'])
  })
})

describe('向量化模型', () => {
  const pv = (p: Partial<AgentProvider>): AgentProvider => ({
    id: 'apv', name: 'x', kind: 'openai', base_url: '', model: '', enabled: true, is_default: false, api_key_masked: '', has_api_key: false,
    extra: {}, created_at: '', updated_at: '', ...p,
  })

  it('只列启用的、有向量化模型的服务商；DeepSeek 这类没有', () => {
    const out = embedOptions([
      pv({ id: 'a', kind: 'ollama' }), pv({ id: 'b', kind: 'openai', enabled: false }),
      pv({ id: 'c', kind: 'openai', extra: { preset: 'deepseek' } }), pv({ id: 'd', kind: 'anthropic' }),
    ])
    expect(out.map((x) => `${x.provider.id}|${x.model}`)).toEqual(['a|bge-m3', 'a|nomic-embed-text'])
    expect(parseEmbed('apv_1|BAAI/bge-m3')).toEqual({ provider_id: 'apv_1', model: 'BAAI/bge-m3' })
  })
})

it('分类树拍平带上级名字', () => {
  const c = (id: string, name: string, children: unknown[] = []) => ({ id, name, children }) as never
  expect(flatCategories([c('a', '产品', [c('b', 'PRD')]), c('d', '会议')])).toEqual([
    { id: 'a', label: '产品' }, { id: 'b', label: '产品 / PRD' }, { id: 'd', label: '会议' },
  ])
})
