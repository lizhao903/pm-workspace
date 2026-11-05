// 群组管理（SPEC-messages-7）：IM 消息页标题行「群组管理」打开的右侧抽屉。
// 列出出现过消息的群和私聊，每行渠道、名字（私聊是对方）、消息数、待处理数、最近一条时间、默认归属项目；
// 行上直接改默认归属，勾选后底部一条批量设、清除（一次最多 200 个）；没设归属的群按群名关键字给建议，能单个采纳或全部采纳。
// 原型的默认归属存在 App 的 groupProjects（会话键 -> 项目 id），和选中群标签时那一行（SPEC-messages-1.50）是同一份；
// 正式产品走 IM 插件 GET /api/im/conversations/summary、PUT /api/im/conversation-projects（批量）。
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IM_CHANNELS, type Contact, type Message } from './data'
import type { Project } from './projectdata'
import { SearchSelect, type SearchOption } from './searchselect'
import { ImMark, cls, timeAgo } from './ui'

/** 一次批量最多几个会话（同正式产品后端） */
export const GROUP_BATCH_MAX = 200

/** 会话键，和 messages.tsx 的 convKey 一致：群按渠道 + 群名，私聊按渠道 + 发信人 */
const keyOf = (m: Message) => (m.conversation ? `g:${m.channel}|${m.conversation}` : `d:${m.channel}:${m.sender_id}`)

export type GroupSummary = {
  key: string; channel: string; direct: boolean; name: string; participants: string[]
  total: number; pending: number; last_at: string
}

/** 按会话汇总；待处理口径同群组标签：待处理、不在稍后里 */
export function summarize(messages: Message[], contacts: Contact[]): GroupSummary[] {
  const who = (m: Message) => contacts.find((c) => c.im[m.channel] === m.sender_id)?.name || m.sender_name || m.sender_id
  const acc = new Map<string, GroupSummary>()
  for (const m of [...messages].sort((a, b) => b.at.localeCompare(a.at))) {
    const k = keyOf(m)
    let s = acc.get(k)
    if (!s) {
      s = { key: k, channel: m.channel, direct: !m.conversation, name: m.conversation, participants: [], total: 0, pending: 0, last_at: m.at }
      acc.set(k, s)
    }
    s.total += 1
    if (m.status === 'pending' && !(m.snooze_until && new Date(m.snooze_until).getTime() > Date.now())) s.pending += 1
    const n = who(m)
    if (s.participants.length < 5 && !s.participants.includes(n)) s.participants.push(n)
  }
  return [...acc.values()]
}

export const displayName = (s: GroupSummary) => (s.direct ? s.participants[0] || '私聊' : s.name)

/**
 * 按群名关键字建议项目（同正式产品 groupAdminModel）：群名先转小写、去掉开头 #、空白和下划线换成 -、两头补 -；
 * 命中内置关键字（acme → Acme、globex → Globex、-ns- → NS 系统）或项目名（不少于 3 个字）的项目都是候选，
 * 按在群名里出现的先后排；只给没设归属的群，私聊不建议。一个候选能直接采纳，几个候选要人挑。
 */
export const SUGGEST_RULES: { keyword: string; projects: string[] }[] = [
  { keyword: 'acme', projects: ['Acme'] },
  { keyword: 'globex', projects: ['Globex'] },
  { keyword: '-ns-', projects: ['NS 系统', 'NS'] },
]
const norm = (s: string) => `-${s.toLowerCase().replace(/^#/, '').replace(/[\s_]+/g, '-')}-`

