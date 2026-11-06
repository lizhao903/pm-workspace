// 发信人认人（IM-05，SPEC-messages-2.12、2.27）：对不上联系人时关联到已有联系人或就地新建；认错了改挂或解除。
// 关联就是给联系人挂一个 IM 身份（POST /api/im-identities），消息读取时按渠道和编号认人，这个人以前和以后的消息都认上。
// 联系人和身份都走 core/data，不 import 联系人模块；新建只填姓名、公司、分组，别的去联系人页补全。
import { useMemo, useState } from 'react'
import {
  DEFAULT_CONTACT_GROUP, contactGroupOptions, errorText, identityOwner, isApiError, useContacts, useCreateContactLinked, useCreateIdentity,
  useDeleteIdentity, useDictionaries, useIdentities, useRelinkIdentity, type Connector, type ImMessage,
} from '../../core/data'
import { Avatar, ConfirmDialog, Field, Input, Select } from '../../core/ui'
import { clip100, contactCandidates } from './model'

export type ContactLinkMode = 'link' | 'create' | 'fix'

/**
 * 要认的发信人：消息抽屉给整条消息，群组管理「成员」菜单（TSK-0724）按成员拼出这几项
 */
export type ContactLinkSubject = Pick<ImMessage, 'channel' | 'connector_id' | 'sender_id' | 'sender_name' | 'identity_id' | 'stakeholder_id' | 'contact_name'>

/** 做成了：text 是给人看的结果，created 时给「去联系人页补全」 */
export type ContactLinkResult = { text: string; contactId?: string; created?: boolean }

/** 候选列表最多列几个，多了靠搜索缩小 */
const SHOW_MAX = 8

