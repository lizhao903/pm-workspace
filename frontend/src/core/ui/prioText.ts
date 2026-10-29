/** 优先级显示名：编号 + 字典名称（「P0 紧急」）；字典没有名称或名称已带编号时不重复 */
export function prioText(key: string, item?: { label: string }) {
  const label = item?.label.trim()
  if (!label) return key
  return label === key || label.startsWith(key + ' ') ? label : `${key} ${label}`
}
