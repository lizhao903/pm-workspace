// 列表行内联编辑：状态 / 优先级 / 负责人点开即改，不必开详情抽屉。
//
// 可选值一律来自配置数据，不写死在这里：
//   状态   —— object_types[type_id].statuses，按类型分套（需求和待办不是一套）
//   优先级 —— priority 字典（0005_dictionaries），用户去设置里加 P4 这里当场就有
//   负责人 —— 干系人名册，复用 StakeholderPicker 的 useStakeholders 缓存
// 写死任何一份，都会在用户改了配置之后当场过时。
//
// 提交由调用方负责（它才知道怎么做乐观更新与回滚），这里只负责「选出一个值」。
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react'
import { api } from '../lib/api'
import type { DictItem, Status } from '../lib/types'
import { ColorDot, PRIORITIES, Popover, PriorityTag, StatusPill, TextInput } from './ui'
import { StakeholderAvatar, useStakeholders } from './StakeholderPicker'

/* -------------------------------------------------------- 优先级：取自字典 */

export interface PriorityOption {
  key: string
  label: string
  color: string
}

// 字典是全局的、极少变，整个应用共用一份缓存，不让每一行各发一次请求。
let prioCache: PriorityOption[] | null = null
let prioInflight: Promise<DictItem[]> | null = null
const prioSubs = new Set<() => void>()
let prioVersion = 0

/** 优先级字典改动后调用，让所有 usePriorityOptions 重新拉取。 */
export function invalidatePriorityOptions(): void {
  prioCache = null
  prioInflight = null
  prioVersion += 1
  for (const fn of prioSubs) fn()
}

// 字典读不到时的兜底。不是「正确答案」，只是让下拉不至于是空的——
// 空下拉会让用户以为功能坏了，而实际只是一次请求失败。
const FALLBACK_PRIORITIES: PriorityOption[] = PRIORITIES.map((p) => ({ key: p, label: '', color: '' }))

/** 在用的优先级选项（已停用的不出现在下拉里，历史数据上的仍照常显示）。 */
export function usePriorityOptions(): PriorityOption[] {
  const [items, setItems] = useState<PriorityOption[]>(prioCache ?? FALLBACK_PRIORITIES)
  const [v, setV] = useState(prioVersion)

  useEffect(() => {
    const sub = () => setV(prioVersion)
    prioSubs.add(sub)
    return () => { prioSubs.delete(sub) }
  }, [])

  useEffect(() => {
    if (prioCache) { setItems(prioCache); return }
    let alive = true
    // 不传 includeArchived：停用的枚举值不该再被选中，但已经落在数据上的仍要显示
    if (!prioInflight) prioInflight = api.dictItems('priority')
    void prioInflight
      .then((rows) => {
        const opts = [...rows]
          .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
          .map((r) => ({ key: r.key, label: r.label, color: r.color }))
        if (opts.length === 0) return // 字典被清空过，退回兜底而不是给一个空下拉
        prioCache = opts
        if (alive) setItems(opts)
      })
      .catch(() => { prioInflight = null })
    return () => { alive = false }
  }, [v])

  return items
}

/* ------------------------------------------------------------ 内联单元格 */

/**
 * 菜单容器：打开时把焦点收进来，上下键在选项间移动。
 * Esc 由 Popover 在捕获阶段统一处理，Enter 就是按钮的原生行为，这里不重复实现。
 */
