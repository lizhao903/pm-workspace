// 弹层的焦点管理：打开时把焦点送进去，Tab 不跑出去，关掉后回到打开前的位置

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function focusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]'))
}

/** 在 root 里按 Tab 循环；返回 true 表示处理了 */
export function trapTab(root: HTMLElement, e: KeyboardEvent) {
  if (e.key !== 'Tab') return false
  const xs = focusables(root)
  if (!xs.length) { e.preventDefault(); root.focus(); return true }
  const first = xs[0], last = xs[xs.length - 1]
  const cur = document.activeElement
  if (e.shiftKey && (cur === first || !root.contains(cur))) { e.preventDefault(); last.focus(); return true }
  if (!e.shiftKey && (cur === last || !root.contains(cur))) { e.preventDefault(); first.focus(); return true }
  return false
}

/** 还原焦点：元素还在页面上才还原 */
export function restoreFocus(el: Element | null) {
  if (el instanceof HTMLElement && el.isConnected) el.focus()
}
