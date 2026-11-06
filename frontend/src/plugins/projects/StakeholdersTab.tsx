// 干系人标签（SPEC-projects-6）：人从联系人里挑，按角色顺序显示，同角色按加入顺序。
// 角色来自枚举字典 project_role（TSK-0718，设置 / 枚举值里维护，内置决策人、对接人、负责人、参与、知会）：下拉只列没停用的，
// 已停用的角色在已有干系人上照常显示名字并标「已停用」，字典里没有的旧值显示原值并标红（E-02）。
// 增删改走项目插件的 /api/projects/{id}/stakeholders。关注点边输边存（停顿一下或离开输入框就存），存不上留着输入、行内提示。
// 「最近沟通」是这个人在本项目绑定的会话里最近的一条（SPEC-projects-6.7），和沟通标签同一份项目消息；点了去 IM 消息页打开。
// 加干系人能多选（B-05）：按姓名、公司、职位、分组、标签搜，候选按姓名拼音排（同联系人页），勾好了「加 N 人」一次加进来。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, useAddProjectStakeholders, useContacts, useIdentities, usePatchProjectStakeholder, useProjectRoles, useProjectStakeholders,
  useRemoveProjectStakeholder, type Contact, type ImMessage, type ProjectRole, type ProjectRoleItem, type ProjectStakeholder,
} from '../../core/data'
import { Avatar, Button, EmptyState, ErrorState, Input, LoadingState, SearchSelect, cls } from '../../core/ui'
import { compareNames, nameInitial } from '../../core/ui/pinyin'
import { latestByContact, snippet } from './commsModel'
import { ago, roleOf, sortStakeholders } from './model'
import { useProjectMessages } from './projectMessages'

/** 关注点停顿多久后保存 */
const FOCUS_DELAY = 600
const MESSAGES_PATH = '/messages'
/** 加干系人下拉一次最多列多少人；联系人通常几十个，全列出来方便连着勾 */
const PICK_LIMIT = 500

/** 「最近沟通」列：有消息时是「相对时间 · 正文前 14 字」，否则说明为什么没有 */
type LastComm = { msg: ImMessage } | { note: string }

