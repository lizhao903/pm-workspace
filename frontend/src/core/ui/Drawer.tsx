// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cls } from './cls'
import { ConfirmDialog } from './ConfirmDialog'
import { focusables, restoreFocus } from './focus'
import { DrawerHostContext } from './hostContext'
import { IconClose } from './icons'

/** footer 可以是函数，拿到 requestClose 给自己的「取消」按钮用，这样也会走未保存确认 */
type DrawerFooter = ReactNode | ((requestClose: () => void) => ReactNode)

/**
 * 右侧抽屉，结构照原型 .drawer：头部（kicker + 关闭）、可滚动的正文、底部操作栏。
 * - Esc、关闭按钮都走 requestClose；dirty 为 true 时先弹确认，确认放弃才真的 onClose。
 * - 打开时焦点进入抽屉（正文里的 autoFocus 优先，其次第一个可聚焦元素，都没有就是抽屉本身），
 *   关闭后回到打开前的元素（一般就是触发它的按钮）。
 * - 抽屉里的弹层（SearchSelect、确认弹窗）自己吃掉的 Esc 不会关抽屉。
 * - 在外壳里时送进外壳的抽屉位置：宽屏停靠在内容右边、内容跟着收窄，1100px 以下浮在内容上面；
 *   外壳外（单独演示）挂在 body 上浮着。
 */
export function Drawer(props: {
  open: boolean
  onClose: () => void
  /** 头部左上角的小字：编号、「新建任务」 */
  kicker?: ReactNode
  /** 头部右侧、关闭按钮前的额外操作 */
  headActions?: ReactNode
  /** 有未保存的改动 */
  dirty?: boolean
  /** 未保存确认的说明 */
  dirtyMessage?: ReactNode
  'aria-label'?: string
  className?: string
  /** 正文不要默认内边距（自己排版） */
  flush?: boolean
  children?: ReactNode
  footer?: DrawerFooter
}) {
  if (!props.open) return null
  return <DrawerPanel {...props} />
}

function DrawerPanel({ onClose, kicker, headActions, dirty, dirtyMessage, className, flush, children, footer, ...rest }: Parameters<typeof Drawer>[0]) {
  const ref = useRef<HTMLElement>(null)
  const [confirming, setConfirming] = useState(false)
  // 渲染时就记下打开前的焦点：正文里的 autoFocus 在 effect 之前就会抢走焦点
  const [prev] = useState(() => document.activeElement)
  const id = useId()
  const host = useContext(DrawerHostContext)

  const requestClose = () => {
    if (dirty) setConfirming(true)
    else onClose()
  }
  // Esc 监听只挂一次，requestClose 走 ref 拿最新的 dirty
  const closeRef = useRef(requestClose)
  useEffect(() => { closeRef.current = requestClose })

  useEffect(() => {
    const el = ref.current
    if (el && !el.contains(document.activeElement)) {
      const body = el.querySelector<HTMLElement>('.drawer-body')
      const first = body ? focusables(body)[0] : undefined
      ;(first ?? el).focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restoreFocus(prev)
    }
  }, [prev])

  return createPortal(
    <>
      <aside ref={ref} className={cls('drawer', className)} role="dialog" aria-modal="false" tabIndex={-1}
        aria-label={rest['aria-label']} aria-labelledby={rest['aria-label'] ? undefined : `${id}-k`}>
        <div className="drawer-head">
          <span className="drawer-kicker ellipsis" id={`${id}-k`}>{kicker}</span>
          <div className="spacer" />
          {headActions}
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="关闭" title="关闭 (Esc)">
            <IconClose />
          </button>
        </div>
        <div className={cls('drawer-body', flush && 'drawer-body-flush')}>{children}</div>
        {footer !== undefined && footer !== null && (
          <div className="drawer-foot">{typeof footer === 'function' ? footer(requestClose) : footer}</div>
        )}
      </aside>
      <ConfirmDialog open={confirming} danger title="放弃未保存的改动？" confirmLabel="放弃改动" cancelLabel="继续编辑"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); onClose() }}>
        {dirtyMessage ?? '关闭后，这次填写的内容不会保存。'}
      </ConfirmDialog>
    </>,
    host ?? document.body,
  )
}
