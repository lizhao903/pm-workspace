// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 知识库页的小部件：书本图标、搜索框、来源分类标签、Agent 头像。
import { Avatar, IconClose, IconSearch } from '../../../core/ui'
import { useDocCategories } from './categories'

export const BookIcon = () => (
  <span className="kb-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
  </span>
)

export function KbSearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search search-sm kb-search">
      <IconSearch size={13} />
      <input value={value} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange('') } }} />
      {value && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => onChange('')}><IconClose size={10} /></button>}
    </div>
  )
}

export function SourceTags({ ids, empty }: { ids: string[]; empty?: string }) {
  const { label } = useDocCategories()
  if (!ids.length) return empty ? <span className="kb-muted">{empty}</span> : null
  return <span className="kb-sources">{ids.map((s) => <span key={s} className="tag">{label(s)}</span>)}</span>
}

/** 卡片上的头像：露前几个，其余收成 +N，全名在悬停里 */
const HEADS = 5
export function AgentHeads({ list }: { list: { id: string; name: string }[] }) {
  if (!list.length) return <span className="kb-muted kb-nouser">没有 Agent 在用</span>
  return (
    <span className="kb-users" title={list.map((a) => a.name).join('、')}>
      {list.slice(0, HEADS).map((a) => <Avatar key={a.id} name={a.name} size={20} title={a.name} />)}
      {list.length > HEADS && <span className="kb-users-more">+{list.length - HEADS}</span>}
    </span>
  )
}
