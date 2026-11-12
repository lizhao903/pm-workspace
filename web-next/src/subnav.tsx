// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { Fragment, useState, type ReactNode } from 'react'
import { cls } from './ui'

export interface SubnavItem<K extends string> {
  key: K
  label: string
  desc?: string
  /** 异常数，红底 */
  alert?: number
  /** 分组名；和上一项不同时在它前面插一个小标题 */
  group?: string
  title?: string
  /** 菜单项前面的小图标，比如项目标志 */
  icon?: ReactNode
  /** 只用来搜、不显示的词，开了 search 才用得上 */
  keywords?: string
}

/** 菜单搜索：条目超过 min 个（默认 12）才在标题下面显示搜索框 */
export interface SubnavSearch {
  placeholder?: string
  min?: number
}

const matchItem = (s: SubnavItem<string>, words: string[]) => {
  const hay = `${s.label} ${s.desc ?? ''} ${s.group ?? ''} ${s.keywords ?? ''}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * 二级菜单：紧贴侧栏的一整栏，内容区在它右边。设置、内容都用它；children 接在菜单项最后。
 * search：传 true 或 { placeholder, min } 后，条目多于 min（默认 12）时标题下面出搜索框，
 * 按 label / desc / group / keywords 筛，分组标题跟着筛选结果走；回车打开第一条，Esc 清空。不传就是原样。
 */
export function Subnav<K extends string>({ title, items, active, onSelect, children, search }: {
  title: string
  items: SubnavItem<K>[]
  active: K
  onSelect: (k: K) => void
  children?: ReactNode
  search?: boolean | SubnavSearch
}) {
  const [q, setQ] = useState('')
  const conf = search === true ? {} : search || null
  const searchable = !!conf && items.length > (conf.min ?? 12)
  const words = searchable ? q.trim().toLowerCase().split(/\s+/).filter(Boolean) : []
  const shown = words.length ? items.filter((s) => matchItem(s, words)) : items
  return (
    <nav className="subnav">
      <div className="subnav-title">{title}</div>
      {searchable && (
        <div className="search search-sm subnav-search">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input value={q} placeholder={conf?.placeholder ?? `搜索${title}`} aria-label={`搜索${title}菜单`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) onSelect(shown[0].key)
              if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') }
            }} />
          {q && <button type="button" className="search-clear" title="清空" onClick={() => setQ('')}><svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button>}
        </div>
      )}
      {words.length > 0 && !shown.length && <div className="subnav-hint">没有匹配的菜单项</div>}
      {shown.map((s, i) => (
        <Fragment key={s.key}>
          {s.group && s.group !== shown[i - 1]?.group && <div className="subnav-group">{s.group}</div>}
          <button className={cls('subnav-item', active === s.key && 'active')} title={s.title} onClick={() => onSelect(s.key)}>
            {s.icon}
            <span className="subnav-text">
              <span className="ellipsis">{s.label}</span>
              {s.desc && <span className="subnav-desc ellipsis">{s.desc}</span>}
            </span>
            {/* 菜单上不放数量；有异常或等人处理的给个红点，数量在 title 里 */}
            {!!s.alert && <span className="side-dot" title={`${s.alert} 项需要处理`} />}
          </button>
        </Fragment>
      ))}
      {/* 菜单底部的操作（新建等）放进吸底栏，高度和一级菜单底部的「设置」栏一致 */}
      {children && <div className="subnav-foot">{children}</div>}
    </nav>
  )
}
