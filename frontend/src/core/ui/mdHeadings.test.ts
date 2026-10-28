import { describe, expect, it } from 'vitest'
import { mdHeadings } from './mdParse'

describe('标题导航（DOC-01b）', () => {
  it('按出现顺序编号，代码块里的 # 不算标题', () => {
    expect(mdHeadings('# 一\n正文\n```\n# 不是标题\n```\n## 二\n### 三', 'doc-h')).toEqual([
      { id: 'doc-h0', level: 1, text: '一' },
      { id: 'doc-h1', level: 2, text: '二' },
      { id: 'doc-h2', level: 3, text: '三' },
    ])
  })
})
