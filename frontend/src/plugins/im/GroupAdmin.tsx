// 群组管理（IM 插件 0.15.0，SPEC-messages-7）：IM 消息页标题行「群组管理」打开的右侧抽屉，地址记 ?groups=1。
// 列出全部有消息的群和私聊（GET /api/im/conversations/summary），每行渠道、名字（私聊是对方）、消息数、待处理数、最近一条时间、默认归属项目；
// 默认归属在行上直接改（可搜索下拉，「不归项目」清除），选了马上生效；勾选后底部一条能批量设、清除（一次最多 200 个）。
// 没设归属的群按群名关键字给建议（groupAdminModel 的 SUGGEST_RULES），行上「采纳」单个，上方「全部采纳」只采纳只有一个候选的。
// 改默认归属和选中群标签时那一行（GroupProject）是同一份数据：群里没单独归项目的消息都算到这个项目，消息上单独设的优先。
// 每行「发消息」带上这个会话打开发消息弹窗（SendDialog，Page 里渲染）；发过的行上写「已发 N 条」。
// 只显示渠道编号的行（成员是 Slack 的 U…、群名为空或就是编号）右侧「查询回填」，工具条「回填全部缺失」批量补（IM 0.26.0，TSK-0494）。
// 每行「成员」菜单列会话里发过言的人，能把某人（含机器人）设为自动忽略、或取消（IM 0.27.0，TSK-0495，GroupMembers）。
import { useMemo, useState, type CSSProperties } from 'react'
import {
  errorText, useConnectorDefs, useImConversationSummary, useProjects, useRefillImNames, useSetImConversationProjects,
  type ImConvProjectBatchInput, type ImConvProjectBatchResult, type ImConversationSummary,
} from '../../core/data'
import { Drawer, ErrorState, LoadingState, SearchSelect, cls, type SearchOption } from '../../core/ui'
import {
  GROUP_BATCH_MAX, GROUP_PAGE, adoptable, chunks, displayName, filterGroups, groupChannels, mergeResults, needsRefill, pickAllGroups, pickedGroups,
  refillBatchText, refillOneText, refillTitle, refillable, resultText, suggestAll, suggestReason, togglePick, type GroupKindFilter, type ProjectLite, type Suggestion,
} from './groupAdminModel'
import { channelOf, channelTable, timeAgo } from './model'
import { ChannelMark } from './parts'
import { GroupMembersMenu } from './GroupMembers'
import './groupAdmin.css'

type Note = { text: string; bad: boolean }
/** 行上查询回填的进度和结果 */
type RowRefill = { busy: boolean; note?: Note }

const KIND_SEG: [GroupKindFilter, string][] = [['', '全部'], ['group', '群聊'], ['direct', '私聊']]