export function StakeholdersTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const stakes = useProjectStakeholders(projectId)
  const contacts = useContacts()
  const add = useAddProjectStakeholders(projectId)
  const remove = useRemoveProjectStakeholder(projectId)
  const [err, setErr] = useState('')
  // 加干系人下拉里勾选的；加完换 key 让下拉关掉、重新开始
  const [picked, setPicked] = useState<string[]>([])
  const [pickKey, setPickKey] = useState(0)
  const pm = useProjectMessages(projectId)
  const identities = useIdentities()
  const { roles, defaultRole } = useProjectRoles()

  const people = useMemo(() => new Map((contacts.data ?? []).map((c) => [c.id, c])), [contacts.data])
  // 引用的联系人已删的行不显示（SPEC-projects-6.12）
  const rows = useMemo(() => sortStakeholders(stakes.data ?? [], roles).filter((s) => people.has(s.stakeholder_id)), [stakes.data, people, roles])
  // 候选：还不是干系人的联系人，按姓名拼音排（同联系人页「按姓名」）
  const avail = useMemo(() => {
    const taken = new Set((stakes.data ?? []).map((s) => s.stakeholder_id))
    return (contacts.data ?? []).filter((c) => !taken.has(c.id)).sort((a, b) => compareNames(a.name, b.name))
  }, [contacts.data, stakes.data])
  // 勾选里已经不是候选的（别处加过了）不算
  const chosen = picked.filter((id) => avail.some((c) => c.id === id))
  const latest = useMemo(() => latestByContact(pm.msgs.data, new Map((identities.data ?? []).map((i) => [i.id, i.stakeholder_id]))),
    [pm.msgs.data, identities.data])
  const lastOf = (id: string): LastComm => {
    const m = latest.get(id)
    if (m) return { msg: m }
    if (pm.binds.isPending || pm.pluginsPending || pm.msgs.isPending) return { note: '' }
    if (!pm.bound.length) return { note: '还没绑定沟通渠道' }
    if (pm.noIm) return { note: 'IM 消息插件没在跑' }
    if (pm.msgs.isError && !pm.msgs.data.length) return { note: '消息没加载出来' }
    return { note: '本项目会话里没有消息' }
  }

  const onAdd = () => {
    // 按候选的顺序加（拼音序），不按勾选的先后
    const ids = avail.filter((c) => chosen.includes(c.id)).map((c) => c.id)
    if (!ids.length) return
    setErr('')
    add.mutate({ ids, role: defaultRole }, {
      onSuccess: (r) => {
        setPicked(r.failed.map((f) => f.id))
        if (!r.failed.length) setPickKey((k) => k + 1)
        else {
          const name = (id: string) => people.get(id)?.name ?? id
          setErr(`${r.failed.length} 人没加上：${r.failed.map((f) => `${name(f.id)}（${errorText(f.error)}）`).join('、')}`)
        }
      },
      onError: (e) => setErr(`没加上：${errorText(e)}`),
    })
  }
  const onRemove = (s: ProjectStakeholder) => {
    setErr('')
    remove.mutate(s.stakeholder_id, { onError: (e) => setErr(`没移除：${errorText(e)}`) })
  }

  const head = (
    <div className="pj-tab-head">
      <span className="pj-muted pj-wrap">谁拍板、谁对接、谁负责，每个人关心什么。人从联系人里挑</span>
      <span className="spacer" />
      <SearchSelect key={pickKey} multiple value={chosen} placeholder="加干系人" searchPlaceholder="搜姓名、公司、职位、分组、标签" align="end"
        aria-label="加干系人" disabled={!contacts.data || add.isPending} limit={PICK_LIMIT}
        options={avail.map((c) => ({
          value: c.id, label: c.name, hint: c.company || undefined, group: nameInitial(c.name),
          keywords: [c.title, c.group, ...(c.tags ?? [])].filter(Boolean).join(' '),
          icon: <Avatar name={c.name} size={18} src={c.photo || undefined} />,
        }))}
        emptyText="联系人都已经加进来了" onChange={(v) => setPicked(v)}
        footer={avail.length > 0 && (
          <Button size="sm" variant="primary" disabled={!chosen.length || add.isPending} onClick={onAdd}>
            {add.isPending ? '正在加' : chosen.length ? `加 ${chosen.length} 人` : '先勾选要加的人'}
          </Button>
        )} />
    </div>
  )

  let body
  if (stakes.isError || contacts.isError) {
    const e = stakes.error ?? contacts.error
    body = <ErrorState title="干系人没加载出来" error={errorText(e)} onRetry={() => { void stakes.refetch(); void contacts.refetch() }} />
  } else if (stakes.isPending || contacts.isPending) body = <LoadingState />
  else if (!rows.length) body = <EmptyState title="还没有干系人" desc="从联系人里挑出这个项目相关的人，标上角色和关注点" />
  else {
    body = (
      <div className="pj-table" role="table" aria-label="干系人">
        <div className="pj-stake pj-th" role="row">
          <span role="columnheader">人</span><span role="columnheader">角色</span><span role="columnheader">关注点</span>
          <span role="columnheader">最近沟通</span><span role="columnheader" aria-label="操作" />
        </div>
        {rows.map((s) => (
          <StakeRow key={s.stakeholder_id} projectId={projectId} s={s} roles={roles} c={people.get(s.stakeholder_id)!} last={lastOf(s.stakeholder_id)}
            onOpen={() => navigate(`/contacts?c=${encodeURIComponent(s.stakeholder_id)}`)}
            onOpenMessage={(m) => navigate(`${MESSAGES_PATH}?m=${encodeURIComponent(m.id)}`)}
            onRemove={() => onRemove(s)} removing={remove.isPending && remove.variables === s.stakeholder_id} />
        ))}
      </div>
    )
  }

  return (
    <div className="pj-tab">
      {head}
      {err && <div className="pj-err" role="alert">{err}</div>}
      {body}
    </div>
  )
}

