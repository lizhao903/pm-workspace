// 干系人标签（SPEC-projects-6）：人从联系人里挑，按角色顺序（决策人、对接人、负责人、参与、知会）显示，同角色按加入顺序。
// 增删改走项目插件的 /api/projects/{id}/stakeholders。关注点边输边存（停顿一下或离开输入框就存），存不上留着输入、行内提示。
// 「最近沟通」要等沟通渠道绑定（PJ-02），现在只显示还没绑定。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  PROJECT_ROLES, errorText, useAddProjectStakeholder, useContacts, usePatchProjectStakeholder, useProjectStakeholders,
  useRemoveProjectStakeholder, type Contact, type ProjectRole, type ProjectStakeholder,
} from '../../core/data'
import { Avatar, Button, EmptyState, ErrorState, Input, LoadingState, SearchSelect, cls } from '../../core/ui'
import { sortStakeholders } from './model'

/** 关注点停顿多久后保存 */
const FOCUS_DELAY = 600

export function StakeholdersTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const stakes = useProjectStakeholders(projectId)
  const contacts = useContacts()
  const add = useAddProjectStakeholder(projectId)
  const remove = useRemoveProjectStakeholder(projectId)
  const [err, setErr] = useState('')

  const people = useMemo(() => new Map((contacts.data ?? []).map((c) => [c.id, c])), [contacts.data])
  // 引用的联系人已删的行不显示（SPEC-projects-6.12）
  const rows = useMemo(() => sortStakeholders(stakes.data ?? []).filter((s) => people.has(s.stakeholder_id)), [stakes.data, people])
  const taken = new Set((stakes.data ?? []).map((s) => s.stakeholder_id))
  const avail = (contacts.data ?? []).filter((c) => !taken.has(c.id))

  const onAdd = (id: string) => {
    if (!id) return
    setErr('')
    add.mutate({ stakeholder_id: id, role: 'member', focus: '' }, { onError: (e) => setErr(`没加上：${errorText(e)}`) })
  }
  const onRemove = (s: ProjectStakeholder) => {
    setErr('')
    remove.mutate(s.stakeholder_id, { onError: (e) => setErr(`没移除：${errorText(e)}`) })
  }

  const head = (
    <div className="pj-tab-head">
      <span className="pj-muted pj-wrap">谁拍板、谁对接、谁负责，每个人关心什么。人从联系人里挑</span>
      <span className="spacer" />
      <SearchSelect value="" placeholder="加干系人" searchPlaceholder="搜姓名、公司、职位" align="end" active={false}
        disabled={!contacts.data || add.isPending}
        options={avail.map((c) => ({ value: c.id, label: c.name, hint: c.company || undefined, keywords: c.title, icon: <Avatar name={c.name} size={18} src={c.photo || undefined} /> }))}
        emptyText="联系人都已经加进来了" onChange={onAdd} />
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
          <StakeRow key={s.stakeholder_id} projectId={projectId} s={s} c={people.get(s.stakeholder_id)!}
            onOpen={() => navigate(`/contacts?c=${encodeURIComponent(s.stakeholder_id)}`)}
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

function StakeRow({ projectId, s, c, onOpen, onRemove, removing }: {
  projectId: string
  s: ProjectStakeholder
  c: Contact
  onOpen: () => void
  onRemove: () => void
  removing: boolean
}) {
  const patch = usePatchProjectStakeholder(projectId)
  const [focus, setFocus] = useState(s.focus)
  const [err, setErr] = useState('')
  // 最后一次送出去的关注点：后端回来的值和它一样就不算改动
  const sent = useRef(s.focus)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const role = PROJECT_ROLES.find((r) => r.key === s.role)

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
        <select className={cls('pj-role', `pj-role-${s.role}`)} aria-label={`${c.name} 的角色`} value={s.role} title={role?.desc}
          disabled={patch.isPending} onChange={(e) => save({ role: e.target.value as ProjectRole })}>
          {PROJECT_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </span>
      <span role="cell" className="pj-focus-cell">
        <Input invalid={!!err} aria-label={`${c.name} 的关注点`}
          value={focus} placeholder="他关心什么" maxLength={500} onChange={(e) => onFocusChange(e.target.value)} onBlur={flush} />
        {err && <span className="pj-err">{err}<button type="button" className="pj-link" onClick={() => save({ focus })}>重试</button></span>}
      </span>
      <span role="cell" className="pj-muted">还没绑定沟通渠道</span>
      <span role="cell"><Button size="sm" disabled={removing} onClick={onRemove}>移除</Button></span>
    </div>
  )
}