function Menu({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 优先落在当前值上：用户多半是想换成邻近的一档，从当前值起步比从头起步少按几次
    const target = el.querySelector<HTMLElement>('[data-active="true"]')
      ?? el.querySelector<HTMLElement>('button:not([disabled])')
    target?.focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const el = ref.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (items.length === 0) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown'
      ? items[(i + 1 + items.length) % items.length]
      : items[(i - 1 + items.length) % items.length]
    next.focus()
  }

  return (
    <div className={`v-menu ${className}`.trim()} ref={ref} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

interface InlineCellProps {
  /** 当前值的展示，就是不编辑时单元格里原本长的样子 */
  label: ReactNode
  title: string
  width: number
  /** 提交中：压暗并挡住再次点击，避免同一行连点打出两个并发 PATCH */
  busy?: boolean
  /** 不可编辑（回收站、类型没配状态……）时退回纯展示，不给可点的假象 */
  readOnly?: boolean
  children: (close: () => void) => ReactNode
}

/**
 * 可点开改的单元格。
 * 行本身 onClick 会选中并打开抽屉，这里必须吃掉冒泡——
 * 否则「就地改」每点一次都顺带弹出抽屉，正是要省掉的那一步。
 */
export function InlineCell({ label, title, width, busy, readOnly, children }: InlineCellProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // 关闭后把焦点还给触发器，否则键盘用户改完一个值就掉回 body，得重新 Tab 回来
  const wrapClose = useCallback((close: () => void) => () => {
    close()
    wrapRef.current?.querySelector('button')?.focus()
  }, [])

  if (readOnly) return <span className="v-inline-static">{label}</span>

  return (
    <div
      className="v-inline-wrap"
      ref={wrapRef}
      onClick={(e) => e.stopPropagation()}
    >
      <Popover
        triggerClassName={`v-inline ${busy ? 'v-inline-busy' : ''}`.trim()}
        trigger={label}
        title={title}
        width={width}
        disabled={busy}
        align="left"
      >
        {(close) => children(wrapClose(close))}
      </Popover>
    </div>
  )
}

/* ---------------------------------------------------------------- 状态 */

export interface StatusCellProps {
  value: string
  /** 当前行所属类型的状态集，调用方按 type_id 取 */
  statuses: Status[]
  busy?: boolean
  readOnly?: boolean
  /** 终态会带上完成时间，鼠标悬停时如实给出来 */
  completedAt?: string | null
  onPick: (s: Status) => void
}

export function StatusCell({ value, statuses, busy, readOnly, completedAt, onPick }: StatusCellProps) {
  const cur = statuses.find((s) => s.key === value) ?? null
  const pill = <StatusPill status={cur} fallback={value || '—'} />
  // 类型没配状态时没有合法选项，给个可点的空菜单等于骗人
  const locked = readOnly || statuses.length === 0

  return (
    <InlineCell
      label={pill}
      title={locked ? (cur?.label ?? value) : '点击改状态'}
      width={180}
      busy={busy}
      readOnly={locked}
    >
      {(close) => (
        <Menu>
          {statuses.map((s) => (
            <button
              key={s.key}
              type="button"
              data-active={s.key === value}
              className={`v-menu-item ${s.key === value ? 'v-menu-item-active' : ''}`.trim()}
              onClick={() => { close(); onPick(s) }}
            >
              <ColorDot color={s.color} />
              <span className="truncate">{s.label}</span>
              {/* 终态要标出来：改成终态会落完成时间，是一次比换个中间态更重的动作 */}
              {s.terminal ? <span className="faint v-inline-hint">终态</span> : null}
            </button>
          ))}
          {completedAt ? (
            <div className="v-menu-empty faint">当前已完成，改成非终态会清掉完成时间</div>
          ) : null}
        </Menu>
      )}
    </InlineCell>
  )
}

/* -------------------------------------------------------------- 优先级 */

export interface PriorityCellProps {
  value: string
  options: PriorityOption[]
  busy?: boolean
  readOnly?: boolean
  onPick: (key: string) => void
}

export function PriorityCell({ value, options, busy, readOnly, onPick }: PriorityCellProps) {
  return (
    <InlineCell
      label={<PriorityTag value={value} />}
      title={readOnly ? value : '点击改优先级'}
      width={160}
      busy={busy}
      readOnly={readOnly}
    >
      {(close) => (
        <Menu>
          {options.map((p) => (
            <button
              key={p.key}
              type="button"
              data-active={p.key === value}
              className={`v-menu-item ${p.key === value ? 'v-menu-item-active' : ''}`.trim()}
              onClick={() => { close(); onPick(p.key) }}
            >
              <PriorityTag value={p.key} />
              {p.label ? <span className="faint truncate">{p.label}</span> : null}
            </button>
          ))}
          <div className="v-menu-sep" />
          <button
            type="button"
            data-active={value === ''}
            className={`v-menu-item ${value === '' ? 'v-menu-item-active' : ''}`.trim()}
            onClick={() => { close(); onPick('') }}
          >
            <span className="faint">不设优先级</span>
          </button>
        </Menu>
      )}
    </InlineCell>
  )
}

/* -------------------------------------------------------------- 负责人 */

export interface OwnerMenuProps {
  /** 当前 owner_id；未选为 null */
  value: string | null
  /** owner_id 对应的名字，用于补出「已归档但仍挂着」的那一项 */
  valueName?: string
  /** 空串 = 清空 / 不限；由调用方译成 owner_id 或筛选条件 */
  onPick: (id: string) => void
  /** 空值那一项的文案：编辑时是「未分配」，筛选时是「全部」 */
  emptyLabel?: string
  /** 名册为空时的引导语尾巴，筛选场景不需要「去建一个」 */
  hideEmptyHint?: boolean
  /** 每个人后面带上他名下的对象数。派活时是「谁手上满了」，筛选时是「点下去大概有多少」 */
  showCounts?: boolean
}

/**
 * 干系人单选菜单。行内编辑、批量改、工具条筛选三处共用同一个——
 * 各写一份的话，「已归档的人要不要列出来」这种判断迟早会在某一处写反。
 */
export function OwnerMenu({
  value, valueName, onPick, emptyLabel = '未分配', hideEmptyHint, showCounts,
}: OwnerMenuProps) {
  const { list, loading, empty } = useStakeholders()
  const [q, setQ] = useState('')

  const kw = q.trim().toLowerCase()
  const options = useMemo(() => (kw
    ? list.filter((s) => s.name.toLowerCase().includes(kw) || s.role.toLowerCase().includes(kw))
    : list), [list, kw])

  // 名册只回在岗的人；对象上挂着的若已归档，补一条回去并标注。
  // 不补的话用户一打开菜单就看不到当前值，会以为负责人已经没了。
  const archivedCurrent = value !== null && value !== '' && !loading && !list.some((s) => s.id === value)

  return (
    <div className="v-pop-pad v-inline-owner">
      <TextInput
        autoFocus
        value={q}
        placeholder="搜名字或角色…"
        aria-label="搜索干系人"
        onValueChange={setQ}
        onKeyDown={(e) => {
          // Enter 直接落在唯一/第一个匹配上：搜到这一步再让人按方向键是多余的
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (options.length > 0) onPick(options[0].id)
        }}
      />
      <Menu className="v-inline-owner-list">
        <button
          type="button"
          data-active={value === null || value === ''}
          className={`v-menu-item ${value === null || value === '' ? 'v-menu-item-active' : ''}`.trim()}
          onClick={() => onPick('')}
        >
          <span className="faint">{emptyLabel}</span>
        </button>
        {archivedCurrent ? (
          <button
            type="button"
            data-active
            className="v-menu-item v-menu-item-active"
            onClick={() => onPick(value)}
          >
            <StakeholderAvatar name={valueName || '?'} size={16} />
            <span className="truncate">{valueName || '（已归档的干系人）'}</span>
            <span className="faint v-inline-hint">已归档</span>
          </button>
        ) : null}
        {loading ? <div className="v-menu-empty faint">名册加载中…</div> : null}
        {empty && !hideEmptyHint ? (
          <div className="v-menu-empty faint">名册还没有人，去「设置 → 干系人」建一个。</div>
        ) : null}
        {!loading && !empty && options.length === 0 ? (
          <div className="v-menu-empty faint">没有匹配的在岗干系人。</div>
        ) : null}
        {options.map((s) => (
          <button
            key={s.id}
            type="button"
            data-active={s.id === value}
            className={`v-menu-item ${s.id === value ? 'v-menu-item-active' : ''}`.trim()}
            onClick={() => onPick(s.id)}
          >
            <StakeholderAvatar name={s.name} color={s.color} size={16} />
            <span className="truncate">{s.name}</span>
            {s.role ? <span className="faint truncate">{s.role}</span> : null}
            {/* 这个数来自名册，是**全局**的「他名下有多少对象」，不随当前作用域和筛选条件变。
                所以只敢当参考量摆在这儿，不敢说成「点下去会出几条」——
                在需求池里点一个名下 6 项的人，出来 3 条是正常的，那 6 里有 3 条是待办。
                这个项目已经在徽标口径上栽过一次，宁可把话说小。 */}
            {showCounts ? (
              <span className="badge v-owner-count" title={`名册里记的：名下共 ${s.owned_count} 个工作对象（不随当前筛选变化）`}>
                {s.owned_count}
              </span>
            ) : null}
          </button>
        ))}
      </Menu>
    </div>
  )
}

export interface OwnerCellProps {
  value: string | null
  /** 展示名：owner_id 指向的干系人名字，没有则回退到 0010 之前的自由文本 */
  display: string
  busy?: boolean
  readOnly?: boolean
  onPick: (id: string) => void
}

export function OwnerCell({ value, display, busy, readOnly, onPick }: OwnerCellProps) {
  return (
    <InlineCell
      label={display
        ? <span className="v-inline-owner-name truncate">{display}</span>
        : <span className="faint">未分配</span>}
      title={readOnly ? display : '点击改负责人'}
      width={230}
      busy={busy}
      readOnly={readOnly}
    >
      {(close) => (
        <OwnerMenu
          value={value}
          valueName={display}
          onPick={(id) => { close(); onPick(id) }}
        />
      )}
    </InlineCell>
  )
}
