// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { PageTitle } from './topbar'
import { cls } from './ui'
import './videobili.css'

// 视频模块的「B 站」组件（TSK-0455，规格 docs/spec/videos.md「B 站组件」）：扫码登录 B 站网页端，看个人账户数据和按天趋势，收发私信。
// 原型里数据都是编的，扫码、发送、风控用按钮模拟；正式实现见 frontend/src/plugins/video/BiliPage.tsx 和后端 internal/plugins/video/biliapi.go。
// 网页端是非官方接口：登录凭证（Cookie）存在保险箱里，页面上只有登录状态、昵称；被限频、风控时暂停请求、显示原因，不连续重试。

export type BiliLogin = 'logged_out' | 'logged_in' | 'expired'
export type BiliGuard = { until: string; reason: string }
export type BiliSnapshot = {
  date: string
  source: 'web' | 'open+web'
  followers: number; following: number; archives?: number
  total_click: number; total_like: number; total_coin: number; total_fav: number; total_reply: number; total_dm: number; total_share: number; total_elec: number
  incr_fans: number; incr_click: number
}
export type BiliTrendMetric = 'click' | 'like' | 'coin' | 'fav' | 'elec'
export type BiliSession = { talker_id: string; talker_name: string; unread: number; last_text: string; last_at: string }
export type BiliMessage = { id: string; talker_id: string; direction: 'in' | 'out'; text: string; at: string; status: 'received' | 'sending' | 'sent' | 'failed'; error?: string }

const DAY = 86400000
const iso = (ms: number) => new Date(ms).toISOString()
const ymdOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const now0 = Date.now()

/** 近 30 天的按天增量：播放、点赞、投币、收藏、充电（创作中心的 pandect） */
const seedTrends = (): Record<BiliTrendMetric, { date: string; value: number }[]> => {
  const base: Record<BiliTrendMetric, number> = { click: 1800, like: 160, coin: 40, fav: 70, elec: 1 }
  const out = {} as Record<BiliTrendMetric, { date: string; value: number }[]>
  for (const k of Object.keys(base) as BiliTrendMetric[]) {
    out[k] = Array.from({ length: 30 }, (_, i) => {
      const wave = 1 + 0.45 * Math.sin(i / 3.2) + (i === 22 ? 1.8 : 0)
      return { date: ymdOf(now0 - (30 - i) * DAY), value: Math.max(0, Math.round(base[k] * wave)) }
    })
  }
  return out
}
const seedFollowers = () => Array.from({ length: 14 }, (_, i) => ({ date: ymdOf(now0 - (13 - i) * DAY), value: 3300 + i * 11 + (i > 9 ? 40 : 0) }))

const SNAP: BiliSnapshot = {
  date: ymdOf(now0), source: 'open+web', followers: 3450, following: 11, archives: 7, total_click: 120345, total_like: 8811, total_coin: 1203,
  total_fav: 2310, total_reply: 640, total_dm: 991, total_share: 312, total_elec: 15, incr_fans: 21, incr_click: 1530,
}

const seedSessions = (): BiliSession[] => [
  { talker_id: '777001', talker_name: '热心观众', unread: 2, last_text: '在吗', last_at: iso(now0 - 12 * 60000) },
  { talker_id: '888002', talker_name: '品牌方小王', unread: 1, last_text: '想约一期商单，方便留个邮箱吗', last_at: iso(now0 - 3 * 3600000) },
  { talker_id: '999003', talker_name: '剪辑同好', unread: 0, last_text: '谢谢分享工程文件！', last_at: iso(now0 - 2 * DAY) },
]
const seedMessages = (): BiliMessage[] => [
  { id: 'bpm_01', talker_id: '777001', direction: 'in', text: '请问视频里的模板哪里下载', at: iso(now0 - 40 * 60000), status: 'received' },
  { id: 'bpm_02', talker_id: '777001', direction: 'out', text: '简介里有链接哦', at: iso(now0 - 30 * 60000), status: 'sent' },
  { id: 'bpm_03', talker_id: '777001', direction: 'in', text: '找到了，谢谢', at: iso(now0 - 13 * 60000), status: 'received' },
  { id: 'bpm_04', talker_id: '777001', direction: 'in', text: '在吗', at: iso(now0 - 12 * 60000), status: 'received' },
  { id: 'bpm_05', talker_id: '888002', direction: 'in', text: '想约一期商单，方便留个邮箱吗', at: iso(now0 - 3 * 3600000), status: 'received' },
  { id: 'bpm_06', talker_id: '999003', direction: 'out', text: '工程文件在网盘里', at: iso(now0 - 2 * DAY - 600000), status: 'sent' },
  { id: 'bpm_07', talker_id: '999003', direction: 'in', text: '谢谢分享工程文件！', at: iso(now0 - 2 * DAY), status: 'received' },
]