export function suggestFor(s: GroupSummary, projects: Project[]): string[] {
  if (s.direct || !s.name) return []
  const name = norm(s.name)
  const at = new Map<string, number>()
  const hit = (p: Project | undefined, kw: string) => {
    const i = p ? name.indexOf(kw) : -1
    if (p && i >= 0) at.set(p.id, Math.min(at.get(p.id) ?? i, i))
  }
  for (const r of SUGGEST_RULES) hit(r.projects.map((t) => projects.find((p) => p.name.toLowerCase() === t.toLowerCase())).find(Boolean), r.keyword)
  for (const p of projects) if ([...p.name].length >= 3) hit(p, norm(p.name).slice(1, -1))
  return [...at.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
}

type KindFilter = '' | 'group' | 'direct'

export function GroupAdminDrawer({ messages, contacts, projects, groupProjects, onSetGroupProject, onClose, onOpenConversation, onSend }: {
  messages: Message[]; contacts: Contact[]; projects: Project[]
  groupProjects: Record<string, string>
  onSetGroupProject: (key: string, projectId: string | null) => void
  onClose: () => void
  /** 「看消息」：回到列表只看这个会话 */
  onOpenConversation: (channel: string, key: string) => void
  /** 「发消息」：带上这个会话打开发消息弹窗（SPEC-messages-8） */
  onSend: (key: string) => void
}) {
  const all = useMemo(() => summarize(messages, contacts), [messages, contacts])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<KindFilter>('')
  const [unset, setUnset] = useState(false)
  const [channel, setChannel] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [batchPid, setBatchPid] = useState('')
  const [note, setNote] = useState('')
  const pidOf = (s: GroupSummary) => (groupProjects[s.key] && projects.some((p) => p.id === groupProjects[s.key]) ? groupProjects[s.key] : '')
  const nameOf = (pid: string) => projects.find((p) => p.id === pid)?.name ?? '已删除的项目'
  const kw = q.trim().toLowerCase()
  const rows = all.filter((s) => (!channel || s.channel === channel) && (!kind || (kind === 'direct') === s.direct) && (!unset || !pidOf(s))
    && (!kw || [displayName(s), ...s.participants, pidOf(s) ? nameOf(pidOf(s)) : ''].some((v) => v.toLowerCase().includes(kw))))
  const sugg = new Map(rows.filter((s) => !pidOf(s)).map((s) => [s.key, suggestFor(s, projects)] as const).filter(([, ids]) => ids.length))
  const adopt = [...sugg.entries()].filter(([, ids]) => ids.length === 1)
  const picked = rows.filter((s) => sel.has(s.key))
  const max = Math.min(rows.length, GROUP_BATCH_MAX)
  const options: SearchOption[] = projects.map((p) => ({ value: p.id, label: p.name }))
  const unsetN = all.filter((s) => (!channel || s.channel === channel) && !pidOf(s)).length
  const used = IM_CHANNELS.filter((c) => all.some((s) => s.channel === c.key))

  const setMany = (keys: string[], pid: string | null, verb: string) => {
    for (const k of keys) onSetGroupProject(k, pid)
    setNote(`已${verb}：${keys.length} 个会话`)
  }
  const toggle = (k: string) => setSel((x) => {
    const n = new Set(x)
    if (n.has(k)) n.delete(k)
    else if (n.size < GROUP_BATCH_MAX) n.add(k)
    return n
  })

  const shell = typeof document !== 'undefined' ? document.querySelector('.shell') : null
  const el = (
    <aside className="drawer ga-drawer" aria-label="群组管理">
      <div className="drawer-head">
        <span className="drawer-kicker">IM 消息</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="drawer-body">
        <h2 className="ga-title">群组管理</h2>
        <p className="ga-desc">给群和私聊设默认归属的项目：会话里没单独归项目的消息都算到这个项目，项目「沟通」里能看到；单条消息上另设的优先。选了马上生效。</p>
        <div className="toolbar">
          <div className="search"><input placeholder="搜群名、成员、项目" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="seg">
            {([['', '全部'], ['group', '群聊'], ['direct', '私聊']] as [KindFilter, string][]).map(([k, l]) => (
              <button key={k || 'all'} className={cls(kind === k && 'on')} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
          <button className={cls('chip', unset && 'chip-on')} onClick={() => setUnset(!unset)}>没设归属的{unsetN > 0 && <span className="seg-n">{unsetN}</span>}</button>
          {used.length > 1 && (
            <div className="channel-filter">
              <button className={cls('ch-btn', !channel && 'on')} onClick={() => setChannel('')}>全部渠道</button>
              {used.map((c) => <button key={c.key} className={cls('ch-btn', channel === c.key && 'on')} onClick={() => setChannel(channel === c.key ? '' : c.key)}>{c.label}</button>)}
            </div>
          )}
        </div>
        {note && <div className="ga-note">{note}</div>}
        {sugg.size > 0 && (
          <div className="ga-suggest">
            <span>按群名能认出 {sugg.size} 个群的项目{sugg.size > adopt.length ? `（${sugg.size - adopt.length} 个有几个候选，要在行上挑）` : ''}</span>
            <span className="spacer" />
            {adopt.length > 0 && <button className="btn btn-outline" title="只采纳只有一个候选的" onClick={() => { for (const [k, ids] of adopt) onSetGroupProject(k, ids[0]); setNote(`已采纳建议：${adopt.length} 个会话`) }}>全部采纳 {adopt.length} 个</button>}
          </div>
        )}
        {!rows.length ? <div className="muted">{unset ? '这里的会话都设好归属了' : '没有匹配的会话'}</div> : (
          <div className="ga-list">
            <div className="ga-head">
              <input type="checkbox" checked={picked.length > 0 && picked.length >= max} onChange={() => setSel(picked.length ? new Set() : new Set(rows.slice(0, GROUP_BATCH_MAX).map((s) => s.key)))} aria-label="全选" />
              <span>{rows.length} 个会话</span><span className="spacer" />
              <span className="ga-col">消息</span><span className="ga-col">待处理</span><span className="ga-proj">默认归属</span>
            </div>
            {rows.map((s) => {
              const pid = pidOf(s)
              const ids = sugg.get(s.key) ?? []
              const ch = IM_CHANNELS.find((c) => c.key === s.channel)
              return (
                <div key={s.key} className={cls('ga-row', sel.has(s.key) && 'picked')}>
                  <input type="checkbox" checked={sel.has(s.key)} onChange={() => toggle(s.key)} aria-label={`选中 ${displayName(s)}`} />
                  <div className="ga-main">
                    <div className="ga-top">{ch && used.length > 1 && <ImMark ch={ch} compact />}<button className="ga-name" onClick={() => onOpenConversation(s.channel, s.key)} title="看这个会话的消息">{displayName(s)}</button><span className="spacer" /><button className="act" onClick={() => onSend(s.key)} title="直接发到这个会话，不挂在哪条消息的消息列里">发消息</button></div>
                    <div className="ga-sub"><span className="ga-who">{s.direct ? '私聊' : s.participants.join('、')}</span><span>{timeAgo(s.last_at)}</span></div>
                  </div>
                  <span className="ga-col">{s.total}</span>
                  <span className={cls('ga-col', s.pending > 0 && 'ga-pending')}>{s.pending || '—'}</span>
                  <div className="ga-proj">
                    <SearchSelect value={pid} options={options} noneLabel="不归项目" placeholder="设为项目" searchPlaceholder="搜项目" align="end"
                      missingLabel={() => '已删除的项目'} onChange={(v) => { onSetGroupProject(s.key, v || null); setNote(v ? `已设为「${nameOf(v)}」：1 个会话` : '已清除归属：1 个会话') }} />
                    {ids.length > 0 && (
                      <div className="ga-sugg" title="群名里有项目关键字">
                        <span className="muted">{ids.length > 1 ? '可能是' : '建议'}</span>
                        {ids.map((id) => <button key={id} className="ga-adopt" onClick={() => { onSetGroupProject(s.key, id); setNote(`已设为「${nameOf(id)}」：1 个会话`) }}>{nameOf(id)}</button>)}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {picked.length > 0 && (
        <div className="drawer-foot">
          <span className="ga-bulk-n">已选 {picked.length} 个</span>
          {picked.length < max && <button className="btn btn-ghost" onClick={() => setSel(new Set(rows.slice(0, GROUP_BATCH_MAX).map((s) => s.key)))}>全选 {max} 个</button>}
          <span className="spacer" />
          <SearchSelect value={batchPid} onChange={setBatchPid} options={options} placeholder="选项目" searchPlaceholder="搜项目" align="end" />
          <button className="btn btn-primary" disabled={!batchPid} onClick={() => { setMany(picked.map((s) => s.key), batchPid, `设为「${nameOf(batchPid)}」`); setSel(new Set()); setBatchPid('') }}>设为默认归属</button>
          <button className="btn btn-outline" disabled={!picked.some((s) => pidOf(s))} onClick={() => { setMany(picked.map((s) => s.key), null, '清除归属'); setSel(new Set()) }}>清除归属</button>
          <button className="btn btn-ghost" onClick={() => setSel(new Set())}>取消选择</button>
        </div>
      )}
    </aside>
  )
  // 抽屉停靠在外壳右边（同 App 的 drawerEl）；单独渲染时就地显示
  return shell ? createPortal(el, shell) : el
}