function StakeRow({ projectId, s, roles, c, last, onOpen, onOpenMessage, onRemove, removing }: {
  /** 字典里的角色，含停用的 */
  roles: ProjectRoleItem[]
  projectId: string
  s: ProjectStakeholder
  c: Contact
  last: LastComm
  onOpen: () => void
  onOpenMessage: (m: ImMessage) => void
  onRemove: () => void
  removing: boolean
}) {
  const patch = usePatchProjectStakeholder(projectId)
  const [focus, setFocus] = useState(s.focus)
  const [err, setErr] = useState('')
  // 最后一次送出去的关注点：后端回来的值和它一样就不算改动
  const sent = useRef(s.focus)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const role = roleOf(s.role, roles)
  const known = !!role
  const builtin = ['decider', 'contact', 'owner'].includes(s.role)

  const save = (p: { role?: ProjectRole; focus?: string }) => {
    setErr('')
    if (p.focus !== undefined) sent.current = p.focus
    patch.mutate({ stakeholderId: s.stakeholder_id, patch: p }, { onError: (e) => setErr(`没存上：${errorText(e)}`) })
  }
  const flush = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (focus.trim() !== sent.current.trim()) save({ focus })
  }
  const onFocusChange = (v: string) => {
    setFocus(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (v.trim() !== sent.current.trim()) save({ focus: v })
    }, FOCUS_DELAY)
  }
  // 卸载（切标签、移除）前把没存的关注点存掉；拿最新的值用 ref
  const latest = useRef({ focus, flush })
  useEffect(() => { latest.current = { focus, flush } })
  useEffect(() => () => { if (timer.current) latest.current.flush() }, [])

  return (
    <div className="pj-stake" role="row">
      <button type="button" className="pj-who" role="cell" onClick={onOpen} title="打开联系人">
        <Avatar name={c.name} size={30} src={c.photo || undefined} />
        <span className="pj-who-text">
          <b className="ellipsis">{c.name}</b>
          <span className="pj-muted ellipsis">{[c.title, c.company].filter(Boolean).join(' · ') || '-'}</span>
        </span>
      </button>
      <span role="cell">
        <select className={cls('pj-chip-select', 'pj-role', !known ? 'pj-role-unknown' : !role.enabled ? 'pj-role-off' : builtin && `pj-role-${s.role}`)}
          aria-label={`${c.name} 的角色`} value={s.role}
          title={!role ? `不认识的角色「${s.role}」，选一个改掉` : !role.enabled ? `角色「${role.label}」已停用，可以照旧留着，也可以换一个` : role.desc || role.label}
          aria-invalid={!known || undefined}
          disabled={patch.isPending} onChange={(e) => save({ role: e.target.value as ProjectRole })}>
          {/* 库里的角色不在字典里时照原值列出来，不让下拉悄悄停在别的角色上（E-02）；停用的只给正用着它的人列出来 */}
          {!known && <option value={s.role} disabled>{s.role}</option>}
          {roles.filter((r) => r.enabled || r.key === s.role).map((r) => <option key={r.key} value={r.key} disabled={!r.enabled}>{r.enabled ? r.label : `${r.label}（已停用）`}</option>)}
        </select>
      </span>
      <span role="cell" className="pj-focus-cell">
        <Input invalid={!!err} aria-label={`${c.name} 的关注点`}
          value={focus} placeholder="他关心什么" maxLength={500} onChange={(e) => onFocusChange(e.target.value)} onBlur={flush} />
        {err && <span className="pj-err">{err}<button type="button" className="pj-link" onClick={() => save({ focus })}>重试</button></span>}
      </span>
      <span role="cell" className="pj-last">
        {'msg' in last
          ? <button type="button" className="pj-last-btn ellipsis" title={last.msg.text} onClick={() => onOpenMessage(last.msg)}>{ago(last.msg.at)} · {snippet(last.msg.text)}</button>
          : <span className="pj-muted">{last.note}</span>}
      </span>
      <span role="cell"><Button size="sm" disabled={removing} onClick={onRemove}>移除</Button></span>
    </div>
  )
}
