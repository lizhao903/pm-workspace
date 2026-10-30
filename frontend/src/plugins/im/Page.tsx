// IM 消息页（SPEC-messages-1）：收件箱，按时间倒序、按天分段，行内能直接处理。照原型 web-next/src/messages.tsx MessagesPage。
// 打开的消息记在地址 ?m=<id>，刷新、从别的模块跳过来都能直接打开；处理状态都在后端，刷新后保持。
// 转任务：先确认标题，再由后端建任务，然后打开任务模块登记的任务抽屉（经 core/plugin 的「打开对象」，不 import 任务模块）。
// 「渠道配置」打开 IM 渠道的配置抽屉（IM-01b，ChannelPanel），记在地址 ?channels=1。
// 批量（PR-03）：待处理的行能勾选，底栏批量标已处理、忽略；选了会话时列表上方能把这个会话全部标为已处理。
// 认人（IM-05）：行上「未存联系人」和抽屉里的入口打开同一个弹窗（ContactLink），做完打开这条消息的抽屉说结果。
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  connectorsPagePath, errorText, isApiError, onServerEvent, useConnectorDefs, useConnectors, useContacts, useDictionaries, useEventsLive, useImAction, useImBatch, useImMessage,
  useImMessages, useImSyncConnector, useNotifyChange, type ImAction, type ImMessage,
} from '../../core/data'
import { useObjectDrawer } from '../../core/plugin'
import { Avatar, ErrorState, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { ChannelPanel } from './ChannelPanel'
import { ContactLinkDialog, type ContactLinkMode, type ContactLinkResult } from './ContactLink'
import { MessageDrawer } from './MessageDrawer'
import {
  BATCH_MAX, MSG_STATUS_DICT, PAGE, RELEVANCE, VIEW_SEG_MAX, baseOk, canPick, channelOf, channelTable, convBatch, convOptions, dayLabel, filterRows,
  inView, isSnoozed, nextWake, pickAll, pickedRows, togglePick, replyBlocker, shortTime, snoozeOptions, statusItems, statusView, timeAgo, usedChannels, viewsOf, whoName, type Mine, type View,
} from './model'
import { AttachmentChips, Caret, ChannelMark, Gear, Menu, MentionText, QuickReplyItems } from './parts'
import { ToTaskDialog } from './ToTaskDialog'
import './im.css'

const POLL_MS = 30_000
const SYNC_NOTE_MS = 6_000

/** 状态小标签按状态颜色上色 */
const stateStyle = (c: string) => ({ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` })

export default function Page() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const openId = params.get('m')
  const channelsOpen = params.get('channels') === '1'
  const live = useEventsLive()
  const messages = useImMessages({ refetchInterval: live ? false : POLL_MS })
  const connectors = useConnectors()
  const defs = useConnectorDefs()
  const contacts = useContacts()
  const dicts = useDictionaries({ withItems: true })
  const act = useImAction()
  const batch = useImBatch()
  const markRead = useImAction()
  const notify = useNotifyChange()
  const taskDrawer = useObjectDrawer('task')

  const list = useMemo(() => messages.data ?? [], [messages.data])
  const sv = useMemo(() => statusView(statusItems(dicts.data?.find((d) => d.id === MSG_STATUS_DICT)?.items)), [dicts.data])
  const channels = useMemo(() => channelTable(defs.data), [defs.data])
  const photos = useMemo(() => new Map((contacts.data ?? []).map((c) => [c.id, c.photo])), [contacts.data])
  const imConnectors = useMemo(() => {
    const keys = new Set(channels.map((c) => c.key))
    return (connectors.data ?? []).filter((c) => keys.has(c.tool))
  }, [connectors.data, channels])

  // 新消息到达就刷新；事件流断开时退回轮询
  useEffect(() => onServerEvent('im.message_received', () => void notify({ kind: 'im-message' })), [notify])

  // 稍后到点时重新算视图（后端 15 秒内清掉 snooze_until，再读一次）；相对时间每分钟走一次
  const [now, setNow] = useState(() => Date.now())
  const wake = nextWake(list, now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    if (wake === null) return
    const t = window.setTimeout(() => {
      setNow(Date.now())
      void notify({ kind: 'im-message' })
    }, Math.max(0, wake - Date.now()) + 500)
    return () => window.clearTimeout(t)
  }, [wake, notify])

  const [view, setView] = useState<View>('pending')
  const [channel, setChannel] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [mine, setMine] = useState<Mine>('')
  const [q, setQ] = useState('')
  const [conv, setConv] = useState('')
  const [toTask, setToTask] = useState<ImMessage | null>(null)
  const [linking, setLinking] = useState<{ msg: ImMessage; mode: ContactLinkMode } | null>(null)
  const [linkNote, setLinkNote] = useState<(ContactLinkResult & { msgId: string }) | null>(null)
  const [taskOpen, setTaskOpen] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState('')
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())

  const filter = { view, channel, conv, unreadOnly, mine, q }
  const rows = useMemo(() => filterRows(list, { view, channel, conv, unreadOnly, mine, q }, now), [list, view, channel, conv, unreadOnly, mine, q, now])
  const views = viewsOf(sv)
  const segViews = views.length > VIEW_SEG_MAX + 1 ? views.slice(0, VIEW_SEG_MAX) : views
  const moreViews = views.slice(segViews.length)
  const count = (v: View) => list.filter((m) => inView(m, v, now) && baseOk(m, filter)).length
  const atMe = list.filter((m) => m.status === 'pending' && !isSnoozed(m, now) && m.relevance === 'me').length
  const convOpts = useMemo(() => convOptions(list, channel, now), [list, channel, now])
  const used = usedChannels(channels, list, imConnectors)
  const broken = imConnectors.filter((c) => c.status === 'error')
  const picked = pickedRows(rows, sel)
  const pickable = rows.filter(canPick).length
  const cb = useMemo(() => convBatch(list, conv, now), [list, conv, now])
  const convName = convOpts.find((o) => o.value === conv)?.label ?? ''
  const lastSync = imConnectors.map((c) => c.last_sync_at).filter((x): x is string => !!x).sort().pop()

  // 先渲染 PAGE 条；筛选一变就回到前 PAGE 条
  const sig = [view, channel, conv, unreadOnly, mine, q.trim()].join('|')
  const [lim, setLim] = useState({ sig, n: PAGE })
  if (lim.sig !== sig) setLim({ sig, n: PAGE })
  const limit = lim.sig === sig ? lim.n : PAGE
  const shown = rows.slice(0, limit)
  const dayCount = new Map<string, number>()
  for (const m of rows) dayCount.set(dayLabel(m.at), (dayCount.get(dayLabel(m.at)) ?? 0) + 1)

  const setOpen = useCallback((id: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (id) n.set('m', id)
      else n.delete('m')
      return n
    }, { replace: true })
  }, [setParams])

  const setChannelsOpen = useCallback((on: boolean) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (on) n.set('channels', '1')
      else n.delete('channels')
      return n
    }, { replace: true })
  }, [setParams])

  const run = useCallback((m: ImMessage, a: ImAction) => {
    setRowErr('')
    act.mutate({ id: m.id, action: a }, { onError: (e) => setRowErr(`${whoName(m)} 的消息没处理成：${errorText(e)}`) })
  }, [act])

  // 打开的消息：列表里有就用列表里的，没有（别处跳过来、太旧）单独取
  const inList = openId ? list.find((m) => m.id === openId) : undefined
  const single = useImMessage(openId && !inList && messages.isSuccess ? openId : null)
  const opened = inList ?? single.data
  const missing = !!openId && !inList && single.isError

  // 打开就标已读；同一条只发一次
  const readSent = useRef<string | null>(null)
  useEffect(() => {
    if (!opened || opened.read || readSent.current === opened.id) return
    readSent.current = opened.id
    markRead.mutate({ id: opened.id, action: { kind: 'read' } })
  }, [opened, markRead])

  // 转任务：转过的打开那条任务，没转过的先确认
  const startToTask = useCallback((m: ImMessage) => {
    if (m.task_id) { setTaskOpen(m.task_id); setOpen(null); return }
    setToTask(m)
  }, [setOpen])

  // 键盘：J K 上下，E 标已处理；输入框聚焦或按着 Cmd、Ctrl 时不管
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest?.('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (toTask || taskOpen || linking) return
      const i = rows.findIndex((r) => r.id === openId)
      if (e.key === 'j' && rows.length) {
        const n = Math.min(i + 1, rows.length - 1)
        // 走到已渲染的末尾就再加载一页
        if (n >= limit) setLim({ sig, n: limit + PAGE })
        setOpen(rows[n].id)
      } else if (e.key === 'k' && rows.length) {
        setOpen(rows[Math.max(i - 1, 0)].id)
      } else if (e.key === 'e' && opened && opened.status === 'pending') {
        run(opened, { kind: 'done' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, openId, opened, limit, sig, setOpen, run, toTask, taskOpen, linking])

  // 立即同步：渠道由后端按连接器的间隔自动拉；这里让后端马上各拉一次（不能拉取的渠道回 409，跳过），再读一遍，告诉你收到了几条新的
  const syncOne = useImSyncConnector()
  const [syncNote, setSyncNote] = useState<{ text: string; bad: boolean } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const sync = async () => {
    if (syncing) return
    if (!imConnectors.length && !list.length) { setSyncNote({ text: '还没接入 IM 渠道', bad: true }); return }
    const active = imConnectors.filter((c) => (!channel || c.tool === channel) && (c.status === 'connected' || c.status === 'error'))
    if (imConnectors.length && !active.length) { setSyncNote({ text: '这些渠道都暂停或断开了，没有可同步的', bad: true }); return }
    const before = new Set(list.map((m) => m.id))
    setSyncing(true)
    try {
      const rs = await Promise.allSettled(active.map((c) => syncOne.mutateAsync(c.id)))
      const r = await messages.refetch()
      const fresh = (r.data ?? []).filter((m) => !before.has(m.id) && (!channel || m.channel === channel)).length
      const bad = active.filter((_, i) => { const x = rs[i]; return x.status === 'rejected' && !isApiError(x.reason, 'conflict') }).map((c) => c.name)
      setSyncNote({ text: `${fresh ? `收到 ${fresh} 条新消息` : '没有新消息'}${bad.length ? `；${bad.join('、')}同步失败` : ''}`, bad: !!bad.length || r.isError })
    } finally {
      setSyncing(false)
    }
  }
  useEffect(() => {
    if (!syncNote) return
    const t = window.setTimeout(() => setSyncNote(null), SYNC_NOTE_MS)
    return () => window.clearTimeout(t)
  }, [syncNote])

  // 批量：成功后清掉勾选，按钮左边报改了几条
  const runBatch = (action: 'done' | 'ignore', input: { ids: string[] } | { conversation_id: string; before: string }) => {
    if (batch.isPending) return
    setRowErr('')
    const label = action === 'done' ? sv.label('done') : sv.label('ignored')
    batch.mutate({ action, ...input }, {
      onSuccess: (r) => {
        setSel(new Set())
        setSyncNote({ text: r.count ? `已把 ${r.count} 条标为${label}` : '没有要处理的消息', bad: false })
      },
      onError: (e) => setRowErr(`批量没处理成：${errorText(e)}`),
    })
  }

  const pendingLabel = sv.label('pending')
  const doneLabel = sv.label('done')
  const chOn = channel ? channelOf(channels, channel) : null
  const syncLabel = syncing ? '同步中…' : chOn ? `同步${chOn.label}` : '立即同步'
  const title = (
    <PageTitle count={messages.data ? `${count('pending')} 条${pendingLabel}` : undefined}
      desc={<>各渠道收进来的消息。<kbd>J</kbd> <kbd>K</kbd> 上下切换，<kbd>E</kbd> 标为{doneLabel}</>}
      actions={(
        <>
          {syncNote && <span className={cls('im-sync-note', syncNote.bad && 'bad')} role="status">{syncNote.text}</span>}
          <button type="button" className={cls('btn btn-outline', chOn && 'im-sync-ch')} onClick={() => void sync()} disabled={syncing}
            aria-label={syncLabel}
            title={`${chOn ? `只同步${chOn.label}` : '同步全部 IM 渠道'}${lastSync ? `；上次同步 ${timeAgo(lastSync, now)}` : ''}`}>
            <svg className={cls(syncing && 'im-spin')} viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="im-tb-label">{syncLabel}</span>
          </button>
          <button type="button" className="btn btn-ghost btn-outline" onClick={() => setChannelsOpen(true)} title="接入和管理 IM 渠道：Slack、Telegram" aria-label="渠道配置">
            <Gear /><span className="im-tb-label">渠道配置</span>
            {broken.length > 0 && <span className="im-dot-alert" title={`${broken.length} 个连接器异常`} />}
          </button>
        </>
      )}>IM 消息</PageTitle>
  )

  let body
  if (messages.isError && !messages.data) {
    body = <ErrorState title="消息没加载出来" error={errorText(messages.error)} onRetry={() => void messages.refetch()} />
  } else if (messages.isPending) {
    body = <LoadingState />
  } else if (!rows.length) {
    body = (
      <div className="empty">
        <div className="empty-title">{mine === 'at' ? '没有 @我 的消息' : view === 'pending' && !conv ? `${pendingLabel}的消息都清完了` : '这里没有消息'}</div>
        <div className="empty-desc">{view === 'pending' && !conv ? '新消息会按连接器的同步间隔收进来' : '换个状态、渠道或会话看看'}</div>
      </div>
    )
  } else {
    body = (
      <div className="im-list" role="list" aria-label="消息">
        {shown.map((m, i) => {
          const ch = channelOf(channels, m.channel)
          const who = whoName(m)
          const conn = m.connector_id ? connectors.data?.find((c) => c.id === m.connector_id) : undefined
          const blocker = replyBlocker(m, connectors.data)
          const rel = m.relevance
          const day = dayLabel(m.at)
          const sent = m.replies.filter((r) => r.status !== 'failed').length
          return (
            <Fragment key={m.id}>
              {(i === 0 || dayLabel(shown[i - 1].at) !== day) && <div className="im-day">{day}<span className="seg-n">{dayCount.get(day)}</span></div>}
              <div role="listitem" tabIndex={0} aria-label={`${who}：${m.text}`}
                className={cls('im-msg', openId === m.id && 'sel', !m.read && 'unread', m.status !== 'pending' && 'im-closed', sel.has(m.id) && canPick(m) && 'picked')}
                onClick={() => setOpen(m.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen(m.id) }}>
                <span className="im-unread" />
                {canPick(m)
                  ? <input type="checkbox" className="im-pick" checked={sel.has(m.id)} aria-label={`选中 ${who} 的消息`}
                      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => setSel((x) => togglePick(x, m.id))} />
                  : <span className="im-pick" aria-hidden="true" />}
                <Avatar name={who} size={34} src={(m.stakeholder_id && photos.get(m.stakeholder_id)) || undefined} />
                <div className="im-main">
                  <div className="im-top">
                    <span className="im-who">{who}</span>
                    {!m.stakeholder_id && (
                      <button type="button" className="im-stranger" title="关联到已有联系人，或新建联系人"
                        onClick={(e) => { e.stopPropagation(); setLinking({ msg: m, mode: 'link' }) }} onKeyDown={(e) => e.stopPropagation()}>未存联系人</button>
                    )}
                    <ChannelMark ch={ch} />
                    {conn?.status === 'error' && <span className="im-state im-state-bad" title={conn.error}>渠道异常</span>}
                    <span className="im-conv">{m.conversation || '私聊'}</span>
                    {rel && rel !== 'dm' && <span className={cls('im-rel', rel === 'me' && 'im-rel-me')}>{RELEVANCE[rel]}</span>}
                    <span className="spacer" />
                    {m.status !== 'pending' && <span className="im-state" style={stateStyle(sv.color(m.status))}>{sv.label(m.status)}</span>}
                    {isSnoozed(m, now) && <span className="im-state im-state-snooze">{shortTime(m.snooze_until!)} 提醒</span>}
                    {sent > 0 && <span className="im-state">已回复 {sent}</span>}
                    {m.reply_error && <span className="im-state im-state-bad" title={m.reply_error}>回复失败</span>}
                    {m.task_id && (
                      <button type="button" className="im-state im-state-task" title="打开这条任务"
                        onClick={(e) => { e.stopPropagation(); startToTask(m) }} onKeyDown={(e) => e.stopPropagation()}>已转任务 {m.task_ref}</button>
                    )}
                    <span className="im-time" title={new Date(m.at).toLocaleString('zh-CN')}>{timeAgo(m.at, now)}</span>
                  </div>
                  <div className="im-text"><MentionText text={m.text} /></div>
                  <AttachmentChips atts={m.attachments} />
                </div>
                <div className="im-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {m.status === 'pending' ? (
                    <>
                      <button type="button" className="im-act im-act-primary" onClick={() => run(m, { kind: 'done' })} title={`标为${doneLabel} (E)`}>{doneLabel}</button>
                      {blocker
                        ? <button type="button" className="im-act" disabled title={blocker}>回复<Caret /></button>
                        : <Menu className="im-act" label={<>回复<Caret /></>}>{(close) => <QuickReplyItems doneLabel={doneLabel} close={close} onPick={(text, done) => run(m, { kind: 'reply', text, done })} />}</Menu>}
                      <Menu className="im-act" label={<>稍后<Caret /></>}>
                        {(close) => snoozeOptions().map((o) => (
                          <button key={o.label} type="button" role="menuitem" className="menu-item" onClick={() => { run(m, { kind: 'snooze', until: o.until.toISOString() }); close() }}>{o.label}</button>
                        ))}
                      </Menu>
                      {!m.task_id && <button type="button" className="im-act" onClick={() => startToTask(m)}>转任务</button>}
                      <button type="button" className="im-act im-act-quiet" onClick={() => run(m, { kind: 'ignore' })}>忽略</button>
                    </>
                  ) : (
                    <button type="button" className="im-act" onClick={() => run(m, { kind: 'reopen' })}>重新打开</button>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
        {rows.length > limit && (
          <button type="button" className="im-more" onClick={() => setLim({ sig, n: limit + PAGE })}>
            加载更多<span className="seg-n">还有 {rows.length - limit} 条</span>
          </button>
        )}
      </div>
    )
  }

  const TaskDrawer = taskDrawer?.drawer
  return (
    <div className="im-page">
      {title}
      <div className="im-toolbar">
        <div className="im-seg" role="group" aria-label="状态">
          {[...segViews, ['all', '全部'] as [View, string]].map(([v, label]) => (
            <button key={v} type="button" className={cls(view === v && 'on')} aria-pressed={view === v} onClick={() => setView(v)}>
              {label}<span className="seg-n">{count(v)}</span>
            </button>
          ))}
        </div>
        {moreViews.length > 0 && (
          <SearchSelect value={moreViews.some(([v]) => v === view) ? view : ''} placeholder={`更多状态 ${moreViews.length}`} searchPlaceholder="搜状态"
            aria-label="更多状态" options={moreViews.map(([v, label]) => ({ value: v, label, hint: `${count(v)} 条` }))}
            onChange={(v) => setView(v ? (v as View) : 'pending')} />
        )}
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索内容、发信人、群名" aria-label="搜索消息" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className={cls('chip chip-select', mine && 'chip-on')} title="与我相关：@我、@所有人和私聊">
          <select value={mine} aria-label="与我相关" onChange={(e) => setMine(e.target.value as Mine)}>
            <option value="">全部消息</option>
            <option value="mine">与我相关</option>
            <option value="at">只看 @我{atMe ? `（${atMe} 条${pendingLabel}）` : ''}</option>
          </select>
          {!mine && atMe > 0 && <span className="im-mention-n" title={`${atMe} 条 @我 的消息${pendingLabel}`}>@{atMe}</span>}
        </label>
        <button type="button" className={cls('chip', unreadOnly && 'chip-on')} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)}>只看未读</button>
        {(convOpts.length > 1 || conv) && (
          <SearchSelect value={conv} onChange={setConv} noneLabel="全部会话" searchPlaceholder="搜群名、发信人" aria-label="只看某个会话"
            missingLabel={() => '这个渠道下没有这个会话'}
            options={convOpts.map((o) => ({
              value: o.value, group: o.group, label: o.label, keywords: o.keywords,
              hint: `${channelOf(channels, o.channel).label} · ${o.pending ? `${o.pending} 条${pendingLabel}` : `${o.n} 条`}`,
            }))} />
        )}
        <div className="spacer" />
        <div className="im-channels" role="group" aria-label="渠道">
          <button type="button" className={cls('im-ch', !channel && 'on')} aria-pressed={!channel} onClick={() => { setChannel(''); setConv('') }}>全部渠道</button>
          {used.map((ch) => (
            <button key={ch.key} type="button" className={cls('im-ch', channel === ch.key && 'on')} aria-pressed={channel === ch.key}
              style={{ '--c': ch.color } as CSSProperties} onClick={() => { setChannel(channel === ch.key ? '' : ch.key); setConv('') }}>
              <i className="im-ch-dot" />{ch.label}
            </button>
          ))}
        </div>
      </div>

      {rowErr && <div className="im-err" role="alert">{rowErr}</div>}
      {cb && (
        <div className="im-conv-bar">
          <span className="im-conv-bar-text">{convName ? `「${convName}」` : '这个会话'}还有 {cb.n} 条{pendingLabel}</span>
          <button type="button" className="btn btn-sm btn-outline" disabled={batch.isPending}
            title={`把这个会话里的${pendingLabel}消息都标为${doneLabel}（不含稍后的）`} onClick={() => runBatch('done', cb.input)}>
            这个会话全部标为{doneLabel}
          </button>
        </div>
      )}
      {body}
      {picked.length > 0 && (
        <div className="im-bulk" role="toolbar" aria-label="批量处理">
          <span className="im-bulk-n">已选 {picked.length} 条</span>
          {picked.length < Math.min(pickable, BATCH_MAX) && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel(pickAll(rows))}>全选 {Math.min(pickable, BATCH_MAX)} 条</button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-primary" disabled={batch.isPending}
            onClick={() => runBatch('done', { ids: picked.slice(0, BATCH_MAX).map((m) => m.id) })}>标为{doneLabel}</button>
          <button type="button" className="btn btn-sm btn-outline" disabled={batch.isPending}
            onClick={() => runBatch('ignore', { ids: picked.slice(0, BATCH_MAX).map((m) => m.id) })}>忽略</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel(new Set())}>取消选择</button>
        </div>
      )}

      {openId && (
        <MessageDrawer msg={opened} missing={missing} ch={channelOf(channels, opened?.channel ?? '')} connectors={connectors.data} sv={sv}
          photo={(opened?.stakeholder_id && photos.get(opened.stakeholder_id)) || undefined}
          note={linkNote && linkNote.msgId === opened?.id ? linkNote : undefined}
          onClose={() => { setOpen(null); setLinkNote(null) }}
          onOpenContact={(id) => navigate(`/contacts?c=${encodeURIComponent(id)}`)}
          onLinkContact={(mode) => { if (opened) setLinking({ msg: opened, mode }) }}
          onToTask={() => { if (opened) startToTask(opened) }}
          onFixConnector={() => { setOpen(null); setChannelsOpen(true) }} />
      )}
      {linking && (
        <ContactLinkDialog msg={linking.msg} mode={linking.mode} chLabel={channelOf(channels, linking.msg.channel).label} connectors={connectors.data}
          onCancel={() => setLinking(null)}
          onOpenContact={(id) => { setLinking(null); navigate(`/contacts?c=${encodeURIComponent(id)}`) }}
          onDone={(r) => {
            const id = linking.msg.id
            setLinking(null)
            setLinkNote({ ...r, msgId: id })
            setOpen(id)
          }} />
      )}
      {channelsOpen && <ChannelPanel onClose={() => setChannelsOpen(false)} onManageAll={(to) => navigate(connectorsPagePath(to))} />}
      {toTask && (
        <ToTaskDialog msg={toTask} doneLabel={doneLabel} onCancel={() => setToTask(null)}
          onCreated={(id) => { setToTask(null); setOpen(null); setTaskOpen(id) }}
          onExisting={() => {
            const id = toTask.id
            setToTask(null)
            void notify({ kind: 'im-message', id }).then(() => setOpen(id))
          }} />
      )}
      {taskOpen && TaskDrawer && (
        <Suspense fallback={null}>
          <TaskDrawer objectId={taskOpen} onClose={() => setTaskOpen(null)} />
        </Suspense>
      )}
      {taskOpen && !TaskDrawer && <div className="im-err" role="alert">任务模块没有加载，打不开任务</div>}
    </div>
  )
}
