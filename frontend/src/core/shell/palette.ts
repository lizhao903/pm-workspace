// 命令面板的条目和过滤规则，照原型 web-next/src/palette.tsx

export interface PaletteItem {
  id: string
  group: string
  title: string
  sub?: string
  // 额外参与搜索的词，不显示
  keywords?: string
  run: () => void
}

// 快捷键提示里的修饰键：苹果设备是 ⌘，其余是 Ctrl
export function modKey(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl '
}

// 没输入时只显示这几组，免得一打开就是一长串
export const IDLE_GROUPS: readonly string[] = ['操作', '跳转']
const MAX_PER_GROUP = 6
const MAX_IDLE = 20

// 按空格切词，每个词都要命中标题、副标题、关键词或组名；标题开头命中第一个词的排前面；
// 同组的条目排在一起，组按第一次出现的顺序
export function filterPalette(items: readonly PaletteItem[], q: string): PaletteItem[] {
  const kw = q.trim().toLowerCase()
  const words = kw.split(/\s+/).filter(Boolean)
  const pool = words.length
    ? items.filter((x) => {
      const hay = `${x.title} ${x.sub ?? ''} ${x.keywords ?? ''} ${x.group}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    : items.filter((x) => IDLE_GROUPS.includes(x.group))
  const ranked = words.length
    ? [...pool].sort((a, b) => Number(!a.title.toLowerCase().startsWith(words[0])) - Number(!b.title.toLowerCase().startsWith(words[0])))
    : pool
  const groups = [...new Set(ranked.map((x) => x.group))]
  return groups.flatMap((g) => ranked.filter((x) => x.group === g).slice(0, words.length ? MAX_PER_GROUP : MAX_IDLE))
}
