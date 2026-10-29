// 沟通标签（SPEC-projects-4，PJ-02b）：左边是项目绑定的群聊和私聊，右边只显示这些会话里的消息。
// 绑定按会话 id 存在项目插件里（PJ-02a），候选从内核会话表列（含还没收到消息的群）；消息按绑定的会话逐个取（IM-01a）。
// IM 消息插件没装或停用时消息区提示去插件管理，绑定照常能增删。点消息跳到 IM 消息页打开抽屉（插件间不 import 抽屉）。
// 右栏消息列表上面是消息里的附件（SPEC-projects-4.13、5，AttachmentInbox），IM 插件没在跑时不显示。
// 项目消息（绑定、IM 插件状态、按会话取的消息）抽成 useProjectMessages，概览、标签红点、干系人用同一份缓存。
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import {
  ATTACH_KIND, errorText, onServerEvent, useBindProjectConversation, useConnectorDefs, useContacts, useConversations,
  useDictionaries, useIdentities, useAllImMessages, useNotifyChange, useUnbindProjectConversation, type ImAttachment, type ImMessage,
} from '../../core/data'
import { Avatar, Button, EmptyState, ErrorState, IconButton, IconClose, IconSearch, LoadingState, cls } from '../../core/ui'
import {
  DM_PEEK, MSG_PAGE, awaitingCount, awaitingReply, channelLabeler, fmtSize, convLabel, directCandidates, groupCandidates, isDirect, isSnoozed,
  lastMessageAt, mentionParts, peopleOf, pendingByConversation, statusLabeler, whoName,
} from './commsModel'
import { ago } from './model'
import { AttIcon, AttachmentInbox } from './AttachmentInbox'
import { useProjectMessages } from './projectMessages'

const PLUGINS_PATH = '/settings/plugins'
const MESSAGES_PATH = '/messages'
const MSG_STATUS_DICT = 'msg_status'

function MentionText({ text }: { text: string }) {
  return <>{mentionParts(text).map((p, i) => (typeof p === 'string' ? p : <span key={i} className={cls('pj-mention', p.hot && 'pj-mention-hot')}>@{p.name}</span>))}</>
}

/** 附件小标签，最多 3 个；种类图标加名字，悬停「种类 · 大小」（SPEC-messages-1.16）；只展示 */
function AttachmentChips({ atts }: { atts: readonly ImAttachment[] }) {
  if (!atts.length) return null
  return (
    <span className="pj-att-chips">
      {atts.slice(0, 3).map((a) => (
        <span key={a.id} className={cls('pj-att-chip', `pj-att-${a.kind}`)} title={[ATTACH_KIND[a.kind] ?? a.kind, fmtSize(a.size)].filter(Boolean).join(' · ')}>
          <AttIcon kind={a.kind} /><span className="ellipsis">{a.name}</span>
        </span>
      ))}
      {atts.length > 3 && <span className="pj-att-chip">另外 {atts.length - 3} 个</span>}
    </span>
  )
}

/**
 * 标签条「沟通」上的红点：有待回复（不含稍后）时显示（SPEC-projects-2.3）。
 * 项目详情里一直挂着，所以新消息事件在这里订一次，沟通标签、概览、干系人跟着刷
 */
export function CommsTabDot({ projectId }: { projectId: string }) {
  const notify = useNotifyChange()
  const { msgs, noIm } = useProjectMessages(projectId)
  useEffect(() => onServerEvent('im.message_received', () => void notify({ kind: 'im-message' })), [notify])
  const n = noIm ? 0 : awaitingCount(msgs.data)
  return n ? <span className="side-dot pj-tab-dot" title={`${n} 条待回复`} /> : null
}

