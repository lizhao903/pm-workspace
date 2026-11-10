// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置页六个二级页共用的小件。类名一律 st- 前缀，样式在 ../../settings.css。
import { useCallback, useState, type ReactNode } from 'react'
import { ApiError } from '../../lib/api'

// 预设色是写进后端数据的**字面量**（落在 object_types.color / dict_items.color 里），
// 不是主题 token，所以只能硬编码。与 CategoryManager 的一套保持一致。
export const PRESET_COLORS = [
  '#3b5bdb', '#2b8a3e', '#b35309', '#c92a2a',
  '#7048e8', '#0c8599', '#e8590c', '#5c7cfa',
]

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

/** 每页顶部：标题 + 一句话说明这一页管什么，右侧放主操作。 */
export function SectionHead({ title, desc, actions }: {
  title: string
  desc: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="st-sec-head">
      <div className="st-sec-text">
        <h2 className="st-sec-title">{title}</h2>
        <p className="st-sec-desc">{desc}</p>
      </div>
      {actions ? <div className="st-sec-actions">{actions}</div> : null}
    </div>
  )
}

export function Swatches({ value, onChange, disabled }: {
  value: string
  onChange: (c: string) => void
  disabled?: boolean
}) {
  // 后端数据里的色值未必来自这套预设（种子数据就不是），
  // 只渲染预设的话当前色会显得「没选中」，所以把它补在最前面。
  const extra = value && !PRESET_COLORS.includes(value) ? value : null
  return (
    <div className="v-swatches">
      {extra ? (
        <button
          type="button"
          disabled
          className="v-swatch v-swatch-on"
          style={{ background: extra }}
          title={`当前颜色 ${extra}`}
        />
      ) : null}
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          className={`v-swatch ${value === c ? 'v-swatch-on' : ''}`.trim()}
          style={{ background: c }}
          aria-label={`选择颜色 ${c}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

/** 只读字段：创建后不可改的 id / ref_prefix 用它，附一句为什么不能改。 */
export function FrozenField({ label, value, why }: { label: string; value: string; why: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="st-frozen mono">{value || '—'}</div>
      <div className="faint v-field-hint">{why}</div>
    </div>
  )
}

/** 引用计数徽标：0 引用要一眼能认出来，那通常是可以放心删的。 */
export function UsageBadge({ n, noun = '条数据' }: { n: number; noun?: string }) {
  if (n <= 0) return <span className="badge v-badge-zero" title={`未被任何${noun}引用`}>0</span>
  return <span className="badge" title={`被 ${n} ${noun}引用`}>{n}</span>
}

/**
 * 后端接口可能还没上线：加载失败一律按空态处理，不弹错误横幅。
 * 写操作的失败要显示（用户点了按钮就该知道结果），读失败不显示。
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(errText(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error, setError, run }
}
