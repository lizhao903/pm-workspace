// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Agent 列表和配置页共用的小部件
import type { KeyboardEvent } from 'react'
import { IconButton, IconClose, IconSearch } from '../../../core/ui'

/** 小搜索框：列表、换模型、挂载下拉共用 */
export function MiniSearch({ value, onChange, placeholder, autoFocus, onKeyDown, full }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  autoFocus?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  full?: boolean
}) {
  return (
    <label className={full ? 'search search-sm search-full' : 'search search-sm'}>
      <IconSearch />
      <input value={value} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
      {value && <button type="button" className="search-clear" title="清空" aria-label="清空" onClick={() => onChange('')}><IconClose size={10} /></button>}
    </label>
  )
}

/** 卡片右边的叉号「卸下」 */
export const Unmount = ({ onClick, name }: { onClick: () => void; name: string }) => (
  <IconButton size="sm" label={`卸下 ${name}`} title="卸下" onClick={onClick}><IconClose size={11} /></IconButton>
)
