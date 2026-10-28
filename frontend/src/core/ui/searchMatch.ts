/** 可搜索选择器的匹配：按空格切词，每个词都要命中 label / keywords / hint 之一，不区分大小写 */
export function matchOption(o: { label: string; keywords?: string; hint?: string }, q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${o.label} ${o.keywords ?? ''} ${o.hint ?? ''}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}
