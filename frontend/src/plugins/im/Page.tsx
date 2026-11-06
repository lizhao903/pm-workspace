// IM 消息页（SPEC-messages-1）：收件箱，按时间倒序、按天分段，行内能直接处理。照原型 web-next/src/messages.tsx MessagesPage。
// 打开的消息记在地址 ?m=<id>，刷新、从别的模块跳过来都能直接打开；处理状态都在后端，刷新后保持。
// 转任务：先确认标题，再由后端建任务，然后打开任务模块登记的任务抽屉（经 core/plugin 的「打开对象」，不 import 任务模块）。
// 「渠道配置」打开 IM 渠道的配置抽屉（IM-01b，ChannelPanel），记在地址 ?channels=1。
// 「群组管理」打开群组管理抽屉（GroupAdmin，SPEC-messages-7）：全部会话的默认归属项目、批量设、按群名建议，记在地址 ?groups=1。
// 「发消息」（SPEC-messages-8）：主动发到一个会话（SendDialog）；选中一个会话时会话条里有「发消息」「我发出的 N 条」（SentStrip），来信对上我发出的标「回复了我发出的」。
// 批量（PR-03）：待处理的行能勾选，底栏批量标已处理、忽略；选了会话时列表上方能把这个会话全部标为已处理。
// 认人（IM-05）：行上「未存联系人」和抽屉里的入口打开同一个弹窗（ContactLink），做完打开这条消息的抽屉说结果。
// 已过期（IM-07）：状态切换多一个「已过期」；已过期的行能标已处理、忽略、重新打开，也能勾选批量处理。过期天数在渠道配置里改。
// 群组标签：选了渠道后列表上方按群组分标签（全部、各群、私聊合一个，多了收进「更多」），每个标签带待处理数；
// 标签和「只看某个会话」是同一个会话筛选，选了渠道时由标签代替那个下拉。选中一个群时能设它默认归属的项目（GroupProject）。
// 常驻全选（TSK-0492）：批量条左边一个全选框，选中已加载（已渲染出来的行）里能勾的全部消息，写「已选 N 条 / 已加载 M 条」；
// 还有没加载的行时提示先「加载更多」，不偷偷去全选没加载的。批量标已处理、忽略不截断，超过后端一次的上限由 useImBatch 分批。
// 批量分诊、处理队列（SOP 插件在跑时才有）：批量条「批量分诊」给勾选的（没勾就是当前筛选结果全部，最多 1000 条，超过 200 条自动分批）各发起一次分诊流程（TriageDialog）；
// 「处理队列 N」打开抽屉看这些执行（QueueDrawer），地址记 ?queue=1；消息行上标最近一次分诊的状态。
// 分诊建议：父执行和它起的子执行算同一次分诊（triageSummary）；「已分诊」小标悬停才取详情显示建议摘要，点了打开消息抽屉并滚到「分诊建议」一节
// （分诊中、等确认、失败的仍打开处理队列，那里能看排队、终止、重试）。两种抽屉的「分诊建议」一节在 TriageAdvice，没分诊过时能单独发起。
// 合并显示（默认开，开关记在本机）：同一个私聊合成一行、群里同一人连发合成一行（显示「N 条」）、重复消息合成一行（「重复 N 次」），
// 只是展示（groupModel）；勾一组 = 勾组里全部能处理的，计数、批量仍按一条条消息。点一组打开组抽屉（GroupDrawer），地址记 ?g=<组>。
// 交给 Agent（0008）：行上和抽屉里「发起会话」「拆分任务」，弹窗选 Agent（StartSessionDialog），建好跳到会话页；
// 发起过的行上标「已发起会话」「已拆分 N 条任务」，点了跳过去。
// 自动忽略（TSK-0495，SPEC-messages-9）：标题行「自动忽略 N」打开管理抽屉（MutesDrawer），地址记 ?mutes=1；「看消息」切到「已忽略」按名字搜。
// 被自动忽略的行上状态小标悬停写「因发信人 X 被设为自动忽略」。
// 转项目资料（0009）：行上「更多」菜单和两种抽屉里都能把这条（或这一组）存成项目的一条笔记资料（ToMaterialDialog）；
// 转过的行上标「已转资料」，点了去项目资料页定位那一条。
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  connectorsPagePath, errorText, isApiError, onServerEvent, useConnectorDefs, useConnectors, useContacts, useDictionaries, useEventsLive, useImAction, useImBatch, useImMessage,
  useImMessages, useImMutes, useImSyncConnector, useNotifyChange, usePlugins, useSopRunsByInput, type ImAction, type ImMessage, type ImSessionIntent,
} from '../../core/data'
import { useObjectDrawer } from '../../core/plugin'
import { Avatar, ErrorState, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { ChannelPanel } from './ChannelPanel'
import { ContactLinkDialog, type ContactLinkMode, type ContactLinkResult } from './ContactLink'
import { LinkTags } from './AgentLinks'
import { GroupDrawer } from './GroupDrawer'
import { GroupProject } from './GroupProject'
import { GroupAdminDrawer } from './GroupAdmin'
import { MutesDrawer } from './MutesPanel'
import { muteReason } from './muteModel'
import { SendDialog } from './SendDialog'
import { SentReplyTag, SentStrip } from './SentStrip'
import { MessageDrawer } from './MessageDrawer'
import {
  MSG_STATUS_DICT, PAGE, RELEVANCE, VIEW_SEG_MAX, baseOk, canPick, channelOf, channelTable, convBatch, convIdOf, convOptions, convTabs, dayLabel, filterRows,
  inView, isOpen, isSnoozed, nextWake, pickedRows, togglePick, replyBlocker, shortTime, snoozeOptions, statusItems, statusView, timeAgo, usedChannels, viewsOf, whoName, type Mine, type View,
} from './model'
import { AttachmentChips, Caret, ChannelMark, Gear, Menu, MentionText, QuickReplyItems, ThreadTag } from './parts'
import { ToTaskDialog } from './ToTaskDialog'
import { QueueDrawer } from './QueueDrawer'
import { StartSessionDialog } from './StartSessionDialog'
import { MaterialTag } from './MaterialLinks'
import { ToMaterialDialog } from './ToMaterialDialog'
import { materialPath } from './toMaterialModel'
import { sessionPath } from './sessionModel'
import {
  MERGE_KEY, clusterMessages, countLabel, isMerged, loadedPicks, nestThreads, openItems, pickState, previewText, selectAllState, rowTime, threadBadge, threadBadgeLabel, threadForMany, threadForTask, threadHint, threadOf, threadParent,
  toRows, toggleRow, type Row,
} from './groupModel'
import { TriageDialog } from './TriageDialog'
import { isActiveRun, triageNote, triageTargets } from './triageModel'
import { TRIAGE_TOTAL_MAX } from './triageBatch'
import { triageAttempts, type TriageAttempt } from './triageSummary'
import { GroupTriageSection, TriageSection, TriageTagButton } from './TriageAdvice'
import { quickReplyAction } from './useMentions'
import './im.css'

const POLL_MS = 30_000
/** 处理队列里有进行中的执行、事件流又断开时，多久读一次 */
const QUEUE_POLL_MS = 10_000
const SOP_PLUGIN = 'sop'
const SYNC_NOTE_MS = 6_000
/** 一次发起会话最多带几条消息（同后端 /api/im/sessions 上限） */
const BATCH_MAX_SESSION = 200

/** 状态小标签按状态颜色上色 */
const stateStyle = (c: string) => ({ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` })

const readMerge = () => { try { return localStorage.getItem(MERGE_KEY) !== '0' } catch { return true } }
const saveMerge = (on: boolean) => { try { localStorage.setItem(MERGE_KEY, on ? '1' : '0') } catch { /* 本机存不了就只管这一次 */ } }

/** 行上的「更多」菜单：交给 Agent（拆分任务、发起会话）、转项目资料 */
function AgentMenu({ onStart, onToMaterial }: { onStart: (intent: ImSessionIntent) => void; onToMaterial: () => void }) {
  return (
    <Menu className="im-act" label={<>更多<Caret /></>} title="交给 Agent 拆分任务、发起会话，或转成项目资料">
      {(close) => (
        <>
          <div className="menu-label">交给 Agent</div>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onStart('split'); close() }}>拆分任务…</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onStart('chat'); close() }}>发起会话…</button>
          <div className="menu-label">资料</div>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onToMaterial(); close() }}>转项目资料…</button>
        </>
      )}
    </Menu>
  )
}

export default function Page() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const openId = params.get('m')
  const groupKey = params.get('g')
  const channelsOpen = params.get('channels') === '1'
  const queueOpen = params.get('queue') === '1'
  const groupsOpen = params.get('groups') === '1'
  const mutesOpen = params.get('mutes') === '1'
  const mutes = useImMutes()
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
  // 分诊执行：SOP 插件在跑才取（插件列表读不出来时照样去取，接口 404 再当没有）
  const plugins = usePlugins()
  const sopOn = plugins.isError || !!plugins.data?.find((p) => p.id === SOP_PLUGIN)?.running
  const [queuePoll, setQueuePoll] = useState(false)
  const triageRuns = useSopRunsByInput('message_id', { enabled: sopOn, refetchInterval: !live && queuePoll ? QUEUE_POLL_MS : false })
  const tRuns = useMemo(() => triageRuns.data ?? [], [triageRuns.data])
  const attempts = useMemo(() => triageAttempts(tRuns), [tRuns])
  const attemptsOf = useCallback((id: string): TriageAttempt[] => attempts.get(id) ?? [], [attempts])
  const activeRuns = tRuns.filter(isActiveRun).length
  if (queuePoll !== activeRuns > 0) setQueuePoll(activeRuns > 0)
  const triageOn = sopOn && !isApiError(triageRuns.error, 'not_found')
  const [triage, setTriage] = useState(false)
  // 抽屉里「发起分诊」：只带这条或这一组
  const [triageFor, setTriageFor] = useState<ImMessage[] | null>(null)
  // 点「已分诊」小标打开的抽屉滚到「分诊建议」
  const [triageFocus, setTriageFocus] = useState<string | null>(null)

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
  // group：从合并的一组的抽屉里认人，做完回到那组的抽屉
  const [linking, setLinking] = useState<{ msg: ImMessage; mode: ContactLinkMode; group?: string } | null>(null)
  const [linkNote, setLinkNote] = useState<(ContactLinkResult & { msgId: string; group?: string }) | null>(null)
  const [taskOpen, setTaskOpen] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState('')
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const [merge, setMergeOn] = useState(readMerge)
  const setMerge = (on: boolean) => { setMergeOn(on); saveMerge(on) }
  const [starting, setStarting] = useState<{ msgs: ImMessage[]; intent: ImSessionIntent } | null>(null)
  const [toMaterial, setToMaterial] = useState<ImMessage[] | null>(null)
  // 主动发消息：conversationId 是带上的会话，不带时在弹窗里选
  const [sending, setSending] = useState<{ conversationId?: string } | null>(null)

  const filter = { view, channel, conv, unreadOnly, mine, q }
  const rows = useMemo(() => filterRows(list, { view, channel, conv, unreadOnly, mine, q }, now), [list, view, channel, conv, unreadOnly, mine, q, now])
  // 合并显示：分组看全部消息（连发、插话要看整段会话），摆行只用筛出来的
  const clusters = useMemo(() => clusterMessages(list), [list])
  // 消息列回复归到原消息那一行（不管合不合并），列表上不显示，只在原消息行上标「消息列 N 条未读回复」
  const viewRows = useMemo(() => nestThreads(toRows(rows, clusters, merge), list), [rows, clusters, merge, list])
  const byId = useMemo(() => new Map(list.map((m) => [m.id, m])), [list])
  // 勾选、全选只算列表上看得到的：原消息收到了的消息列回复在原消息抽屉里处理
  const listed = useMemo(() => rows.filter((m) => !(m.thread && threadParent(m, byId))), [rows, byId])
  const views = viewsOf(sv)
  const segViews = views.length > VIEW_SEG_MAX + 1 ? views.slice(0, VIEW_SEG_MAX) : views
  const moreViews = views.slice(segViews.length)
  const count = (v: View) => list.filter((m) => inView(m, v, now) && baseOk(m, filter)).length
  const atMe = list.filter((m) => m.status === 'pending' && !isSnoozed(m, now) && m.relevance === 'me').length
  const convOpts = useMemo(() => convOptions(list, channel, now), [list, channel, now])
  const used = usedChannels(channels, list, imConnectors)
  const broken = imConnectors.filter((c) => c.status === 'error')
  const picked = pickedRows(listed, sel)
  const cb = useMemo(() => convBatch(list, conv, now), [list, conv, now])
  const tabs = useMemo(() => convTabs(list, channel, now), [list, channel, now])
  const convName = conv.startsWith('dm:') ? '私聊' : convOpts.find((o) => o.value === conv)?.label ?? ''
  const convId = convIdOf(conv)
  const moreOn = tabs.more.some((o) => o.value === conv)
  // 默认项目只给群设；单个私聊（从「更多」选的）、没登记的群不给
  const isGroupConv = convOpts.some((o) => o.value === conv && o.group === '群聊')
  // 选中的标签滚进可见范围（窄屏、群多时标签横向滚动）
  const scrollToTab = useCallback((el: HTMLButtonElement | null) => { el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [])
  const lastSync = imConnectors.map((c) => c.last_sync_at).filter((x): x is string => !!x).sort().pop()

  // 先渲染 PAGE 条；筛选一变就回到前 PAGE 条
  const sig = [view, channel, conv, unreadOnly, mine, q.trim(), merge].join('|')
  const [lim, setLim] = useState({ sig, n: PAGE })
  if (lim.sig !== sig) setLim({ sig, n: PAGE })
  const limit = lim.sig === sig ? lim.n : PAGE
  const shown = viewRows.slice(0, limit)
  // 常驻全选只管已加载的行（TSK-0492）
  const loaded = loadedPicks(shown)
  const allState = selectAllState(loaded, sel, picked.length)
  const unloaded = viewRows.length > limit
  const toggleAll = () => setSel((x) => (allState === 'all' ? new Set<string>() : new Set([...x, ...loaded.map((m) => m.id)])))
  // 每天的条数按消息算（合并的一组算它筛得出来的条数），一组归在它最新一条那天
  const dayCount = new Map<string, number>()
  // 归到这一行的消息列回复也按条算（列表上不显示，但它们在筛选结果里），归在这一行排序用的那天
  for (const r of viewRows) {
    const d = dayLabel(rowTime(r))
    dayCount.set(d, (dayCount.get(d) ?? 0) + r.items.length + (r.threads ?? []).reduce((n, b) => n + b.replies.length, 0))
  }

  const setOpen = useCallback((id: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.delete('g')
      if (id) n.set('m', id)
      else n.delete('m')
      return n
    }, { replace: true })
  }, [setParams])

  // 打开合并的一组（?g=）；和单条的 ?m= 互斥
  const setGroup = useCallback((key: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.delete('m')
      if (key) n.set('g', key)
      else n.delete('g')
      return n
    }, { replace: true })
  }, [setParams])
  const openRow = useCallback((r: Row) => { if (isMerged(r)) setGroup(r.key); else setOpen(r.head.id) }, [setGroup, setOpen])

  const setQueueOpen = useCallback((on: boolean) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (on) n.set('queue', '1')
      else n.delete('queue')
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

  const setGroupsOpen = useCallback((on: boolean) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (on) n.set('groups', '1')
      else n.delete('groups')
      return n
    }, { replace: true })
  }, [setParams])
  const setMutesOpen = useCallback((on: boolean) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (on) n.set('mutes', '1')
      else n.delete('mutes')
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
  // 打开原消息时，它消息列里没读的回复一起标已读（消息列回复在原消息抽屉里看）
  const threadRead = useRef(new Set<string>())
  const openedThread = useMemo(() => (opened && !opened.thread ? threadOf(opened, list) : []), [opened, list])
  useEffect(() => {
    for (const m of openedThread) {
      if (m.read || threadRead.current.has(m.id)) continue
      threadRead.current.add(m.id)
      markRead.mutate({ id: m.id, action: { kind: 'read' } })
    }
  }, [openedThread, markRead])

  // 打开的一组：按当前全部消息现算；一组里没读的打开就都标已读（每条只发一次）
  const openedGroup = useMemo<Row | null>(() => {
    const c = groupKey ? clusters.byKey.get(groupKey) : undefined
    if (!c) return null
    const items = [...c.all].reverse()
    return { key: c.key, kind: c.kind, head: items[0], items, all: c.all }
  }, [groupKey, clusters])
  const groupRead = useRef(new Set<string>())
  useEffect(() => {
    for (const m of openedGroup?.all ?? []) {
      if (m.read || groupRead.current.has(m.id)) continue
      groupRead.current.add(m.id)
      markRead.mutate({ id: m.id, action: { kind: 'read' } })
    }
  }, [openedGroup, markRead])

  // 转任务：转过的打开那条任务，没转过的先确认
  const startToTask = useCallback((m: ImMessage) => {
    if (m.task_id) { setTaskOpen(m.task_id); setOpen(null); return }
    setToTask(m)
  }, [setOpen])

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

  // 键盘：J K 上下，E 标已处理（待处理和已过期的）；输入框聚焦或按着 Cmd、Ctrl 时不管
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest?.('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (toTask || taskOpen || linking || triage || triageFor || queueOpen || starting) return
      const i = viewRows.findIndex((r) => (isMerged(r) ? r.key === groupKey : r.head.id === openId))
      if (e.key === 'j' && viewRows.length) {
        const n = Math.min(i + 1, viewRows.length - 1)
        // 走到已渲染的末尾就再加载一页
        if (n >= limit) setLim({ sig, n: limit + PAGE })
        openRow(viewRows[n])
      } else if (e.key === 'k' && viewRows.length) {
        openRow(viewRows[Math.max(i - 1, 0)])
      } else if (e.key === 'e' && opened && isOpen(opened)) {
        run(opened, { kind: 'done' })
      } else if (e.key === 'e' && openedGroup && openItems({ items: openedGroup.all }).length) {
        runBatch('done', { ids: openItems({ items: openedGroup.all }).map((m) => m.id) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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
          <button type="button" className="btn btn-ghost btn-outline" onClick={() => setSending({})} title="主动发一条到群或私聊" aria-label="发消息">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8.2 14 2.5 11.6 13.5 7.6 10.2 2 8.2ZM7.6 10.2 14 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
            <span className="im-tb-label">发消息</span>
          </button>
          <button type="button" className="btn btn-ghost btn-outline" onClick={() => setGroupsOpen(true)} title="给群和私聊设默认归属的项目，能批量设" aria-label="群组管理">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M1.8 13c.4-2.3 2.1-3.6 4.2-3.6s3.8 1.3 4.2 3.6M10.6 3.4a2.2 2.2 0 0 1 0 4.2M12 9.7c1.2.5 2 1.6 2.2 3.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            <span className="im-tb-label">群组管理</span>
          </button>
          {!mutes.isError && (
            <button type="button" className="btn btn-ghost btn-outline" onClick={() => setMutesOpen(true)} aria-label="自动忽略"
              title="自动忽略的发信人：他们的消息一收到就进「已忽略」，不计未读、不触发 SOP 和 Agent；在这里查看、取消">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 6.2h2.4L8.6 3.5v9L5.4 9.8H3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="m10.8 6.2 3 3.6M13.8 6.2l-3 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              <span className="im-tb-label">自动忽略</span>{(mutes.data?.length ?? 0) > 0 && <span className="seg-n">{mutes.data!.length}</span>}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-outline" onClick={() => setChannelsOpen(true)} title="接入和管理 IM 渠道：Slack、Telegram" aria-label="渠道配置">
            <Gear /><span className="im-tb-label">渠道配置</span>
            {broken.length > 0 && <span className="im-dot-alert" title={`${broken.length} 个连接器异常`} />}
          </button>
        </>
      )}>IM 消息</PageTitle>
  )

  const openSession = (id: string) => navigate(sessionPath(id))
  // 从抽屉打开 SOP 运行页，返回时回到这里（带着打开的抽屉）
  const openRun = (id: string) => navigate(`/sop/runs/${encodeURIComponent(id)}`, { state: { back: `/messages?${params.toString()}` } })
  // 发起会话、拆分任务：一组时带上整组（最多一页的上限）
  const startSession = (msgs: readonly ImMessage[], intent: ImSessionIntent) => setStarting({ msgs: msgs.slice(-BATCH_MAX_SESSION), intent })
  // 转项目资料：一组时带上整组（同发起会话的上限）；转过的资料去项目资料页定位
  const startMaterial = (msgs: readonly ImMessage[]) => setToMaterial(msgs.slice(-BATCH_MAX_SESSION))
  const openMaterial = (projectId: string, materialId: string) => navigate(materialPath(projectId, materialId))

  // 合并的一组：人名、条数、拼起来的预览；勾一组 = 勾组里能处理的全部
  const groupRow = (r: Row) => {
    const m = r.head
    const ch = channelOf(channels, m.channel)
    const who = whoName(m)
    const open = openItems(r)
    const unread = r.items.filter((x) => !x.read).length
    const ps = pickState(r, sel)
    const label = countLabel(r)
    const pickable = r.items.some(canPick)
    const blocker = replyBlocker(m, connectors.data)
    const statuses = [...new Set(r.items.map((x) => x.status))]
    const rel = r.items.find((x) => x.relevance === 'me')?.relevance ?? m.relevance
    return (
      <div role="listitem" tabIndex={0} aria-label={`${who}：${label || '1 条'}`}
        className={cls('im-msg im-msg-group', groupKey === r.key && 'sel', unread > 0 && 'unread', !open.length && 'im-closed', ps !== 'none' && 'picked')}
        onClick={() => setGroup(r.key)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setGroup(r.key) }}>
        <span className="im-unread" />
        {pickable
          ? <input type="checkbox" className="im-pick" checked={ps === 'all'} ref={(el) => { if (el) el.indeterminate = ps === 'some' }}
              aria-label={`选中 ${who} 的这组消息`}
              onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => setSel((x) => toggleRow(x, r))} />
          : <span className="im-pick" aria-hidden="true" />}
        <Avatar name={who} size={34} src={(m.stakeholder_id && photos.get(m.stakeholder_id)) || undefined} />
        <div className="im-main">
          <div className="im-top">
            <span className="im-who">{who}</span>
            {label && <span className="im-count" title={r.kind === 'dm' ? '这个私聊里筛得出来的消息' : r.kind === 'dup' ? '同一个人发的相同内容' : '同一个人连着发的'}>{label}</span>}
            <ChannelMark ch={ch} />
            <span className="im-conv">{m.conversation || '私聊'}</span>
            {rel && rel !== 'dm' && <span className={cls('im-rel', rel === 'me' && 'im-rel-me')}>{RELEVANCE[rel]}</span>}
            {threadTag(r)}
            <span className="spacer" />
            {open.length > 0 && open.length < r.items.length && <span className="im-state">{open.length} 条{pendingLabel}</span>}
            {!open.length && statuses.length === 1 && <span className="im-state" style={stateStyle(sv.color(statuses[0]))}>{sv.label(statuses[0])}</span>}
            {unread > 0 && r.kind === 'dm' && <span className="im-state">{unread} 条未读</span>}
            <LinkTags msgs={r.all} onOpenSession={openSession} onOpenTask={setTaskOpen} />
            <MaterialTag msgs={r.all} onOpen={openMaterial} />
            <SentReplyTag msgs={r.items} />
            <span className="im-time" title={new Date(m.at).toLocaleString('zh-CN')}>{timeAgo(m.at, now)}</span>
          </div>
          <div className="im-text"><MentionText text={previewText(r)} /></div>
          <AttachmentChips atts={r.items.flatMap((x) => x.attachments)} />
        </div>
        <div className="im-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {open.length ? (
            <>
              <button type="button" className="im-act im-act-primary" disabled={batch.isPending} title={`这一行 ${open.length} 条都标为${doneLabel}`}
                onClick={() => runBatch('done', { ids: open.map((x) => x.id) })}>{doneLabel}</button>
              {blocker
                ? <button type="button" className="im-act" disabled title={blocker}>回复<Caret /></button>
                : <Menu className="im-act" label={<>回复<Caret /></>} title="回最新一条">{(close) => <QuickReplyItems doneLabel={doneLabel} close={close} onPick={(text, done) => {
                    run(m, quickReplyAction(m, text, done))
                    const rest = open.filter((x) => x.id !== m.id).map((x) => x.id)
                    if (done && rest.length) runBatch('done', { ids: rest })
                  }} />}</Menu>}
              <AgentMenu onStart={(intent) => startSession(r.all, intent)} onToMaterial={() => startMaterial(r.all)} />
              <button type="button" className="im-act im-act-quiet" disabled={batch.isPending} onClick={() => runBatch('ignore', { ids: open.map((x) => x.id) })}>忽略</button>
            </>
          ) : (
            <>
              <AgentMenu onStart={(intent) => startSession(r.all, intent)} onToMaterial={() => startMaterial(r.all)} />
              <button type="button" className="im-act" onClick={() => { for (const x of r.items) run(x, { kind: 'reopen' }) }}>重新打开</button>
            </>
          )}
        </div>
      </div>
    )
  }

  // 消息列小标：列表里不列消息列回复，原消息那一行标「消息列 N 条未读回复」，点了打开原消息的抽屉（消息列回复在里面看、处理）
  const threadTag = (r: Row) => {
    const b = threadBadge(r, list)
    if (!b) return null
    return (
      <button type="button" className={cls('im-state im-thread-badge', b.unread > 0 && 'im-thread-badge-new')}
        title="消息列里的回复在原消息里看，点开原消息"
        onClick={(e) => { e.stopPropagation(); setOpen(b.parentId) }} onKeyDown={(e) => e.stopPropagation()}>{threadBadgeLabel(b)}</button>
    )
  }

  let body
  if (messages.isError && !messages.data) {
    body = <ErrorState title="消息没加载出来" error={errorText(messages.error)} onRetry={() => void messages.refetch()} />
  } else if (messages.isPending) {
    body = <LoadingState />
  } else if (!viewRows.length) {
    body = (
      <div className="empty">
        <div className="empty-title">{mine === 'at' ? '没有 @我 的消息' : view === 'pending' && !conv ? `${pendingLabel}的消息都清完了` : '这里没有消息'}</div>
        <div className="empty-desc">{view === 'pending' && !conv ? '新消息会按连接器的同步间隔收进来' : '换个状态、渠道或会话看看'}</div>
      </div>
    )
  } else {
    body = (
      <div className="im-list" role="list" aria-label="消息">
        {shown.map((r, i) => {
          const day = dayLabel(rowTime(r))
          const dayHead = (i === 0 || dayLabel(rowTime(shown[i - 1])) !== day) && <div className="im-day">{day}<span className="seg-n">{dayCount.get(day)}</span></div>
          if (isMerged(r)) return <Fragment key={r.key}>{dayHead}{groupRow(r)}</Fragment>
          const m = r.head
          const parent = m.thread ? threadParent(m, byId) : undefined
          const hint = threadHint(m, parent)
          const ch = channelOf(channels, m.channel)
          const who = whoName(m)
          const conn = m.connector_id ? connectors.data?.find((c) => c.id === m.connector_id) : undefined
          const blocker = replyBlocker(m, connectors.data)
          const rel = m.relevance
          const sent = m.replies.filter((r) => r.status !== 'failed').length
          return (
            <Fragment key={m.id}>
              {dayHead}
              <div role="listitem" tabIndex={0} aria-label={`${who}：${m.text}`}
                className={cls('im-msg', openId === m.id && 'sel', !m.read && 'unread', m.status !== 'pending' && 'im-closed', sel.has(m.id) && canPick(m) && 'picked', r.faded && 'im-faded')}
                title={r.faded ? '原消息不在当前筛选里，消息列有新回复才显示' : undefined}
                onClick={() => setOpen(m.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen(m.id) }}>
                <span className="im-unread" />
                {canPick(m) && !r.faded
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
                    {m.thread && <ThreadTag hint={hint} parentId={parent?.id} onOpen={setOpen} />}
                    {threadTag(r)}
                    <span className="spacer" />
                    {m.status !== 'pending' && (
                      <span className="im-state" style={stateStyle(sv.color(m.status))}
                        title={m.status === 'expired' && m.expired_at ? `${shortTime(m.expired_at)} 超期没处理，标为${sv.label('expired')}` : muteReason(m) || undefined}>
                        {m.muted ? '自动忽略' : sv.label(m.status)}</span>
                    )}
                    {isSnoozed(m, now) && <span className="im-state im-state-snooze">{shortTime(m.snooze_until!)} 提醒</span>}
                    {sent > 0 && <span className="im-state">已回复 {sent}</span>}
                    {m.reply_error && <span className="im-state im-state-bad" title={m.reply_error}>回复失败</span>}
                    <TriageTagButton attempt={attemptsOf(m.id)[0]} onOpenQueue={() => setQueueOpen(true)}
                      onOpenAdvice={() => { setTriageFocus(m.id); setOpen(m.id) }} />
                    {m.task_id && (
                      <button type="button" className="im-state im-state-task" title="打开这条任务"
                        onClick={(e) => { e.stopPropagation(); startToTask(m) }} onKeyDown={(e) => e.stopPropagation()}>已转任务 {m.task_ref}</button>
                    )}
                    <LinkTags msgs={[m]} onOpenSession={openSession} onOpenTask={setTaskOpen} />
                    <MaterialTag msgs={[m]} onOpen={openMaterial} />
                    <SentReplyTag msgs={[m]} />
                    <span className="im-time" title={new Date(m.at).toLocaleString('zh-CN')}>{timeAgo(m.at, now)}</span>
                  </div>
                  <div className="im-text"><MentionText text={m.text} /></div>
                  {hint && <div className="im-thread-hint">{hint}</div>}
                  <AttachmentChips atts={m.attachments} />
                </div>
                <div className="im-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {m.status === 'pending' ? (
                    <>
                      <button type="button" className="im-act im-act-primary" onClick={() => run(m, { kind: 'done' })} title={`标为${doneLabel} (E)`}>{doneLabel}</button>
                      {blocker
                        ? <button type="button" className="im-act" disabled title={blocker}>回复<Caret /></button>
                        : <Menu className="im-act" label={<>回复<Caret /></>}>{(close) => <QuickReplyItems doneLabel={doneLabel} close={close} onPick={(text, done) => run(m, quickReplyAction(m, text, done))} />}</Menu>}
                      <Menu className="im-act" label={<>稍后<Caret /></>}>
                        {(close) => snoozeOptions().map((o) => (
                          <button key={o.label} type="button" role="menuitem" className="menu-item" onClick={() => { run(m, { kind: 'snooze', until: o.until.toISOString() }); close() }}>{o.label}</button>
                        ))}
                      </Menu>
                      {!m.task_id && <button type="button" className="im-act" onClick={() => startToTask(m)}>转任务</button>}
                      <AgentMenu onStart={(intent) => startSession([m], intent)} onToMaterial={() => startMaterial([m])} />
                      <button type="button" className="im-act im-act-quiet" onClick={() => run(m, { kind: 'ignore' })}>忽略</button>
                    </>
                  ) : m.status === 'expired' ? (
                    <>
                      <button type="button" className="im-act im-act-primary" onClick={() => run(m, { kind: 'done' })} title={`标为${doneLabel} (E)`}>{doneLabel}</button>
                      <button type="button" className="im-act" onClick={() => run(m, { kind: 'reopen' })} title={`回到${pendingLabel}，重新计算过期`}>重新打开</button>
                      <button type="button" className="im-act im-act-quiet" onClick={() => run(m, { kind: 'ignore' })}>忽略</button>
                    </>
                  ) : (
                    <>
                      <AgentMenu onStart={(intent) => startSession([m], intent)} onToMaterial={() => startMaterial([m])} />
                      <button type="button" className="im-act" onClick={() => run(m, { kind: 'reopen' })}>重新打开</button>
                    </>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
        {viewRows.length > limit && (
          <button type="button" className="im-more" onClick={() => setLim({ sig, n: limit + PAGE })}>
            加载更多<span className="seg-n">还有 {viewRows.length - limit} 行</span>
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
        <button type="button" className={cls('chip', merge && 'chip-on')} aria-pressed={merge} onClick={() => setMerge(!merge)}
          title="同一个私聊合成一行，群里同一人连发、重复的消息合成一行；只是显示，消息不变">合并显示</button>
        {!channel && (convOpts.length > 1 || conv) && (
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

      {channel && (tabs.groups.length > 0 || tabs.dm) && (
        <div className="im-tabs-row">
          <div className="im-tabs" role="tablist" aria-label="群组">
            {[{ value: '', label: '全部', pending: list.filter((m) => m.channel === channel && inView(m, 'pending', now)).length },
              ...(tabs.dm ? [tabs.dm] : []), ...tabs.groups].map((t) => (
              <button key={t.value || 'all'} type="button" role="tab" aria-selected={conv === t.value} className={cls(conv === t.value && 'on')}
                ref={conv === t.value ? scrollToTab : undefined}
                title={t.value ? `${t.label}：${t.pending} 条${pendingLabel}` : undefined} onClick={() => setConv(t.value)}>
                <span className="im-tab-label">{t.label}</span>{t.pending > 0 && <span className="seg-n">{t.pending}</span>}
              </button>
            ))}
          </div>
          {tabs.more.length > 0 && (
            <SearchSelect value={moreOn ? conv : ''} placeholder={tabs.moreGroups ? `更多群组 ${tabs.moreGroups}` : '单个私聊'} searchPlaceholder="搜群名、发信人" aria-label="更多群组和私聊"
              className={cls(moreOn && 'chip-on')} align="end"
              options={tabs.more.map((o) => ({
                value: o.value, group: o.group, label: o.label, keywords: o.keywords,
                hint: o.pending ? `${o.pending} 条${pendingLabel}` : `${o.n} 条`,
              }))}
              onChange={(v) => setConv(v)} />
          )}
        </div>
      )}
      {rowErr && <div className="im-err" role="alert">{rowErr}</div>}
      {(cb || convId) && (
        <div className="im-conv-bar">
          {cb && (
            <>
              <span className="im-conv-bar-text">{convName ? `「${convName}」` : '这个会话'}还有 {cb.n} 条{pendingLabel}</span>
              <button type="button" className="btn btn-sm btn-outline" disabled={batch.isPending}
                title={`把这个会话里的${pendingLabel}消息都标为${doneLabel}（不含稍后的）`} onClick={() => runBatch('done', cb.input)}>
                这个会话全部标为{doneLabel}
              </button>
            </>
          )}
          {convId && <SentStrip key={`sent-${convId}`} conversationId={convId} onSend={() => setSending({ conversationId: convId })} />}
          {convId && isGroupConv && <GroupProject key={convId} conversationId={convId} />}
        </div>
      )}
      {body}
      {/* 页面下方的批量处理条：左边常驻全选框（已加载里能勾的）；勾选了时是已选和批量动作，没勾时只留批量分诊（对当前筛选结果）和处理队列。
          已加载里没有能勾的、SOP 插件没跑、又没勾选时不显示 */}
      {(picked.length > 0 || triageOn || loaded.length > 0) && (
        <div className={cls('im-bulk', !picked.length && 'im-bulk-idle')} role="toolbar" aria-label="批量处理">
          <label className="im-bulk-all" title={loaded.length ? `选中已加载的 ${loaded.length} 条能处理的消息${unloaded ? '；还有没加载的，加载更多后再全选可包含更多' : ''}` : '已加载的消息里没有能勾选的（只有还没处理的能勾）'}>
            <input type="checkbox" className="im-pick" aria-label="全选已加载的消息" disabled={!loaded.length} checked={allState === 'all'}
              ref={(el) => { if (el) el.indeterminate = allState === 'some' }} onChange={toggleAll} />
            全选
          </label>
          {picked.length > 0
            ? <span className="im-bulk-n">已选 {picked.length} 条</span>
            : null}
          <span className="im-muted">{picked.length > 0 ? '/ ' : ''}已加载 {loaded.length} 条</span>
          {unloaded && loaded.length > 0 && <span className="im-muted im-bulk-hint">还有未加载的，加载更多后再全选可包含更多</span>}
          {!picked.length && (
            <span className="im-muted im-bulk-hint">{triageOn ? `不勾时批量分诊对当前筛选结果 ${rows.length} 条` : `勾选后可批量标为${doneLabel}、忽略`}</span>
          )}
          <span className="spacer" />
          {triageOn && (
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setTriage(true)} disabled={!picked.length && !rows.length}
              title={picked.length ? `给勾选的 ${picked.length} 条消息各发起一次分诊流程` : `给当前筛选结果全部 ${rows.length} 条消息各发起一次分诊流程（最多 ${TRIAGE_TOTAL_MAX} 条，超过 200 条自动分批）`}>批量分诊</button>
          )}
          {picked.length > 0 && (
            <>
              <button type="button" className="btn btn-sm btn-primary" disabled={batch.isPending}
                onClick={() => runBatch('done', { ids: picked.map((m) => m.id) })}>标为{doneLabel}</button>
              <button type="button" className="btn btn-sm btn-outline" disabled={batch.isPending}
                onClick={() => runBatch('ignore', { ids: picked.map((m) => m.id) })}>忽略</button>
            </>
          )}
          {triageOn && (
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setQueueOpen(true)} aria-label="处理队列"
              title="分诊这类按消息发起的流程执行：进行中的和最近结束的">
              处理队列{activeRuns > 0 && <span className="seg-n">{activeRuns}</span>}
            </button>
          )}
          {picked.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel(new Set())}>取消选择</button>}
        </div>
      )}

      {openId && (
        <MessageDrawer msg={opened} missing={missing} ch={channelOf(channels, opened?.channel ?? '')} connectors={connectors.data} sv={sv}
          photo={(opened?.stakeholder_id && photos.get(opened.stakeholder_id)) || undefined}
          note={linkNote && linkNote.msgId === opened?.id ? linkNote : undefined}
          onClose={() => { setOpen(null); setLinkNote(null); setTriageFocus(null) }}
          triage={triageOn && opened ? (
            <TriageSection key={opened.id} attempts={attemptsOf(opened.id)} focus={triageFocus === opened.id}
              onStart={() => setTriageFor([opened])} onOpenRun={openRun} onOpenTask={setTaskOpen} />
          ) : null}
          onOpenContact={(id) => navigate(`/contacts?c=${encodeURIComponent(id)}`)}
          onLinkContact={(mode) => { if (opened) setLinking({ msg: opened, mode }) }}
          onToTask={() => { if (opened) startToTask(opened) }}
          onFixConnector={() => { setOpen(null); setChannelsOpen(true) }}
          onStart={(intent) => { if (opened) startSession([opened], intent) }}
          onToMaterial={() => { if (opened) startMaterial([opened]) }} onOpenMaterial={openMaterial}
          onOpenSession={openSession} onOpenTask={setTaskOpen}
          thread={openedThread} threadParent={opened ? threadParent(opened, byId) : undefined} onOpenMessage={setOpen} />
      )}
      {groupKey && !openId && (
        <GroupDrawer row={messages.isSuccess ? openedGroup : null} ch={channelOf(channels, openedGroup?.head.channel ?? '')} connectors={connectors.data} sv={sv}
          photo={(openedGroup?.head.stakeholder_id && photos.get(openedGroup.head.stakeholder_id)) || undefined}
          note={linkNote && linkNote.group === groupKey ? linkNote : undefined}
          batchBusy={batch.isPending}
          triage={triageOn && openedGroup ? (
            <GroupTriageSection key={openedGroup.key} msgs={openedGroup.all} attemptsOf={attemptsOf}
              onStart={() => setTriageFor(openedGroup.all)} onOpenRun={openRun} onOpenTask={setTaskOpen} />
          ) : null}
          onClose={() => { setGroup(null); setLinkNote(null) }}
          onOpenContact={(id) => navigate(`/contacts?c=${encodeURIComponent(id)}`)}
          onLinkContact={(msg, mode) => setLinking({ msg, mode, group: groupKey })}
          onBatch={(action, ids) => runBatch(action, { ids })}
          onOpenMessage={(id) => setOpen(id)}
          onStart={(intent) => { if (openedGroup) startSession(openedGroup.all, intent) }}
          onToMaterial={() => { if (openedGroup) startMaterial(openedGroup.all) }} onOpenMaterial={openMaterial}
          onOpenSession={openSession} onOpenTask={setTaskOpen} />
      )}
      {starting && (
        <StartSessionDialog messages={starting.msgs} intent={starting.intent} chLabel={channelOf(channels, starting.msgs[0]?.channel ?? '').label}
          onCancel={() => setStarting(null)}
          onStarted={(id) => { setStarting(null); openSession(id) }} />
      )}
      {toMaterial && (
        <ToMaterialDialog messages={toMaterial} thread={threadForMany(toMaterial, list)} chLabel={channelOf(channels, toMaterial[0]?.channel ?? '').label} doneLabel={doneLabel}
          onCancel={() => setToMaterial(null)}
          onDone={() => setToMaterial(null)}
          onOpenMaterial={(pid, mid) => { setToMaterial(null); openMaterial(pid, mid) }} />
      )}
      {linking && (
        <ContactLinkDialog msg={linking.msg} mode={linking.mode} chLabel={channelOf(channels, linking.msg.channel).label} connectors={connectors.data}
          onCancel={() => setLinking(null)}
          onOpenContact={(id) => { setLinking(null); navigate(`/contacts?c=${encodeURIComponent(id)}`) }}
          onDone={(r) => {
            const id = linking.msg.id
            const group = linking.group
            setLinking(null)
            setLinkNote({ ...r, msgId: id, group })
            if (group) setGroup(group)
            else setOpen(id)
          }} />
      )}
      {triage && (() => {
        const t = triageTargets(picked, rows, TRIAGE_TOTAL_MAX)
        return (
          <TriageDialog targets={t.list} from={t.from} over={t.over} runs={tRuns} onCancel={() => setTriage(false)}
            onDone={(r) => { setTriage(false); setSel(new Set()); setSyncNote(triageNote(r)) }} />
        )
      })()}
      {triageFor && (
        <TriageDialog targets={triageFor} from="drawer" over={triageFor.length > TRIAGE_TOTAL_MAX} runs={tRuns} onCancel={() => setTriageFor(null)}
          onDone={(r) => { setTriageFor(null); setSyncNote(triageNote(r)) }} />
      )}
      {queueOpen && (
        <QueueDrawer runs={tRuns} messages={list} now={now} loading={triageRuns.isPending} error={triageRuns.isError ? triageRuns.error : null}
          onClose={() => setQueueOpen(false)}
          onOpenRun={(id) => navigate(`/sop/runs/${encodeURIComponent(id)}`, { state: { back: '/messages?queue=1' } })}
          onOpenMessage={(id) => { setParams((p) => { const n = new URLSearchParams(p); n.delete('queue'); n.set('m', id); return n }, { replace: true }) }} />
      )}
      {sending && (
        <SendDialog conversationId={sending.conversationId} onCancel={() => setSending(null)}
          onSent={(_it, name) => { setSending(null); setSyncNote({ text: `已发到${name ? `「${name}」` : '会话'}`, bad: false }) }} />
      )}
      {channelsOpen && <ChannelPanel onClose={() => setChannelsOpen(false)} onManageAll={(to) => navigate(connectorsPagePath(to))} />}
      {mutesOpen && (
        <MutesDrawer onClose={() => setMutesOpen(false)}
          onShowMessages={(name) => { setMutesOpen(false); setChannel(''); setConv(''); setMine(''); setUnreadOnly(false); setView('ignored'); setQ(name) }} />
      )}
      {groupsOpen && (
        <GroupAdminDrawer onClose={() => setGroupsOpen(false)} onSend={(id) => setSending({ conversationId: id })}
          onOpenConversation={(ch, id) => { setGroupsOpen(false); setChannel(ch); setConv(`cv:${id}`) }} />
      )}
      {toTask && (
        <ToTaskDialog msg={toTask} thread={threadForTask(toTask, list)} doneLabel={doneLabel} onCancel={() => setToTask(null)}
          onCreated={(id, note) => { setToTask(null); setOpen(null); setTaskOpen(id); if (note) setSyncNote({ text: note, bad: true }) }}
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
