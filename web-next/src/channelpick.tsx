// 「监听频道」的列表选择（SPEC-settings-4.7c）：列出连接器 Token 看得到的频道、私有频道、多人私信，搜索、勾选，
// 已选的在上面单独一行，也排在列表前面。值仍是一段文本（逗号分隔，每项是会话编号或名字，# 可带可不带）；
// 勾选新增的写编号，旧值里的 #名字 不改写，按名字对上就显示成已选。拿不到列表时退回文本框。
// 正式产品见 frontend/src/modules/settings/connectors/ChannelPicker.tsx，列表来自 GET /api/im/connectors/{id}/conversations。
import { useState } from 'react'
import { IM_CONVERSATIONS, IM_CONVERSATIONS_NOTE, type Connector, type ImConvKind, type ImConvOption } from './data'
import { cls } from './ui'

type Token = { raw: string; key: string }

export function splitChannelTokens(value: string): Token[] {
  const out: Token[] = []
  for (const p of value.split(/[,，、\s]+/)) {
    const raw = p.trim()
    const key = raw.replace(/^#/, '')
    if (key && !out.some((t) => t.key === key)) out.push({ raw, key })
  }
  return out
}

const matches = (t: Token, c: ImConvOption) => t.key === c.id || (!!c.name && t.key.toLowerCase() === c.name.toLowerCase())
const join = (ts: Token[]) => ts.map((t) => t.raw).join(',')

export function toggleChannel(value: string, c: ImConvOption, on: boolean): string {
  const ts = splitChannelTokens(value)
  if (on) return ts.some((t) => matches(t, c)) ? value : join([...ts, { raw: c.id, key: c.id }])
  return join(ts.filter((t) => !matches(t, c)))
}

/** 显示名：频道 #名字；多人私信 mpdm-a--b--c-1 显示成「a、b、c」 */
export function convLabel(c: ImConvOption): string {
  if (c.kind === 'mpim') {
    const people = c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').filter(Boolean)
    return people.length ? people.join('、') : c.id
  }
  return c.name ? `#${c.name}` : c.id
}

const KIND_LABEL: Record<ImConvKind, string> = { public: '公开频道', private: '私有频道', mpim: '多人私信' }

/** 连接器监听的频道的显示名：对上列表的是 #名字，对不上的照原文（项目绑群的候选用，SPEC-projects-4.4） */
export function listenedChannels(c: Pick<Connector, 'id' | 'config'>): string[] {
  const items = IM_CONVERSATIONS[c.id] ?? []
  return splitChannelTokens(c.config.channels ?? '').map((t) => {
    const it = items.find((x) => matches(t, x))
    return it ? convLabel(it) : t.raw.startsWith('#') || /^[CGD][0-9A-Z]{6,}$/.test(t.raw) ? t.raw : `#${t.raw}`
  })
}

const ROWS_MAX = 200

export function ChannelPicker({ connector, value, onChange, placeholder }: {
  /** 已保存的连接器；新建时为 null */
  connector: Connector | null
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [manual, setManual] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const text = <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />

  if (!connector) return <>{text}<span className="field-hint-line">先保存并测试连接后可从列表选择</span></>
  if (connector.status === 'paused' || connector.status === 'disconnected') {
    return <>{text}<span className="field-hint-line">连接器{connector.status === 'paused' ? '已暂停' : '已断开'}，连接后才能从列表选择；可以直接填编号或 #名字</span></>
  }
  if (connector.status === 'error') {
    return <>{text}<span className="danger-text">没能读取频道列表：{connector.error ?? '连接异常'}；可以直接填编号或 #名字</span></>
  }

  // 同正式产品：频道在前、多人私信在后，各自按名字排
  const items = [...(IM_CONVERSATIONS[connector.id] ?? [])]
    .sort((a, b) => Number(a.kind === 'mpim') - Number(b.kind === 'mpim') || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  const incomplete = IM_CONVERSATIONS_NOTE[connector.id]
  const ts = splitChannelTokens(value)
  const picked = ts.map((t) => ({ t, it: items.find((c) => matches(t, c)) }))
  const kw = q.trim().replace(/^#/, '').toLowerCase()
  const hit = items.filter((c) => !kw || `${c.name}\n${convLabel(c)}\n${c.id}`.toLowerCase().includes(kw))
  const on = (c: ImConvOption) => ts.some((t) => matches(t, c))
  const shown = [...hit.filter(on), ...hit.filter((c) => !on(c))]
  return (
    <div className="chan-pick">
      <div className="chan-picked">
        {!picked.length && <span className="muted">还没选，只收私信和多人私信</span>}
        {picked.map(({ t, it }) => (
          <span key={t.key} className={cls('chan-chip', !it && 'missing')} title={it ? it.id : 'Token 看不到这个会话：Bot 没被加进去、已改名或列表没列全'}>
            {it ? convLabel(it) : t.raw}{!it && <em>未找到</em>}
            <button type="button" aria-label="移除" onClick={() => onChange(join(ts.filter((x) => x.key !== t.key && !(it && matches(x, it)))))}>×</button>
          </span>
        ))}
      </div>
      <div className="chan-bar">
        <input className="chan-search" placeholder="搜频道名或编号" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <span className="muted">已选 {picked.length} · 共 {items.length} 个</span>
        {/* 原型模拟一次重查；正式产品重新调列会话接口 */}
        <button type="button" className="act act-quiet" disabled={refreshing}
          onClick={() => { setRefreshing(true); window.setTimeout(() => setRefreshing(false), 600) }}>{refreshing ? '刷新中…' : '刷新'}</button>
      </div>
      <div className="chan-list">
        {shown.slice(0, ROWS_MAX).map((c) => (
          <label key={c.id} className={cls('chan-row', on(c) && 'on')}>
            <input type="checkbox" checked={on(c)} onChange={(e) => onChange(toggleChannel(value, c, e.target.checked))} />
            <span className="chan-name">{convLabel(c)}</span>
            {c.kind !== 'public' && <span className="chan-tag">{KIND_LABEL[c.kind]}</span>}
            {c.is_archived && <span className="chan-tag warn">已归档</span>}
            <span className="spacer" />
            <code className="mono muted">{c.id}</code>
          </label>
        ))}
        {!shown.length && <div className="chan-empty">{items.length ? '没有匹配的频道' : 'Token 还不在任何频道里：Bot 身份先把 Bot 加进频道'}</div>}
        {shown.length > ROWS_MAX && <div className="muted chan-more">还有 {shown.length - ROWS_MAX} 个没显示，搜索缩小范围</div>}
      </div>
      {incomplete && <div className="chan-warn">{incomplete}</div>}
      <div className="chan-note">
        <span className="muted">列的是 Token 所在的会话；私信、多人私信本来就全收，勾多人私信不影响。不在列表里的可以手动填</span>
        <button type="button" className="act act-quiet" onClick={() => setManual(!manual)}>{manual ? '收起手动填写' : '手动填写'}</button>
      </div>
      {manual && text}
    </div>
  )
}
