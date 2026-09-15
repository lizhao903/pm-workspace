// 干系人选择器：负责人（单选）与参与人（多选）共用同一份名册。
//
// 名册一律只拉在岗的（api.stakeholders() 默认不带已归档）——
// 给已经离职的人再派活是个 bug 不是功能。已经挂在对象上的归档干系人仍要显示得出来，
// 所以下拉里会把「当前值但不在名册里」的那一个补回去并标注，否则换个状态就把人丢了。
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Stakeholder, StakeholderRef } from '../lib/types'
import { Popover, TextInput } from './ui'

// 名册里 color 为空是常态而不是边缘情况：0010 迁移建出来的人一个都没有颜色，
// 而那就是用户名册的全部。按名字哈希取一个，不取的话一列人全是同一个底色——
// 头像本来就是靠颜色先认出人的，全同色比没有头像更糟，因为它看起来像在传达信息。
//
// 用的是「颜色」色板那一套（见 views/settings/common.tsx 的 PRESET_COLORS，
// CategoryManager 与 ShortcutsPage 各自也有一份同样的字面量）：哈希出来的颜色
// 因此和用户自己能挑的颜色长得一样，而不是另造一套。
const AVATAR_COLORS = [
  '#3b5bdb', '#2b8a3e', '#b35309', '#c92a2a',
  '#7048e8', '#0c8599', '#e8590c', '#5c7cfa',
]

/**
 * djb2。同一个名字必须永远得到同一个颜色——跨刷新、跨会话、跨排序都一样，
 * 所以只能哈希名字，不能用数组下标：名册一排序颜色就全变，用户刚认熟的颜色就废了。
 */
