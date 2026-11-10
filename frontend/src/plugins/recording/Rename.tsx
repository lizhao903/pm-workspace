// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 行内改标题：铅笔 → 输入框 → PATCH；回车/失焦保存，Esc 取消。
// 列表行和详情页标题共用：非编辑态可以把标题做成按钮（onOpen 传了才包按钮），编辑态三个控件并排。
import { useRef, useState } from 'react'
import { errorText, usePatchRecording } from '../../core/data'
import { Button, Input, cls } from '../../core/ui'

/** 小铅笔图标（core/ui 没有，自己画一个，16px 线稿） */
export function IconPencil() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.3 2.2 13.8 4.7 5.6 12.9 2.6 13.4l.5-3z" />
      <path d="M9.6 3.9l2.5 2.5" />
    </svg>
  )
}

const MAX_TITLE = 200

export function InlineRename({ id, title, className, onOpen, onError, onSaved }: {
  id: string
  title: string
  /** 标题额外的 class（详情页标题字大一些） */
  className?: string
  /** 非编辑态把标题包成按钮，点了进详情（列表行用） */
  onOpen?: () => void
  onError?: (message: string) => void
  onSaved?: () => void
}) {
  const patch = usePatchRecording()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  /** Esc / 取消后失焦不要再保存一次 */
  const cancelRef = useRef(false)

  const fail = (message: string) => {
    setError(message)
    onError?.(message)
  }

  const start = () => {
    setDraft(title)
    setError('')
    setEditing(true)
  }

  const close = () => {
    setEditing(false)
    setError('')
  }

  const save = () => {
    if (cancelRef.current) {
      cancelRef.current = false
      return
    }
    const text = draft.trim()
    if (!text || text === title) {
      close()
      return
    }
    if (text.length > MAX_TITLE) {
      fail(`标题最多 ${MAX_TITLE} 字`)
      return
    }
    setError('')
    patch.mutate({ id, patch: { title: text } }, {
      onSuccess: () => {
        close()
        onSaved?.()
      },
      onError: (e) => fail(`没保存：${errorText(e)}`),
    })
  }

  if (!editing) {
    const body = <span className={cls('rec-rename-title', className)}>{title || '未命名录音'}</span>
    return (
      <span className="rec-rename">
        {onOpen
          ? <button type="button" className="rec-rename-open" onClick={onOpen}>{body}</button>
          : body}
        <button type="button" className="rec-rename-btn" aria-label="重命名" title="重命名" onClick={start}>
          <IconPencil />
        </button>
      </span>
    )
  }

  return (
    <span className="rec-rename editing">
      <Input className="rec-rename-input" aria-label="新标题" autoFocus value={draft} invalid={!!error}
        maxLength={MAX_TITLE + 20}
        onChange={(e) => { setDraft(e.target.value); setError(''); onError?.('') }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelRef.current = true
            close()
          }
        }}
        onBlur={save} />
      <Button size="sm" variant="primary" disabled={patch.isPending}
        onMouseDown={(e) => e.preventDefault()} onClick={save}>{patch.isPending ? '保存中…' : '保存'}</Button>
      <Button size="sm" onMouseDown={(e) => e.preventDefault()}
        onClick={() => { cancelRef.current = true; close() }}>取消</Button>
      {error && <span className="rec-rename-err" role="alert">{error}</span>}
    </span>
  )
}