export function ContactLinkDialog({ msg, mode: initial, chLabel, connectors, onCancel, onDone, onOpenContact }: {
  msg: ContactLinkSubject
  mode: ContactLinkMode
  chLabel: string
  connectors: Connector[] | undefined
  onCancel: () => void
  onDone: (r: ContactLinkResult) => void
  onOpenContact: (id: string) => void
}) {
  const contacts = useContacts()
  const identities = useIdentities()
  const dicts = useDictionaries({ withItems: true })
  const link = useCreateIdentity()
  const create = useCreateContactLinked()
  const relink = useRelinkIdentity()
  const unlink = useDeleteIdentity()

  const [mode, setMode] = useState<ContactLinkMode>(initial)
  const [unlinkStep, setUnlinkStep] = useState(false)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState('')
  const [touched, setTouched] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const [name, setName] = useState(() => msg.sender_name.trim() || msg.sender_id)
  const [company, setCompany] = useState('')
  const groups = useMemo(() => contactGroupOptions(dicts.data), [dicts.data])
  const [group, setGroup] = useState('')
  const groupValue = group || (groups.some((g) => g.value === DEFAULT_CONTACT_GROUP) ? DEFAULT_CONTACT_GROUP : groups[0]?.value ?? '')

  const current = mode === 'fix' ? msg.stakeholder_id : null
  const currentName = msg.contact_name || msg.sender_name
  const list = useMemo(() => contactCandidates(contacts.data ?? [], msg.sender_name, q, current), [contacts.data, msg.sender_name, q, current])
  const target = contacts.data?.find((c) => c.id === picked)
  const account = connectors?.find((c) => c.id === msg.connector_id)?.account ?? ''
  const identity = { channel: msg.channel, external_id: msg.sender_id, display_name: clip100(msg.sender_name), account: clip100(account) }
  const busy = link.isPending || create.isPending || relink.isPending || unlink.isPending
  // 409 时编号挂在谁身上：身份列表在失败后会刷新
  const owner = isApiError(err, 'conflict') ? identityOwner(identities.data, msg.channel, msg.sender_id) : undefined
  const identityId = msg.identity_id ?? identityOwner(identities.data, msg.channel, msg.sender_id)?.id ?? ''

  const switchMode = (m: ContactLinkMode) => { setMode(m); setErr(null); setTouched(false) }
  const fail = (e: unknown) => setErr(e)

  const confirm = () => {
    if (busy) return
    setTouched(true)
    setErr(null)
    if (mode === 'create') {
      const n = name.trim()
      if (!n) return
      create.mutate({ fields: { name: n, company: company.trim(), group: groupValue }, identity }, {
        onSuccess: (r) => {
          if (r.identity) {
            onDone({ text: `已新建联系人 ${r.contact.name}，他在${chLabel}的消息都会显示为 ${r.contact.name}`, contactId: r.contact.id, created: true })
            return
          }
          // 联系人建好了、编号没挂上：转到关联，选中刚建的人，再点一次只重试挂身份
          setMode('link')
          setPicked(r.contact.id)
          setErr(r.error)
        },
        onError: fail,
      })
      return
    }
    if (unlinkStep) {
      if (!identityId) { setErr('找不到这个身份，刷新后再试'); return }
      unlink.mutate(identityId, {
        onSuccess: () => onDone({ text: `已解除关联，这个${chLabel}编号的消息改回显示「未存联系人」，${currentName} 的资料没动` }),
        onError: fail,
      })
      return
    }
    if (!target) return
    if (mode === 'fix') {
      if (!identityId) { setErr('找不到这个身份，刷新后再试'); return }
      relink.mutate({ id: identityId, stakeholderId: target.id }, {
        onSuccess: () => onDone({ text: `已改挂到 ${target.name}，这个${chLabel}编号的消息都会显示为 ${target.name}`, contactId: target.id }),
        onError: fail,
      })
      return
    }
    link.mutate({ ...identity, stakeholder_id: target.id }, {
      onSuccess: () => onDone({ text: `已关联到 ${target.name}，他在${chLabel}的消息都会显示为 ${target.name}`, contactId: target.id }),
      onError: fail,
    })
  }

  const errBox = err ? (
    <div className="im-link-err" role="alert">
      <span>{mode === 'link' && target && create.data?.contact.id === target.id
        ? `联系人 ${target.name} 已建好，但编号没挂上：${errorText(err)}`
        : `没改成：${errorText(err)}`}</span>
      {owner && <button type="button" className="im-act" onClick={() => onOpenContact(owner.stakeholder_id)}>去看这个人</button>}
    </div>
  ) : null

  const src = (
    <div className="im-muted">
      {chLabel} · <span className="im-mono">{msg.sender_id}</span>{msg.sender_name && msg.sender_name !== msg.sender_id ? ` · ${msg.sender_name}` : ''}
    </div>
  )

  if (unlinkStep) {
    return (
      <ConfirmDialog open danger title="解除关联？" confirmLabel={busy ? '解除中…' : '解除关联'} busy={busy} onConfirm={confirm} onCancel={onCancel}
        impacts={[`${currentName} 的联系人资料不动`, `这个${chLabel}编号的消息改回显示「未存联系人」`]}>
        <div className="im-link">
          {src}
          {errBox}
        </div>
      </ConfirmDialog>
    )
  }

  if (mode === 'create') {
    const empty = !name.trim()
    return (
      <ConfirmDialog open title="新建联系人" confirmLabel={busy ? '创建中…' : '创建并关联'} busy={busy} onConfirm={confirm} onCancel={onCancel}>
        <div className="im-link">
          {src}
          <Field label="姓名" required error={touched && empty ? '必填' : undefined}>
            <Input value={name} invalid={touched && empty} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }} />
          </Field>
          <Field label="公司">
            <Input value={company} placeholder="选填" onChange={(e) => setCompany(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }} />
          </Field>
          <Field label="分组">
            <Select value={groupValue} options={groups} onValueChange={setGroup} />
          </Field>
          <div className="im-muted">电话、邮箱、备注这些建好后到联系人页补全</div>
          {errBox}
          <button type="button" className="im-link-switch" onClick={() => switchMode('link')}>他已经在联系人里了？关联到已有联系人</button>
        </div>
      </ConfirmDialog>
    )
  }

  const fix = mode === 'fix'
  return (
    <ConfirmDialog open title={fix ? `不是 ${currentName}？` : '关联到联系人'} busy={busy} onConfirm={confirm} onCancel={onCancel}
      confirmLabel={busy ? '保存中…' : fix ? '改挂' : '关联'}>
      <div className="im-link">
        {fix
          ? <div className="im-muted">这个{chLabel}编号现在挂在 {currentName} 名下。选对的人改挂过去，或者解除关联</div>
          : <div className="im-muted">选一个联系人，把这个{chLabel}编号挂到他名下，以前和以后的消息都会显示为他</div>}
        {src}
        <Input value={q} placeholder="搜姓名、公司" aria-label="搜索联系人" onChange={(e) => setQ(e.target.value)} />
        {contacts.isError ? <div className="im-err">联系人没加载出来：{errorText(contacts.error)}</div>
          : contacts.isPending ? <div className="im-muted">加载中…</div>
          : !list.length ? <div className="im-muted">{q.trim() ? '没有匹配的联系人' : '还没有别的联系人'}</div>
          : (
            <div className="im-link-list" role="listbox" aria-label="联系人">
              {list.slice(0, SHOW_MAX).map((c) => (
                <button key={c.id} type="button" role="option" aria-selected={picked === c.id} className="im-link-opt" onClick={() => setPicked(c.id)}>
                  <Avatar name={c.name} size={24} src={c.photo || undefined} />
                  <span className="im-link-name">{c.name}</span>
                  {(c.company || c.title) && <span className="im-muted ellipsis">{[c.company, c.title].filter(Boolean).join(' · ')}</span>}
                </button>
              ))}
              {list.length > SHOW_MAX && <div className="im-muted im-link-more">还有 {list.length - SHOW_MAX} 个，输入搜索缩小范围</div>}
            </div>
          )}
        {touched && !target && !err && <div className="im-err">先选一个联系人</div>}
        {errBox}
        {fix
          ? <button type="button" className="im-link-switch" onClick={() => { setErr(null); setUnlinkStep(true) }}>谁都不是，解除关联</button>
          : <button type="button" className="im-link-switch" onClick={() => switchMode('create')}>联系人里没有他？新建联系人</button>}
      </div>
    </ConfirmDialog>
  )
}
