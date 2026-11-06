// 路径输入（照原型 PathInput）：带文件夹图标、等宽，可以手填。
// 「选择」和任务抽屉的工作目录一样走后端的 /api/fs/browse 选目录，拿到的是绝对路径；
// 原型用浏览器的目录选择器只能拿到目录名，正式产品不用它。
import { useEffect, useState } from 'react'
import { useWorkdirCheck } from '../../core/data'
import { DirPicker } from '../../core/ui/DirPicker'

const CHECK_DELAY = 400

const FolderIcon = () => (
  <svg className="pj-path-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
)

export function PathInput({ value, onChange, placeholder, label, check, checkAs, pickAs, start }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** 输入框的无障碍名 */
  label: string
  /** 停手后校验目录在不在，不在时提示「找不到这个目录」（仍允许保存） */
  check?: boolean
  /** 校验的是哪个路径，默认就是输入框里的（相对路径接到项目目录后面再查时传，TSK-0718） */
  checkAs?: (v: string) => string
  /** 选好目录后填进输入框的值，默认就是目录本身（选文件时填「目录/」再补文件名） */
  pickAs?: (dir: string) => string
  /** 选目录从哪开始，默认输入框里的路径 */
  start?: string
}) {
  const [picking, setPicking] = useState(false)
  const target = (checkAs ? checkAs(value) : value).trim()
  const [checked, setChecked] = useState(target)
  useEffect(() => {
    const p = target
    if (p === checked) return
    const id = setTimeout(() => setChecked(p), CHECK_DELAY)
    return () => clearTimeout(id)
  }, [target, checked])
  const res = useWorkdirCheck(check ? checked : '')
  const missing = !!check && !!checked && checked === target && !!res.data && !(res.data.exists && res.data.is_dir)

  return (
    <div className="pj-path">
      <span className="pj-path-box">
        <FolderIcon />
        <input value={value} placeholder={placeholder} spellCheck={false} aria-label={label} aria-invalid={missing || undefined}
          onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="pj-path-pick" aria-expanded={picking} title="在本机目录里挑一个" onClick={() => setPicking(!picking)}>
          {picking ? '收起' : '选择'}
        </button>
      </span>
      {missing && <span className="field-err">找不到这个目录{target !== value.trim() && `：${target}`}</span>}
      {picking && <DirPicker start={start ?? value.trim()} onPick={(p) => { onChange(pickAs ? pickAs(p) : p); setPicking(false) }} onClose={() => setPicking(false)} />}
    </div>
  )
}