export function CommsTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const { binds, bound, boundIds, msgs, noIm, imOn } = useProjectMessages(projectId)
  const convs = useConversations()
  const identities = useIdentities()
  const contacts = useContacts()
  const defs = useConnectorDefs()
  // 字典没有 msg_status 时按内置名字兜底；整份读免得单个字典 404
  const dicts = useDictionaries({ withItems: true })
  const bind = useBindProjectConversation(projectId)
  const unbind = useUnbindProjectConversation(projectId)


  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [bq, setBq] = useState('')
  const [err, setErr] = useState('')
  // 消息先渲染一页，换渠道筛选就回到第一页
  const [lim, setLim] = useState({ filter, n: MSG_PAGE })
  const limit = lim.filter === filter ? lim.n : MSG_PAGE

  // 新消息事件由标签条的 CommsTabDot 订阅；事件流断开时 useProjectMessages 退回轮询
  // 相对时间、稍后到点每分钟重算一次
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  // 绑定面板开着时才拉全部消息，用来排「最近有消息的群」；和 IM 消息页同一份缓存
  const allMsgs = useAllImMessages(adding && imOn && !noIm)
  const panelMsgs = adding && imOn && !noIm ? allMsgs.data : undefined

  const chLabel = useMemo(() => channelLabeler(defs.data), [defs.data])
  const stLabel = useMemo(() => statusLabeler(dicts.data?.find((d) => d.id === MSG_STATUS_DICT)?.items), [dicts.data])
  const people = useMemo(() => peopleOf(identities.data, contacts.data), [identities.data, contacts.data])
  const convById = useMemo(() => new Map((convs.data ?? []).map((c) => [c.id, c])), [convs.data])
  const boundSet = useMemo(() => new Set(boundIds), [boundIds])
  const lastAt = useMemo(() => lastMessageAt(panelMsgs), [panelMsgs])
  const groups = groupCandidates(convs.data ?? [], boundSet, lastAt, chLabel, bq)
  const dms = directCandidates(convs.data ?? [], boundSet, people, bq)
  const searching = !!bq.trim()

  const mine = msgs.data
  const rows = filter ? mine.filter((m) => m.conversation_id === filter) : mine
  const pending = pendingByConversation(mine, now)

  const togglePanel = () => { setAdding(!adding); setBq('') }
  const onBind = (id: string) => {
    setErr('')
    bind.mutate(id, {
      onSuccess: () => { setAdding(false); setBq('') },
      onError: (e) => setErr(`没绑上：${errorText(e)}`),
    })
  }
  const onUnbind = (id: string) => {
    setErr('')
    if (filter === id) setFilter('')
    unbind.mutate(id, { onError: (e) => setErr(`没解绑：${errorText(e)}`) })
  }
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    // 自己吃掉 Esc，不关别的抽屉
    e.stopPropagation()
    if (bq) setBq('')
    else setAdding(false)
  }
  const openMessage = (m: ImMessage) => navigate(`${MESSAGES_PATH}?m=${encodeURIComponent(m.id)}`)

  const panel = adding && (
    <div className="pj-bind">
      <div className="search search-sm pj-bind-search">
        <IconSearch size={13} />
        <input autoFocus value={bq} placeholder="搜群名、联系人" aria-label="搜群名、联系人" onChange={(e) => setBq(e.target.value)} onKeyDown={onSearchKey} />
      </div>
      {convs.isError ? <ErrorState compact title="会话没加载出来" error={errorText(convs.error)} onRetry={() => void convs.refetch()} />
        : convs.isPending ? <div className="pj-muted pj-bind-empty">加载中</div> : (
          <>
            <div className="menu-label">{searching || groups.pool <= DM_PEEK ? '群聊' : `群聊 · 最近有消息的 ${DM_PEEK} 个`}</div>
            {groups.shown.length ? groups.shown.map((g) => (
              <button key={g.conv.id} type="button" className="menu-item" title={g.label} disabled={bind.isPending} onClick={() => onBind(g.conv.id)}>
                <span className="tag">{chLabel(g.channel)}</span><span className="ellipsis">{g.label}</span>
                {panelMsgs && !g.lastAt && <span className="pj-muted">还没收到消息</span>}
              </button>
            )) : <div className="pj-muted pj-bind-empty">{searching ? '没有匹配的群' : '没有可绑的群'}</div>}
            {groups.matched > groups.shown.length && (
              <div className="pj-muted pj-bind-empty">{searching ? `还有 ${groups.matched - groups.shown.length} 个，继续输入筛选` : `共 ${groups.matched} 个群，输入群名搜`}</div>
            )}
            <div className="menu-label">{searching || dms.pool <= DM_PEEK ? '私聊' : `私聊 · 最近联系的 ${DM_PEEK} 个`}</div>
            {dms.shown.length ? dms.shown.map((d) => (
              <button key={d.conv.id} type="button" className="menu-item" disabled={bind.isPending} onClick={() => onBind(d.conv.id)}
                title={[d.label, d.contact?.company, chLabel(d.channel)].filter(Boolean).join(' · ')}>
                <Avatar name={d.label} size={18} src={d.contact?.photo || undefined} /><span className="ellipsis">{d.label}</span>
                <span className="pj-muted ellipsis pj-bind-sub">{d.contact?.company || chLabel(d.channel)}</span>
              </button>
            )) : <div className="pj-muted pj-bind-empty">{searching ? '没有匹配的联系人' : '联系人都已经绑过了'}</div>}
            {dms.matched > dms.shown.length && (
              <div className="pj-muted pj-bind-empty">{searching ? `还有 ${dms.matched - dms.shown.length} 个，继续输入筛选` : `共 ${dms.matched} 个联系人，输入名字或公司搜`}</div>
            )}
          </>
        )}
    </div>
  )

  let list
  if (binds.isError) list = <ErrorState compact title="绑定的渠道没加载出来" error={errorText(binds.error)} onRetry={() => void binds.refetch()} />
  else if (binds.isPending) list = <div className="pj-muted pj-bind-empty">加载中</div>
  else {
    list = (
      <>
        <button type="button" className={cls('pj-chat', !filter && 'on')} aria-pressed={!filter} onClick={() => setFilter('')}>
          <span className="ellipsis">全部</span><span className="pj-chat-n">{noIm || msgs.isPending ? '' : mine.length}</span>
        </button>
        {bound.map((b) => {
          const c = b.conversation
          const n = pending.get(b.conversation_id) ?? 0
          const name = convLabel(c, convById.get(b.conversation_id), people)
          return (
            <div key={b.conversation_id} className={cls('pj-chat', filter === b.conversation_id && 'on')} role="button" tabIndex={0}
              aria-pressed={filter === b.conversation_id} onClick={() => setFilter(b.conversation_id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(b.conversation_id) } }}>
              {isDirect(c.kind) ? <span className="tag pj-tag-dm">私聊</span> : <span className="tag">{chLabel(c.channel)}</span>}
              <span className="ellipsis" title={isDirect(c.kind) ? `${name} · ${chLabel(c.channel)}` : name}>{name}</span>
              {n > 0 && <span className="side-dot" title={`${n} 条${stLabel('pending')}`} />}
              <IconButton size="sm" className="pj-unbind" label={`解绑 ${name}`} title="解绑（不删消息）" disabled={unbind.isPending}
                onClick={(e) => { e.stopPropagation(); onUnbind(b.conversation_id) }}>
                <IconClose size={10} />
              </IconButton>
            </div>
          )
        })}
        {!bound.length && <div className="pj-mount-empty">还没绑定。把项目群、对接人的私聊绑过来，项目里就只看这些消息</div>}
      </>
    )
  }

  let body
  if (noIm) {
    body = (
      <EmptyState title="需要 IM 消息插件" desc="项目里的消息来自 IM 消息插件。装上并启用后，绑定的群和私聊里的消息会出现在这里"
        action={<Button variant="primary" onClick={() => navigate(PLUGINS_PATH)}>去插件管理</Button>} />
    )
  } else if (msgs.isError && !mine.length) {
    body = <ErrorState title="消息没加载出来" error={errorText(msgs.error)} onRetry={msgs.refetch} />
  } else if (binds.isPending || msgs.isPending) body = <LoadingState />
  else if (!rows.length) body = <EmptyState title="没有消息" desc="绑定的群和私聊里收到消息后会出现在这里" />
  else {
    body = (
      <>
        {msgs.isError && <ErrorState compact title="有的会话消息没加载出来" error={errorText(msgs.error)} onRetry={msgs.refetch} />}
        {rows.slice(0, limit).map((m) => {
          const who = whoName(m)
          const photo = m.stakeholder_id ? people.contacts.get(m.stakeholder_id)?.photo : undefined
          const snoozed = isSnoozed(m, now)
          const waiting = awaitingReply(m, now)
          return (
            <button key={m.id} type="button" className={cls('pj-msg', waiting && 'pending')} onClick={() => openMessage(m)}>
              <Avatar name={who} size={30} src={photo || undefined} />
              <span className="pj-msg-main">
                <span className="pj-msg-top">
                  <b className="ellipsis">{who}</b>
                  <span className="pj-muted ellipsis">{chLabel(m.channel)} · {m.conversation || '私聊'}</span>
                  <span className="spacer" />
                  <span className="pj-msg-side">
                    <span className="pj-muted" title={m.at}>{ago(m.at, now)}</span>
                    {snoozed ? <span className="pj-muted">稍后提醒</span> : waiting ? <span className="pj-msg-go">回复</span> : <span className="pj-muted">{stLabel(m.status)}</span>}
                  </span>
                </span>
                <span className="pj-msg-text"><MentionText text={m.text} /></span>
                <AttachmentChips atts={m.attachments} />
              </span>
            </button>
          )
        })}
        {rows.length > limit && (
          <button type="button" className="pj-more" onClick={() => setLim({ filter, n: limit + MSG_PAGE })}>
            加载更早的消息<span className="pj-muted">还有 {rows.length - limit} 条</span>
          </button>
        )}
      </>
    )
  }

  const inbox = !noIm && !msgs.isPending && mine.length > 0 && (
    <AttachmentInbox projectId={projectId} messages={mine} now={now} onOpenMessage={openMessage} />
  )

  return (
    <div className="pj-comms">
      <div className="pj-chats">
        <div className="pj-chats-head">
          <h2 className="pj-sec-title">项目沟通渠道</h2>
          <Button size="sm" variant="outline" aria-expanded={adding} onClick={togglePanel}>{adding ? '收起' : '绑定'}</Button>
        </div>
        {panel}
        {err && <div className="pj-err" role="alert">{err}</div>}
        {list}
      </div>
      <div className="pj-msgs" aria-label="项目消息">{inbox}{body}</div>
    </div>
  )
}