export function stakeholderColor(name: string, color?: string): string {
  if (color) return color
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

/* ------------------------------------------------------------ 名册缓存 */

// 抽屉、列表工具条、快速捕获会同时读名册，缓存一份，写操作后由名册页调 invalidate。
let cache: Stakeholder[] | null = null
let inflight: Promise<Stakeholder[]> | null = null
const subs = new Set<() => void>()
let version = 0

/** 名册发生写操作后调用，让所有 useStakeholders 重新拉取。 */
export function invalidateStakeholders(): void {
  cache = null
  inflight = null
  version += 1
  for (const fn of subs) fn()
}

export interface StakeholderRoster {
  list: Stakeholder[]
  loading: boolean
  /** 名册为空且不在加载中：可能是还没建人，也可能是接口没上线，界面要给得出提示 */
  empty: boolean
}

/** 在岗干系人名册。 */
export function useStakeholders(): StakeholderRoster {
  const [list, setList] = useState<Stakeholder[]>(cache ?? [])
  const [loading, setLoading] = useState(cache === null)
  const [v, setV] = useState(version)

  useEffect(() => {
    const sub = () => setV(version)
    subs.add(sub)
    return () => { subs.delete(sub) }
  }, [])

  useEffect(() => {
    if (cache) { setList(cache); setLoading(false); return }
    let alive = true
    setLoading(true)
    if (!inflight) inflight = api.stakeholders()
    void inflight
      .then((rows) => { cache = rows; if (alive) setList(rows) })
      // 接口还没上线时按「名册为空」处理，不弹错误横幅：读失败不该打断正在编辑的人
      .catch(() => { inflight = null; if (alive) setList([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [v])

  return { list, loading, empty: !loading && list.length === 0 }
}

/* -------------------------------------------------------------- 展示件 */

/**
 * 名字首字的圆形头像。
 *
 * 颜色是后端数据而非主题 token，只能从内联 style 进来；但只递一个 `--sh-c`，
 * 底色/描边/深色下的提亮全交给 CSS——同一个色值在浅底和深底要读得清，
 * 需要两套推导，写在样式表里才有 data-theme 可用。
 */
export function StakeholderAvatar({ name, color, size = 18 }: {
  name: string
  color?: string
  size?: number
}) {
  return (
    <span
      className="sh-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        ['--sh-c' as string]: stakeholderColor(name, color),
      }}
    >
      {name.trim().slice(0, 1) || '?'}
    </span>
  )
}

export function StakeholderChip({ person, onRemove, title }: {
  person: StakeholderRef
  onRemove?: () => void
  title?: string
}) {
  return (
    <span className="sh-chip" title={title ?? person.name}>
      <StakeholderAvatar name={person.name} color={person.color} size={16} />
      <span className="truncate">{person.name}</span>
      {onRemove ? (
        <button type="button" className="sh-chip-x" aria-label={`移除 ${person.name}`} onClick={onRemove}>×</button>
      ) : null}
    </span>
  )
}

/* -------------------------------------------------------- 负责人：单选 */

export interface OwnerPickerProps {
  /** 当前 owner_id，未分配为 null */
  value: string | null
  /** owner_id 指向的名字。用于补出「已归档但仍挂着」的那一项 */
  valueName?: string
  /** 空串 = 清空负责人 */
  onChange: (id: string) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  className?: string
}

/**
 * 负责人下拉。一件事只有一个人对结果负责，否则「这事该找谁」没有答案。
 */
export function OwnerPicker({
  value, valueName, onChange, disabled, id, className = '', 'aria-label': ariaLabel = '负责人',
}: OwnerPickerProps) {
  const { list, loading } = useStakeholders()
  const inRoster = value !== null && list.some((s) => s.id === value)

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={`select ${className}`.trim()}
      disabled={disabled || loading}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">未分配</option>
      {/* 已归档的人不在名册里，但对象上还挂着他：补回来并标注，
          不补的话 select 会退回「未分配」，用户什么都没动负责人就丢了 */}
      {value !== null && !inRoster && !loading ? (
        <option value={value}>{valueName ? `${valueName}（已归档）` : '（已归档的干系人）'}</option>
      ) : null}
      {list.map((s) => (
        <option key={s.id} value={s.id}>{s.role ? `${s.name} · ${s.role}` : s.name}</option>
      ))}
    </select>
  )
}

/* ---------------------------------------------------------- 参与人：多选 */

export interface ParticipantPickerProps {
  value: StakeholderRef[]
  /** 全量替换语义：这里回的就是最终名单，空数组 = 清空 */
  onChange: (ids: string[]) => void
  /** 负责人已经表达了「找谁」，不该再出现在参与人里 */
  excludeId?: string | null
  disabled?: boolean
}

export function ParticipantPicker({ value, onChange, excludeId, disabled }: ParticipantPickerProps) {
  const { list, loading, empty } = useStakeholders()
  const [q, setQ] = useState('')

  const chosen = new Set(value.map((p) => p.id))
  const kw = q.trim().toLowerCase()
  const options = list.filter((s) => {
    if (s.id === excludeId) return false
    if (!kw) return true
    return s.name.toLowerCase().includes(kw) || s.role.toLowerCase().includes(kw)
  })

  const toggle = (s: Stakeholder) => {
    onChange(chosen.has(s.id)
      ? value.filter((p) => p.id !== s.id).map((p) => p.id)
      : [...value.map((p) => p.id), s.id])
  }

  return (
    <span className="v-kv-row">
      {value.map((p) => (
        <StakeholderChip
          key={p.id}
          person={p}
          onRemove={disabled ? undefined : () => onChange(value.filter((x) => x.id !== p.id).map((x) => x.id))}
        />
      ))}
      {value.length === 0 ? <span className="faint">无</span> : null}
      <Popover
        triggerClassName="btn btn-sm"
        trigger="+ 参与人"
        width={240}
        disabled={disabled || loading}
        title="参与人表达「还有谁在这件事里」，不承担「找谁」的语义"
      >
        {() => (
          <div className="v-pop-pad sh-pick">
            <TextInput autoFocus value={q} placeholder="搜名字或角色…" onValueChange={setQ} />
            <div className="v-menu sh-pick-list">
              {empty ? <div className="v-menu-empty faint">名册还没有人，去「设置 → 干系人」建一个。</div> : null}
              {!empty && options.length === 0 ? <div className="v-menu-empty faint">没有匹配的在岗干系人。</div> : null}
              {options.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`v-menu-item ${chosen.has(s.id) ? 'v-menu-item-active' : ''}`.trim()}
                  onClick={() => toggle(s)}
                >
                  <span className="sh-tick">{chosen.has(s.id) ? '✓' : ''}</span>
                  <StakeholderAvatar name={s.name} color={s.color} size={16} />
                  <span className="truncate">{s.name}</span>
                  {s.role ? <span className="faint truncate">{s.role}</span> : null}
                </button>
              ))}
            </div>
            {value.length > 0 ? (
              <button type="button" className="btn btn-ghost btn-sm sh-pick-clear" onClick={() => onChange([])}>
                清空参与人
              </button>
            ) : null}
          </div>
        )}
      </Popover>
    </span>
  )
}
