// 内网域名分节的小部件：要用户自己执行的命令块、失焦才保存的输入框
import { useState, type ComponentProps, type ReactNode } from 'react'
import { Button, cls } from '../../core/ui'

/** 要用户自己执行的命令（多半要 sudo），整块可复制 */
export function Commands({ id, title = '要你自己执行的命令', commands, copied, onCopy }: {
  id: string
  title?: ReactNode
  commands: readonly string[]
  copied: string | null
  onCopy: (key: string, text: string) => void
}) {
  if (!commands.length) return null
  const text = commands.join('\n')
  return (
    <div className="dm-cmds">
      <div className="dm-cmds-head">
        <span>{title}</span>
        <Button size="sm" variant="outline" onClick={() => onCopy(id, text)}>{copied === id ? '已复制' : '复制命令'}</Button>
      </div>
      <pre className="dm-pre">{text}</pre>
    </div>
  )
}

/**
 * 输入框：编辑时只改本地草稿，失焦或回车才交给 onCommit；没在编辑时显示后端的值。
 * normalize 在每次输入时整理（去空白、转小写），invalid 决定红框，不合法的不提交；Esc 放弃草稿
 */
export function CommitInput({ value, onCommit, onDraft, normalize, invalid, className, ...rest }: Omit<ComponentProps<'input'>, 'value' | 'onChange'> & {
  value: string
  onCommit: (v: string) => unknown
  /** 草稿变了（null 是不在编辑），给外面跟着显示提示用 */
  onDraft?: (v: string | null) => void
  normalize?: (v: string) => string
  invalid?: (v: string) => boolean
}) {
  const [draft, setDraftState] = useState<string | null>(null)
  const setDraft = (v: string | null) => { setDraftState(v); onDraft?.(v) }
  const shown = draft ?? value
  const bad = invalid?.(shown) ?? false
  // 不合法的留着草稿和红框，等用户改；合法的存好后回到显示后端的值，存失败留着草稿
  const commit = () => {
    if (draft === null || bad) return
    if (draft === value) return setDraft(null)
    Promise.resolve(onCommit(draft)).then(() => setDraft(null), () => {})
  }
  return (
    <input
      {...rest}
      className={cls(className, bad && 'bad')}
      aria-invalid={bad || undefined}
      value={shown}
      spellCheck={false}
      onChange={(e) => setDraft(normalize ? normalize(e.target.value) : e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}
