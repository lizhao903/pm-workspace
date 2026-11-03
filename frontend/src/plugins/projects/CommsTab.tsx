// 沟通标签（SPEC-projects-4，PJ-02b）：左边是项目绑定的群聊和私聊，右边只显示这些会话里的消息。
// 绑定按会话 id 存在项目插件里（PJ-02a），群聊候选从内核会话表列（含还没收到消息的群，收到消息的群 IM 插件会登记）；
// 私聊候选按联系人的 IM 身份列，还没有私聊会话的绑定前按身份建一个，没填 IM 编号的置灰（PR-02）。消息按绑定的会话逐个取（IM-01a）。
// IM 消息插件没装或停用时消息区提示去插件管理，绑定照常能增删。点消息跳到 IM 消息页打开抽屉（插件间不 import 抽屉）。
// 消息里的附件挪到了独立的「附件」标签（SPEC-projects-5）；右栏顶上只留一行「N 个附件待决定」去那边（SPEC-projects-4.13），IM 插件没在跑时不显示。
// 下面是筛选条：搜索、与我相关，口径同 IM 消息页（B-10）；待处理的行悬停出「已处理」，不用再去 IM 消息页点。
// 项目消息（绑定、IM 插件状态、按会话取的消息）抽成 useProjectMessages，概览、标签红点、干系人用同一份缓存。
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import {
  ATTACH_KIND, conversationsApi, errorText, onServerEvent, useBindProjectConversation, useConnectorDefs, useContacts, useConversations,
  useDictionaries, useIdentities, useAllImMessages, useImAction, useNotifyChange, useUnbindProjectConversation, type ImAttachment, type ImMessage,
} from '../../core/data'
import { Avatar, Button, EmptyState, ErrorState, IconButton, IconClose, IconSearch, LoadingState, cls } from '../../core/ui'
import {
  DM_PEEK, MSG_PAGE, NO_IDENTITY_HINT, atMeCount, awaitingCount, awaitingReply, canMarkDone, channelLabeler, fmtSize, convLabel, directCandidates,
  directEmptyText, filterMessages, groupCandidates, isDirect, isSnoozed, lastMessageAt, mentionParts, peopleOf, pendingByConversation, statusLabeler,
  whoName, type DirectCand, type Mine,
} from './commsModel'
import { ago } from './model'
import { AttachmentKindIcon } from '../../core/ui/AttachmentPreview'
import { AttachmentsHint } from './AttachmentsTab'
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
          <AttachmentKindIcon kind={a.kind} /><span className="ellipsis">{a.name}</span>
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