export const BILI_STATS: { key: keyof BiliSnapshot; label: string; incr?: 'incr_fans' | 'incr_click' }[] = [
  { key: 'followers', label: '粉丝', incr: 'incr_fans' }, { key: 'total_click', label: '总播放', incr: 'incr_click' }, { key: 'total_like', label: '获赞' },
  { key: 'total_coin', label: '投币' }, { key: 'total_fav', label: '收藏' }, { key: 'total_elec', label: '充电' }, { key: 'total_reply', label: '评论' },
  { key: 'total_dm', label: '弹幕' }, { key: 'total_share', label: '分享' }, { key: 'following', label: '关注' }, { key: 'archives', label: '过审稿件' },
]
type CurveKey = BiliTrendMetric | 'followers'
const CURVES: { key: CurveKey; label: string; desc: string }[] = [
  { key: 'click', label: '播放', desc: '每天新增播放（创作中心近 30 天）' }, { key: 'like', label: '点赞', desc: '每天新增点赞（创作中心近 30 天）' },
  { key: 'coin', label: '投币', desc: '每天新增投币（创作中心近 30 天）' }, { key: 'fav', label: '收藏', desc: '每天新增收藏（创作中心近 30 天）' },
  { key: 'elec', label: '充电', desc: '每天新增充电（创作中心近 30 天）' }, { key: 'followers', label: '粉丝', desc: '每天的粉丝总数（本地每天一次快照攒出来的）' },
]
const LOGIN: Record<BiliLogin, { label: string; color: string }> = {
  logged_in: { label: '已登录', color: 'var(--ok, #16a34a)' }, logged_out: { label: '未登录', color: 'var(--faint)' }, expired: { label: '登录已失效', color: 'var(--warn, #d97706)' },
}
const two = (n: number) => String(n).padStart(2, '0')
const shortTime = (s: string) => { const d = new Date(s); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` }
const msgTime = (s: string) => { const d = new Date(s); return ymdOf(d.getTime()) === ymdOf(Date.now()) ? `${two(d.getHours())}:${two(d.getMinutes())}` : shortTime(s) }
const big = (n?: number) => (n == null ? '-' : n >= 100000 ? `${+(n / 10000).toFixed(1)} 万` : n.toLocaleString('zh-CN'))
const TEXT_MAX = 500

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as CSSProperties}><span className="pill-dot" />{label}</span>
const Face = ({ name, size = 32 }: { name: string; size?: number }) => (
  <span className="bl-face" style={{ width: size, height: size, fontSize: size * 0.42 } as CSSProperties} aria-hidden="true">{Array.from(name).slice(-1)[0] ?? 'B'}</span>
)

/** 占位二维码：原型不连 B 站，画一个像二维码的格子（正式版是后端生成的真二维码） */
function FakeQR() {
  const cells = useMemo(() => {
    const out: [number, number][] = []
    let s = 7
    for (let y = 0; y < 25; y++) for (let x = 0; x < 25; x++) {
      const finder = (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17)
      if (finder) {
        const fx = x > 17 ? x - 18 : x, fy = y > 17 ? y - 18 : y
        const d = Math.max(Math.abs(fx - 3), Math.abs(fy - 3))
        if (d !== 2) out.push([x, y])
        continue
      }
      s = (s * 1103515245 + 12345) & 0x7fffffff
      if (s % 3 === 0) out.push([x, y])
    }
    return out
  }, [])
  return (
    <svg viewBox="-2 -2 29 29" width="180" height="180" role="img" aria-label="B 站登录二维码（原型占位）" shapeRendering="crispEdges">
      <rect x="-2" y="-2" width="29" height="29" fill="#fff" />
      {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#000" />)}
    </svg>
  )
}

export function BiliPage({ tabs }: { tabs?: ReactNode }) {
  const [login, setLogin] = useState<BiliLogin>('logged_in')
  const [view, setView] = useState<'overview' | 'dm'>('overview')
  const [guard, setGuard] = useState<BiliGuard | null>(null)
  const [snap, setSnap] = useState<BiliSnapshot>(SNAP)
  const [pulledAt, setPulledAt] = useState(iso(now0 - 2 * 3600000))
  const [sessions, setSessions] = useState(seedSessions)
  const [messages, setMessages] = useState(seedMessages)
  const [talker, setTalker] = useState<string | null>(null)
  const [askLogout, setAskLogout] = useState(false)
  const unread = sessions.reduce((n, s) => n + s.unread, 0)
  const guarded = guard && new Date(guard.until).getTime() > Date.now()

  /** 演示风控：之后 4 分钟不发请求（第二次被拦会翻倍） */
  const tripGuard = () => setGuard({ until: iso(Date.now() + 4 * 60000), reason: 'B 站网页接口返回 -412：请求被拦截（被限频或风控，已暂停请求，稍后自动再试）' })
  const guardText = guarded ? `B 站请求暂停到 ${shortTime(guard!.until)}，期间不发任何请求，到点后自动恢复。原因：${guard!.reason}` : null

  return (
    <div className="page bl-page">
      <PageTitle parent="视频" desc="B 站账户数据、按天趋势和私信。网页端是非官方接口，可能变化；登录凭证存在保险箱里，页面上看不到">B 站</PageTitle>
      {tabs}
      <section className="bl-acc">
        <div className="bl-acc-main">
          <Face name="测试UP主" size={40} />
          <div className="bl-acc-text">
            <div className="bl-acc-name"><b>{login === 'logged_out' ? 'B 站网页登录' : '测试UP主'}</b><Pill {...LOGIN[login]} /></div>
            <div className="bl-acc-sub">
              {login === 'logged_out' ? '还没登录' : 'UID 4242'}{login !== 'logged_out' && <> · 数据 {shortTime(pulledAt)} 拉取</>}
              {login === 'logged_in' && <> · 每 60 秒查一次新私信</>}
            </div>
          </div>
          <span className="spacer" />
          {login === 'logged_in' && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={tripGuard} title="原型演示：模拟 B 站返回 -412">演示风控</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setLogin('expired')} title="原型演示：模拟 Cookie 过期">演示失效</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setAskLogout(true)}>退出登录</button>
            </>
          )}
        </div>
        {guardText && <div className="bl-banner" role="status">{guardText}</div>}
        {login === 'expired' && <div className="bl-banner" role="status">B 站登录已失效，到「视频 / B 站」重新扫码登录</div>}
      </section>
      {askLogout && (
        <div className="bl-confirm" role="dialog" aria-label="退出 B 站登录">
          <div>退出登录会清掉保险箱里的登录凭证，停止拉新私信；已经拉到的数据和私信留着。</div>
          <div className="bl-confirm-acts">
            <button className="btn btn-ghost btn-sm" onClick={() => setAskLogout(false)}>取消</button>
            <button className="btn btn-primary btn-sm" onClick={() => { setAskLogout(false); setLogin('logged_out') }}>退出登录</button>
          </div>
        </div>
      )}
      {login !== 'logged_in' ? <QRLogin expired={login === 'expired'} onDone={() => setLogin('logged_in')} /> : (
        <>
          <div className="np-tabs bl-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'overview'} className={cls(view === 'overview' && 'on')} onClick={() => setView('overview')}>账户概览</button>
            <button role="tab" aria-selected={view === 'dm'} className={cls(view === 'dm' && 'on')} onClick={() => setView('dm')}>
              私信{unread > 0 && <span className="vd-mtab-n">{unread}</span>}
            </button>
          </div>
          {view === 'overview'
            ? <Overview snap={snap} pulledAt={pulledAt} guard={guardText}
              onRefresh={() => { if (guarded) return; setSnap((s) => ({ ...s, followers: s.followers + 3, total_click: s.total_click + 120 })); setPulledAt(iso(Date.now())) }} />
            : <Inbox sessions={sessions} messages={messages} talker={talker} guard={guardText}
              onTalker={(t) => { setTalker(t); if (t) setSessions((xs) => xs.map((s) => (s.talker_id === t ? { ...s, unread: 0 } : s))) }}
              onSend={(t, text) => {
                const m: BiliMessage = { id: `bpm_${Date.now()}`, talker_id: t, direction: 'out', text, at: iso(Date.now()), status: guarded ? 'failed' : 'sent',
                  error: guarded ? guard!.reason : undefined }
                setMessages((xs) => [...xs, m])
                if (!guarded) setSessions((xs) => xs.map((s) => (s.talker_id === t ? { ...s, last_text: text, last_at: m.at } : s)))
                return !guarded
              }}
              onIncoming={() => {
                // 原型演示：对方来一条新私信（正式版由后台每 60 秒拉一轮，有新的发通知）
                const m: BiliMessage = { id: `bpm_${Date.now()}`, talker_id: '888002', direction: 'in', text: '报价单发您邮箱了，看下哈', at: iso(Date.now()), status: 'received' }
                setMessages((xs) => [...xs, m])
                setSessions((xs) => xs.map((s) => (s.talker_id === '888002' ? { ...s, unread: s.unread + 1, last_text: m.text, last_at: m.at } : s)))
              }} />}
        </>
      )}
    </div>
  )
}

function QRLogin({ expired, onDone }: { expired: boolean; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'waiting' | 'scanned'>('idle')
  const t = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(t.current), [])
  const start = () => { setState('waiting'); window.clearTimeout(t.current); t.current = window.setTimeout(() => setState('scanned'), 2500) }
  return (
    <section className="bl-sec bl-login">
      <div className="bl-sec-title">{expired ? '登录已失效，重新扫码登录' : '扫码登录 B 站'}</div>
      <div className="bl-login-body">
        <div className={cls('bl-qr', state === 'idle' && 'dim')}>{state === 'idle' ? <span className="bl-faint">点下面的按钮生成二维码</span> : <FakeQR />}</div>
        <div className="bl-login-text">
          <ol className="bl-steps"><li>点「生成二维码」</li><li>打开 B 站 App，用右上角的扫一扫扫码</li><li>在手机上点「确认登录」</li></ol>
          <p className="bl-faint">只用扫码，不填密码。登录后 Cookie 存进保险箱，页面上只显示昵称和登录状态；二维码 3 分钟内有效。</p>
          {state === 'waiting' && <div className="bl-login-state">等待扫码</div>}
          {state === 'scanned' && <div className="bl-login-state ok">已扫码，在手机上确认登录</div>}
          <div className="bl-login-acts">
            <button className="btn btn-primary" disabled={state !== 'idle'} onClick={start}>{state === 'idle' ? '生成二维码' : '重新生成二维码'}</button>
            {state === 'scanned' && <button className="btn btn-ghost" onClick={onDone} title="原型演示">模拟手机确认</button>}
          </div>
        </div>
      </div>
    </section>
  )
}

function Overview({ snap, pulledAt, guard, onRefresh }: { snap: BiliSnapshot; pulledAt: string; guard: string | null; onRefresh: () => void }) {
  const trends = useMemo(seedTrends, [])
  const followers = useMemo(seedFollowers, [])
  const [curve, setCurve] = useState<CurveKey>('click')
  const pts = curve === 'followers' ? followers : trends[curve]
  const c = CURVES.find((x) => x.key === curve)!
  const max = Math.max(1, ...pts.map((p) => p.value))
  return (
    <div className="bl-ov">
      <div className="bl-sec-head">
        <span className="bl-sec-title">账户数据</span>
        <span className="bl-faint bl-note">{snap.date} 的数据，{shortTime(pulledAt)} 拉取{snap.source === 'open+web' && '；粉丝、关注、过审稿件取开放平台'}</span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={!!guard} title={guard ? '退避中，到点后再刷新' : '每天自动拉一次；一次 8 个请求，按限频排队'}>刷新数据</button>
      </div>
      <div className="bl-stats">
        {BILI_STATS.map((s) => (
          <div key={s.key} className="bl-stat">
            <span>{s.label}</span>
            <b>{big(snap[s.key] as number | undefined)}</b>
            {s.incr && <em className="bl-inc">昨日 +{snap[s.incr].toLocaleString('zh-CN')}</em>}
          </div>
        ))}
      </div>
      <section className="bl-sec">
        <div className="bl-sec-head">
          <span className="bl-sec-title">按天趋势</span>
          <div className="bl-chips">
            {CURVES.map((x) => <button key={x.key} className={cls('bl-chip', curve === x.key && 'on')} onClick={() => setCurve(x.key)}>{x.label}</button>)}
          </div>
        </div>
        <div className="bl-faint bl-note">{c.desc}</div>
        <div className="bl-bars" role="img" aria-label={`${c.label}按天`}>
          <div className="bl-bars-plot">
            {pts.map((p) => <span key={p.date} className="bl-bar" title={`${p.date}：${p.value.toLocaleString('zh-CN')}`} style={{ '--h': `${Math.max(2, (p.value / max) * 100)}%` } as CSSProperties} />)}
          </div>
          <div className="bl-bars-axis"><span>{pts[0].date.slice(5)}</span><span>最高 {big(max)}</span><span>{pts[pts.length - 1].date.slice(5)}</span></div>
        </div>
      </section>
    </div>
  )
}

function Inbox({ sessions, messages, talker, guard, onTalker, onSend, onIncoming }: {
  sessions: BiliSession[]; messages: BiliMessage[]; talker: string | null; guard: string | null
  onTalker: (t: string | null) => void; onSend: (t: string, text: string) => boolean; onIncoming: () => void
}) {
  const list = [...sessions].sort((a, b) => b.last_at.localeCompare(a.last_at))
  const cur = talker ? sessions.find((s) => s.talker_id === talker) : undefined
  return (
    <div className="bl-inbox-wrap">
      <div className="bl-sec-head">
        <span className="bl-faint bl-note">{shortTime(iso(Date.now() - 40000))} 查过新私信；第一次只记下现有会话，之后来的新私信才发通知</span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onIncoming} title="原型演示：对方发来一条新私信">演示来信</button>
        <button className="btn btn-ghost btn-sm" disabled={!!guard}>查新私信</button>
      </div>
      {guard && <div className="bl-banner" role="status">{guard}</div>}
      <div className={cls('bl-inbox', cur && 'has-cur')}>
        <ul className="bl-sessions" aria-label="私信会话">
          {list.map((s) => (
            <li key={s.talker_id}>
              <button className={cls('bl-session', s.talker_id === talker && 'sel')} onClick={() => onTalker(s.talker_id)}>
                <Face name={s.talker_name} />
                <span className="bl-session-main">
                  <span className="bl-session-top"><b className="ellipsis">{s.talker_name}</b><span className="bl-faint">{msgTime(s.last_at)}</span></span>
                  <span className="bl-session-last ellipsis">{s.last_text}</span>
                </span>
                {s.unread > 0 && <span className="vd-mtab-n">{s.unread}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="bl-chat-pane">
          {cur ? <Chat key={cur.talker_id} s={cur} messages={messages.filter((m) => m.talker_id === cur.talker_id)} onBack={() => onTalker(null)}
            onSend={(text) => onSend(cur.talker_id, text)} />
            : <div className="bl-chat-none bl-faint">选一个会话看消息</div>}
        </div>
      </div>
    </div>
  )
}

function Chat({ s, messages, onBack, onSend }: { s: BiliSession; messages: BiliMessage[]; onBack: () => void; onSend: (text: string) => boolean }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length])
  const left = TEXT_MAX - [...text].length
  const send = () => {
    const t = text.trim()
    if (!t || left < 0) return
    if (onSend(t)) { setText(''); setErr(null) } else setErr('没发出去：B 站请求暂停中，到点后再发')
  }
  return (
    <div className="bl-chat">
      <div className="bl-chat-head">
        <button className="btn btn-ghost btn-sm bl-back" onClick={onBack}>返回</button>
        <b className="ellipsis">{s.talker_name}</b><span className="bl-faint">UID {s.talker_id}</span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm">拉取消息</button>
      </div>
      <div className="bl-msgs">
        {messages.map((m) => (
          <div key={m.id} className={cls('bl-msg', m.direction, m.status === 'failed' && 'failed')}>
            <div className="bl-bubble">{m.text}</div>
            <div className="bl-msg-meta"><span>{msgTime(m.at)}</span>{m.status === 'failed' && <span className="bl-danger">没发出去</span>}</div>
            {m.error && <div className="bl-msg-err">{m.error}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="bl-compose">
        <textarea className="bl-input" rows={2} value={text} placeholder={`发给 ${s.talker_name}（只发文字，一次一条）`} aria-label="私信内容"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
        <div className="bl-compose-bar">
          <span className={cls('bl-faint', left < 0 && 'bl-bad')}>{left < 0 ? `超了 ${-left} 字` : `还能写 ${left} 字`}</span>
          {err && <span className="bl-danger">{err}</span>}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={!text.trim() || left < 0} onClick={send}>发送</button>
        </div>
      </div>
    </div>
  )
}
