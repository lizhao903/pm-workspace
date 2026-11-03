import { describe, expect, it } from 'vitest'
import { parseBlocks } from './mdParse'

describe('Markdown 块解析', () => {
  it('认出标题、清单、代码块和段落', () => {
    const b = parseBlocks('# 标题\n\n- [ ] 未做\n- [x] 做了\n\n```\ncode\n```\n第一行\n第二行')
    expect(b).toEqual([
      { kind: 'h', level: 1, text: '标题' },
      { kind: 'list', ordered: false, items: [{ text: '未做', check: false }, { text: '做了', check: true }] },
      { kind: 'code', text: 'code' },
      { kind: 'p', text: '第一行\n第二行' },
    ])
  })
})