export function GroupAdminDrawer({ onClose, onOpenConversation, onSend }: {
  onClose: () => void
  /** 「发消息」：带上这个会话打开发消息弹窗 */
  onSend: (conversationId: string) => void
  /** 「看消息」：回到消息列表只看这个会话 */
  onOpenConversation: (channel: string, conversationId: string) => void
}) {
  const summary = useImConversationSummary()
  const defs = useConnectorDefs()
  const projects = useProjects()
  const set = useSetImConversationProjects()
  const [channel, setChannel] = useState('')
  const [kind, setKind] = useState<GroupKindFilter>('')
  const [q, setQ] = useState('')
  const [unset, setUnset] = useState(false)
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const [limit, setLimit] = useState(GROUP_PAGE)
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [note, setNote] = useState<Note | null>(null)
  const [batchProject, setBatchProject] = useState('')
  const refill = useRefillImNames()
  const [rowRefill, setRowRefill] = useState<ReadonlyMap<string, RowRefill>>(() => new Map())

  const all = useMemo(() => summary.data ?? [], [summary.data])
  const channels = useMemo(() => channelTable(defs.data), [defs.data])
  const live: ProjectLite[] = useMemo(() => (projects.data?.data ?? []).filter((p) => !p.deleted_at).map((p) => ({ id: p.id, title: p.title, ref: p.ref })), [projects.data])
  const options: SearchOption[] = useMemo(() => live.map((p) => ({ value: p.id, label: p.title, hint: p.ref, keywords: p.ref })), [live])
  const titleOf = (id: string) => live.find((p) => p.id === id)?.title ?? id
  const rows = useMemo(() => filterGroups(all, { channel, kind, q, unset }), [all, channel, kind, q, unset])
  const sugg = useMemo(() => suggestAll(all, live), [all, live])
  const visibleSugg = rows.filter((s) => sugg.has(s.conversation_id))
  const adopt = adoptable(visibleSugg, sugg)
  const picked = pickedGroups(rows, sel)
  const unsetN = all.filter((s) => (!channel || s.channel === channel) && !s.project_id).length
  const nameOf = (id: string) => { const s = all.find((x) => x.conversation_id === id); return s ? displayName(s) : '' }
  const shown = rows.slice(0, limit)
  const sig = [channel, kind, q.trim(), unset].join('|')
  const [lastSig, setLastSig] = useState(sig)
  if (lastSig !== sig) { setLastSig(sig); setLimit(GROUP_PAGE) }

  /** 发一批（超过 200 个切开按顺序发），回合并的结果；整批 400 等直接报错 */
  const send = async (items: ImConvProjectBatchInput, verb: string) => {
    if (!items.length) return null
    setNote(null)
    const ids = items.map((x) => x.conversation_id)
    setBusy((b) => new Set([...b, ...ids]))
    try {
      const rs: ImConvProjectBatchResult[] = []
      for (const part of chunks(items)) rs.push(await set.mutateAsync(part))
      const r = mergeResults(rs)
      setNote(resultText(r, verb, nameOf))
      return r
    } catch (e) {
      setNote({ text: `没${verb}：${errorText(e)}`, bad: true })
      return null
    } finally {
      setBusy((b) => { const n = new Set(b); for (const id of ids) n.delete(id); return n })
    }
  }

  const setOne = (s: ImConversationSummary, pid: string | null) => {
    void send([{ conversation_id: s.conversation_id, project_id: pid }], pid ? `设为「${titleOf(pid)}」` : '清除归属')
  }
  const setPicked = async (pid: string | null) => {
    const r = await send(picked.map((s) => ({ conversation_id: s.conversation_id, project_id: pid })), pid ? `设为「${titleOf(pid)}」` : '清除归属')
    if (r && !r.failed.length) { setSel(new Set()); setBatchProject('') }
  }

  const markRow = (id: string, x: RowRefill) => setRowRefill((m) => new Map(m).set(id, x))
  /** 行上「查询回填」：之前查不到的也重查；结果写在这一行下面，列表跟着刷新 */
  const refillOne = async (s: ImConversationSummary) => {
    markRow(s.conversation_id, { busy: true })
    try {
      markRow(s.conversation_id, { busy: false, note: refillOneText(await refill.mutateAsync({ conversationId: s.conversation_id })) })
    } catch (e) {
      markRow(s.conversation_id, { busy: false, note: { text: `没查成：${errorText(e)}`, bad: true } })
    }
  }
  /** 「回填全部缺失」：之前查不到的跳过；一次最多回渠道查 100 个，没补完再点 */
  const refillAll = async () => {
    setNote(null)
    try {
      setNote(refillBatchText(await refill.mutateAsync({ all: true })))
    } catch (e) {
      setNote({ text: `没回填成：${errorText(e)}`, bad: true })
    }
  }
  const missingN = refillable(all).length
  const allRefilling = refill.isPending && refill.variables && 'all' in refill.variables

  const sameChannel = new Set(all.map((s) => s.channel)).size <= 1
  let body
  if (summary.isError && !summary.data) {
    body = <ErrorState title="会话没加载出来" error={errorText(summary.error)} onRetry={() => void summary.refetch()} />
  } else if (summary.isPending) {
    body = <LoadingState />
  } else if (!all.length) {
    body = (
      <div className="empty empty-compact">
        <div className="empty-title">还没有会话</div>
        <div className="empty-desc">收到消息后，群和私聊会自动登记到这里</div>
      </div>
    )
  } else {
    body = (
      <>
        {visibleSugg.length > 0 && (
          <div className="im-ga-suggest" role="status">
            <span>按群名能认出 {visibleSugg.length} 个群的项目{visibleSugg.length > adopt.length ? `（${visibleSugg.length - adopt.length} 个有几个候选，要在行上挑）` : ''}</span>
            <span className="spacer" />
            {adopt.length > 0 && (
              <button type="button" className="btn btn-sm btn-outline" disabled={set.isPending}
                title="只采纳只有一个候选的；群名里同时有几个项目关键字的不动"
                onClick={() => void send(adopt, '采纳建议')}>全部采纳 {adopt.length} 个</button>
            )}
          </div>
        )}
        {!rows.length ? (
          <div className="empty empty-compact">
            <div className="empty-title">{unset ? '这里的会话都设好归属了' : '没有匹配的会话'}</div>
            <div className="empty-desc">换个渠道、类型或搜索词看看</div>
          </div>
        ) : (
          <div className="im-ga-list" role="list" aria-label="会话">
            <div className="im-ga-head">
              <input type="checkbox" aria-label={`全选当前 ${Math.min(rows.length, GROUP_BATCH_MAX)} 个会话`}
                checked={picked.length > 0 && picked.length >= Math.min(rows.length, GROUP_BATCH_MAX)}
                ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < Math.min(rows.length, GROUP_BATCH_MAX) }}
                onChange={() => setSel(picked.length ? new Set() : pickAllGroups(rows))} />
              <span>{rows.length} 个会话{rows.length > GROUP_BATCH_MAX ? `，一次最多勾 ${GROUP_BATCH_MAX} 个` : ''}</span>
              <span className="spacer" />
              <span className="im-ga-col">消息</span>
              <span className="im-ga-col">待处理</span>
              <span className="im-ga-proj-h">默认归属</span>
            </div>
            {shown.map((s) => (
              <GroupRow key={s.conversation_id} s={s} chLabel={sameChannel ? null : channelOf(channels, s.channel)}
                picked={sel.has(s.conversation_id)} busy={busy.has(s.conversation_id)} options={options}
                projectsLoading={projects.isPending} projectsError={projects.isError}
                sugg={sugg.get(s.conversation_id)} titleOf={titleOf}
                refill={rowRefill.get(s.conversation_id)} refillLocked={!!allRefilling} onRefill={() => void refillOne(s)}
                onPick={() => setSel((x) => togglePick(x, s.conversation_id))}
                onSet={(pid) => setOne(s, pid)}
                onOpen={() => onOpenConversation(s.channel, s.conversation_id)} onSend={() => onSend(s.conversation_id)}
                memberLabel={channelOf(channels, s.channel).label} onMuted={(text) => setNote({ text, bad: false })} />
            ))}
            {rows.length > limit && (
              <button type="button" className="im-more" onClick={() => setLimit(limit + GROUP_PAGE)}>
                加载更多<span className="seg-n">还有 {rows.length - limit} 个</span>
              </button>
            )}
          </div>
        )}
      </>
    )
  }

  const usedChannels = groupChannels(all)
  return (
    <Drawer open onClose={onClose} kicker="IM 消息" aria-label="群组管理" className="im-gadrawer"
      footer={picked.length > 0 ? (
        <div className="im-ga-bulk" role="toolbar" aria-label="批量设默认归属">
          <span className="im-bulk-n">已选 {picked.length} 个</span>
          {picked.length < Math.min(rows.length, GROUP_BATCH_MAX) && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel(pickAllGroups(rows))}>全选 {Math.min(rows.length, GROUP_BATCH_MAX)} 个</button>
          )}
          <span className="spacer" />
          <SearchSelect value={batchProject} onChange={setBatchProject} options={options} placeholder="选项目" searchPlaceholder="搜项目"
            aria-label="批量设为哪个项目" align="end" disabled={set.isPending}
            emptyText={projects.isError ? '项目没加载出来' : projects.isPending ? '加载中' : '还没有项目'} />
          <button type="button" className="btn btn-sm btn-primary" disabled={!batchProject || set.isPending}
            onClick={() => void setPicked(batchProject)}>设为默认归属</button>
          <button type="button" className="btn btn-sm btn-outline" disabled={set.isPending || !picked.some((s) => s.project_id)}
            title="勾选的会话都改回不归项目" onClick={() => void setPicked(null)}>清除归属</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel(new Set())}>取消选择</button>
        </div>
      ) : undefined}>
      <h2 className="im-chhead">群组管理</h2>
      <p className="im-ga-desc">给群和私聊设默认归属的项目：会话里没单独归项目的消息都算到这个项目，项目「沟通」里能看到；单条消息上另设的优先。选了马上生效。</p>
      <div className="im-ga-tools">
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜群名、成员、项目" aria-label="搜索会话" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="im-seg" role="group" aria-label="会话类型">
          {KIND_SEG.map(([k, label]) => (
            <button key={k || 'all'} type="button" className={cls(kind === k && 'on')} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <button type="button" className={cls('chip', unset && 'chip-on')} aria-pressed={unset} onClick={() => setUnset(!unset)}
          title="只看还没设默认归属的会话">没设归属的{unsetN > 0 && <span className="seg-n">{unsetN}</span>}</button>
        {missingN > 0 && (
          <button type="button" className="btn btn-sm btn-outline" disabled={refill.isPending}
            title="名字只显示渠道编号的会话，回渠道查了补上；一次最多查 100 个、撞上限流就停，之前查不到的跳过（行上「查询回填」会重查）"
            onClick={() => void refillAll()}>{allRefilling ? '回填中…' : '回填全部缺失'}<span className="seg-n">{missingN}</span></button>
        )}
        {usedChannels.length > 1 && (
          <div className="im-channels" role="group" aria-label="渠道">
            <button type="button" className={cls('im-ch', !channel && 'on')} aria-pressed={!channel} onClick={() => setChannel('')}>全部渠道</button>
            {usedChannels.map((k) => {
              const ch = channelOf(channels, k)
              return (
                <button key={k} type="button" className={cls('im-ch', channel === k && 'on')} aria-pressed={channel === k}
                  style={{ '--c': ch.color } as CSSProperties} onClick={() => setChannel(channel === k ? '' : k)}>
                  <i className="im-ch-dot" />{ch.label}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {note && <div className={cls('im-ga-note', note.bad && 'bad')} role={note.bad ? 'alert' : 'status'}>{note.text}</div>}
      {summary.isError && summary.data && <div className="im-err" role="alert">刷新没成功：{errorText(summary.error)}</div>}
      {body}
    </Drawer>
  )
}

function GroupRow({ s, chLabel, picked, busy, options, projectsLoading, projectsError, sugg, titleOf, refill, refillLocked, onRefill, onPick, onSet, onOpen, onSend, memberLabel, onMuted }: {
  s: ImConversationSummary
  /** 只有一个渠道时不标渠道 */
  chLabel: ReturnType<typeof channelOf> | null
  picked: boolean
  busy: boolean
  options: SearchOption[]
  projectsLoading: boolean
  projectsError: boolean
  sugg?: Suggestion
  titleOf: (id: string) => string
  /** 这一行查询回填的进度和结果 */
  refill?: RowRefill
  /** 「回填全部缺失」进行中，行上的按钮先不让点 */
  refillLocked: boolean
  onRefill: () => void
  onPick: () => void
  onSet: (pid: string | null) => void
  onOpen: () => void
  onSend: () => void
  /** 「成员」菜单里写的渠道名；onMuted 是标了、取消自动忽略的结果 */
  memberLabel: string
  onMuted: (text: string) => void
}) {
  const name = displayName(s)
  const direct = s.kind === 'direct'
  const sub = direct ? '私聊' : s.participants.length ? s.participants.join('、') : ''
  return (
    <div role="listitem" className={cls('im-ga-row', picked && 'picked')} aria-label={name}>
      <input type="checkbox" checked={picked} aria-label={`选中 ${name}`} onChange={onPick} />
      <div className="im-ga-main">
        <div className={cls('im-ga-top', needsRefill(s) && 'im-ga-top-refill')}>
          {chLabel && <ChannelMark ch={chLabel} />}
          <button type="button" className="im-ga-name" title={`看「${name}」的消息`} onClick={onOpen}>{name}</button>
          <span className="spacer" />
          {needsRefill(s) && (
            <button type="button" className="im-act im-ga-send" disabled={!s.can_refill || refill?.busy || refillLocked}
              aria-label={`查询回填 ${name}`} title={refillTitle(s)} onClick={onRefill}>{refill?.busy ? '查询中…' : '查询回填'}</button>
          )}
          <button type="button" className="im-act im-ga-send" disabled={!s.total} aria-label={`发消息到 ${name}`}
            title={s.total ? '直接发到这个会话，不挂在哪条消息的消息列里' : '这个会话还没收到过消息，不知道用哪个账号发'} onClick={onSend}>发消息</button>
        </div>
        <div className="im-ga-sub">
          {sub && <span className="im-ga-who" title={sub}>{sub}</span>}
          {s.last_at && <span title={new Date(s.last_at).toLocaleString('zh-CN')}>{timeAgo(s.last_at)}</span>}
          {s.sent > 0 && <span title={s.last_sent_at ? `最近一次 ${new Date(s.last_sent_at).toLocaleString('zh-CN')}` : undefined}>已发 {s.sent} 条</span>}
          {/* 「成员」放在第二行，不占名字那一行的宽度（名字至少留 9 个字宽，SPEC-messages-7.11） */}
          {s.total > 0 && <GroupMembersMenu s={s} chLabel={memberLabel} onDone={onMuted} />}
        </div>
        {refill?.note ? (
          <div className={cls('im-ga-refill', refill.note.bad && 'bad')} role={refill.note.bad ? 'alert' : 'status'}>{refill.note.text}</div>
        ) : s.refill_error && needsRefill(s) ? (
          <div className="im-ga-refill muted" title="行上「查询回填」会重查">上次没查到：{s.refill_error}</div>
        ) : null}
      </div>
      <span className="im-ga-col" title="消息总数">{s.total}</span>
      <span className={cls('im-ga-col', s.pending > 0 && 'im-ga-pending')} title="待处理（不含稍后、已过期）">{s.pending || '—'}</span>
      <div className="im-ga-proj">
        <SearchSelect value={s.project_id ?? ''} options={options} noneLabel="不归项目" placeholder="设为项目" searchPlaceholder="搜项目"
          aria-label={`「${name}」默认归属的项目`} align="end" disabled={busy} missingLabel={() => s.project_name || '已删除的项目'}
          title="这个会话里没单独归项目的消息都算到这个项目；单条消息上另设的优先"
          emptyText={projectsError ? '项目没加载出来' : projectsLoading ? '加载中' : '还没有项目'}
          onChange={(v) => { if ((v || null) !== s.project_id) onSet(v || null) }} />
        {sugg && !s.project_id && (
          <div className="im-ga-sugg" title={suggestReason(sugg)}>
            <span className="im-muted">{sugg.ids.length > 1 ? '可能是' : '建议'}</span>
            {sugg.ids.map((id) => (
              <button key={id} type="button" className="im-ga-adopt" disabled={busy} aria-label={`采纳建议：${titleOf(id)}`} onClick={() => onSet(id)}>{titleOf(id)}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
