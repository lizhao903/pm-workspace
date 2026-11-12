// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 复制按钮：成功后对应按钮显示「已复制」1.2 秒
import { useEffect, useRef, useState } from 'react'

const COPIED_MS = 1200

/** 复制到剪贴板，成功后对应按钮显示「已复制」1.2 秒；剪贴板不可用时没反应 */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (key: string, text: string) => {
    const done = () => {
      setCopied(key)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied((c) => (c === key ? null : c)), COPIED_MS)
    }
    navigator.clipboard?.writeText(text).then(done, () => {})
  }
  return { copied, copy }
}