export function CommsTab({ projectId, onAttachments }: {
  projectId: string
  /** 去「附件」标签；不传时不显示那一行入口 */
  onAttachments?: () => void
}) {
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
  const act = useImAction()

  const [filter, setFilter] = useState('')
  const [mine, setMine] = useState<Mine>('')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [bq, setBq] = useState('')
  const [err, setErr] = useState('')
  // 绑私聊时先建会话的那一下
  const [creating, setCreating] = useState(false)
  // 消息先渲染一页，换渠道、与我相关、搜索就回到第一页
  const view = `${filter}\u0000${mine}\u0000${q.trim()}`
  const [lim, setLim] = useState({ view, n: MSG_PAGE })
  const limit = lim.view === view ? lim.n : MSG_PAGE

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
  const dms = directCandidates(contacts.data ?? [], identities.data ?? [], convs.data ?? [], boundSet, bq)
  const searching = !!bq.trim()

  const all = msgs.data
  const rows = filterMessages(all, { conv: filter, mine, q })
  const narrowed = !!mine || !!q.trim()
  const pending = pendingByConversation(all, now)
  const atMe = atMeCount(all, now)
  const doneLabel = stLabel('done')

  const togglePanel = () => { setAdding(!adding); setBq('') }
  const onBind = (id: string) => {
    setErr('')
    bind.mutate(id, {
      onSuccess: () => { setAdding(false); setBq('') },
      onError: (e) => setErr(`没绑上：${errorText(e)}`),
    })
  }
  const onBindDirect = (d: DirectCand) => {
    if (d.conv) return onBind(d.conv.id)
    if (!d.identity) return
    setErr('')
    setCreating(true)
    conversationsApi.directFor(d.identity).then((cv) => onBind(cv.id), (e) => setErr(`没绑上：${errorText(e)}`)).finally(() => setCreating(false))
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
  const onDone = (m: ImMessage) => {
    setErr('')
    act.mutate({ id: m.id, action: { kind: 'done' } }, { onError: (e) => setErr(`${whoName(m)} 的消息没标上${doneLabel}：${errorText(e)}`) })
  }
  const onQKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || !q) return
    e.stopPropagation()
    setQ('')
  }

  const panel = adding && (
    <div className="pj-bind">
      <div className="search search-sm pj-bind-search">
        <IconSearch size={13} />
        <input autoFocus value={bq} placeholder="搜群名、联系人" aria-label="搜群名、联系人" onChange={(e) => setBq(e.target.value)} onKeyDown={onSearchKey} />
      </div>
      {convs.isError ? <ErrorState compact title="会话没加载出来" error={errorText(convs.error)} onRetry={() => void convs.refetch()} />
        : convs.isPending || contacts.isPending || identities.isPending ? <div className="pj-muted pj-bind-empty">加载中</div> : (
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
            {dms.shown.length ? dms.shown.map((d) => {
              const sub = d.identity ? [d.contact.company, chLabel(d.channel)].filter(Boolean).join(' · ') : NO_IDENTITY_HINT
              return (
                <button key={d.key} type="button" className="menu-item" disabled={!d.identity || bind.isPending || creating}
                  onClick={() => onBindDirect(d)} title={`${d.label} · ${sub}`}>
                  <Avatar name={d.label} size={18} src={d.contact.photo || undefined} /><span className="ellipsis">{d.label}</span>
                  <span className="pj-muted ellipsis pj-bind-sub">{sub}</span>
                </button>
              )
            }) : <div className="pj-muted pj-bind-empty">{directEmptyText(dms, searching)}</div>}
            {!searching && dms.pool > 0 && !dms.bindable && <div className="pj-muted pj-bind-empty">联系人都没填 IM 编号，先在联系人里填</div>}
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
          <span className="ellipsis">全部</span><span className="pj-chat-n">{noIm || msgs.isPending ? '' : all.length}</span>
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
  } else if (msgs.isError && !all.length) {
    body = <ErrorState title="消息没加载出来" error={errorText(msgs.error)} onRetry={msgs.refetch} />
  } else if (binds.isPending || msgs.isPending) body = <LoadingState />
  else if (!rows.length && narrowed && all.length) {
    body = (
      <EmptyState title="没有匹配的消息" desc={mine ? '换个关键词，或改成「全部消息」' : '换个关键词'}
        action={<Button onClick={() => { setQ(''); setMine('') }}>清掉筛选</Button>} />
    )
  } else if (!rows.length) body = <EmptyState title="没有消息" desc="绑定的群和私聊里的消息、归到这个项目的消息会出现在这里" />
  else {
    body = (
      <>
        {msgs.isError && <ErrorState compact title="有的会话消息没加载出来" error={errorText(msgs.error)} onRetry={msgs.refetch} />}
        {rows.slice(0, limit).map((m) => {
          const who = whoName(m)
          const photo = m.stakeholder_id ? people.contacts.get(m.stakeholder_id)?.photo : undefined
          const snoozed = isSnoozed(m, now)
          const waiting = awaitingReply(m, now)
          const marking = act.isPending && act.variables?.id === m.id
          return (
            <div key={m.id} role="button" tabIndex={0} className={cls('pj-msg', waiting && 'pending')} onClick={() => openMessage(m)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMessage(m) } }}>
              <Avatar name={who} size={30} src={photo || undefined} />
              <span className="pj-msg-main">
                <span className="pj-msg-top">
                  <b className="ellipsis">{who}</b>
                  <span className="pj-muted ellipsis">{chLabel(m.channel)} · {m.conversation || '私聊'}</span>
                  <span className="spacer" />
                  <span className="pj-msg-side">
                    <span className="pj-muted" title={m.at}>{ago(m.at, now)}</span>
                    {snoozed ? <span className="pj-muted">稍后提醒</span> : waiting ? <span className="pj-msg-go">回复</span> : <span className="pj-muted">{stLabel(m.status)}</span>}
                    {canMarkDone(m) && (
                      <button type="button" className="pj-msg-done" title={`标为${doneLabel}`} aria-label={`把 ${who} 的这条标为${doneLabel}`}
                        disabled={marking} onClick={(e) => { e.stopPropagation(); onDone(m) }}>
                        {doneLabel}
                      </button>
                    )}
                  </span>
                </span>
                <span className="pj-msg-text"><MentionText text={m.text} /></span>
                <AttachmentChips atts={m.attachments} />
              </span>
            </div>
          )
        })}
        {rows.length > limit && (
          <button type="button" className="pj-more" onClick={() => setLim({ view, n: limit + MSG_PAGE })}>
            加载更早的消息<span className="pj-muted">还有 {rows.length - limit} 条</span>
          </button>
        )}
      </>
    )
  }

  // 筛选条：有消息才有；不影响左边渠道的数字和上面的附件
  const tools = !noIm && !msgs.isPending && all.length > 0 && (
    <div className="pj-msg-tools">
      <div className="search search-sm pj-msg-search">
        <IconSearch size={13} />
        <input value={q} placeholder="搜索内容、发信人、群名" aria-label="搜索项目消息" onChange={(e) => setQ(e.target.value)} onKeyDown={onQKey} />
        {q && (
          <button type="button" className="search-clear" title="清空" aria-label="清空搜索" onClick={() => setQ('')}>
            <IconClose size={10} />
          </button>
        )}
      </div>
      <label className={cls('chip chip-select', mine && 'chip-on')} title="与我相关：@我、@所有人和私聊">
        <select value={mine} aria-label="与我相关" onChange={(e) => setMine(e.target.value as Mine)}>
          <option value="">全部消息</option>
          <option value="mine">与我相关</option>
          <option value="at">只看 @我{atMe ? `（${atMe} 条待回复）` : ''}</option>
        </select>
      </label>
      {narrowed && <span className="pj-muted">{rows.length} 条</span>}
    </div>
  )

  const inbox = !noIm && !msgs.isPending && all.length > 0 && onAttachments && <AttachmentsHint projectId={projectId} onGo={onAttachments} />

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
      <div className="pj-msgs" aria-label="项目消息">{inbox}{tools}{body}</div>
    </div>
  )
}
