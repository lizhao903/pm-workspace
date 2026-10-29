// 块级解析挪到了 core/ui（DOC-01b），这里保留原来的导出
export { parseBlocks } from '../../core/ui/mdParse'
export type { Block } from '../../core/ui/mdParse'

import { parseBlocks } from '../../core/ui/mdParse'

/** 验收标准里的清单项，给等你验收栏勾选；没有 [ ] 写法时取所有列表项 */
export function acceptanceItems(md: string): string[] {
  const items = parseBlocks(md).flatMap((b) => (b.kind === 'list' ? b.items : []))
  const checks = items.filter((x) => x.check !== undefined)
  return (checks.length ? checks : items).map((x) => x.text).filter((t) => t.trim())
}
