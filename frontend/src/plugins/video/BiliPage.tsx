// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// B 站组件（TSK-0455，SPEC-videos B 站一节，照原型 web-next/src/videobili.tsx）：视频模块标签栏里的「B 站」页。
// 一个 bilibili_web 连接器实例一个 B 站账号：没登录时显示扫码登录（二维码由后端生成，用户自己用 B 站 App 扫），
// 登录后两个小标签：账户概览（数字卡加按天趋势，手动刷新）、私信（会话列表加会话详情加发送框）。
// 地址上记着 ?c=<连接器 id>、?v=dm 私信、?t=<对方 UID>，刷新还在。
// 被限频、风控时后端回退避说明，这里照着显示，不自己重试；发私信只在点「发送」时发，一次一条。
// 网页端是非官方接口，可能变化；凭证存在保险箱里，页面上拿不到也不显示
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  BILI_TEXT_MAX, biliGuardOf, errorText, newClientMsgId, useBiliAccounts, useBiliLogout, useBiliMessages, useBiliOverview, useBiliPoll, useBiliQRCode,
  useBiliRefreshOverview, useBiliRefreshSessions, useBiliSend, useBiliSessions, useBiliSyncTalker, useCreateConnector,
  type BiliAccount, type BiliMessage, type BiliPollState, type BiliQRCode, type Video,
} from '../../core/data'
import { Avatar, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageTitle, Pill, Textarea, cls } from '../../core/ui'
import {
  BILI_CURVES, BILI_STATS, LOGIN_LABEL, biliNum, curveOf, guardText, leftChars, msgTime, shortTime, type BiliCurveKey,
} from './biliModel'
import { VideosTabs, type ModuleTab } from './parts'
import './bili.css'

type View = 'overview' | 'dm'

/** 出错的说明：退避中的按退避说明写，别的取错误文字 */
function failText(e: unknown): string {
  const g = biliGuardOf(e)
  return g ? guardText(g) ?? errorText(e) : errorText(e)
}

/** 会话里的出错说明：退避的原因账号条上已经写了，这里只说一句，不再重复整段 */
function chatFailText(e: unknown): string {
  return biliGuardOf(e) ? 'B 站请求暂停中，原因和恢复时间见上方说明；到点后再点一次' : errorText(e)
}

export function BiliPage({ videos, onModuleTab }: { videos: Video[]; onModuleTab: (t: ModuleTab) => void }) {
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const accounts = useBiliAccounts()
  const create = useCreateConnector()
  const view: View = search.get('v') === 'dm' ? 'dm' : 'overview'
  const setParams = (x: Record<string, string>, push = false) => {
    const next = new URLSearchParams(search)
    for (const [k, v] of Object.entries(x)) { if (v) next.set(k, v); else next.delete(k) }
    setSearch(next, { replace: !push })
  }

  const head = (
    <>
      <PageTitle parent="视频" desc="B 站账户数据、按天趋势和私信。网页端是非官方接口，可能变化；登录凭证存在保险箱里，页面上看不到">B 站</PageTitle>
      <VideosTabs active="bilibili" videos={videos} onSelect={onModuleTab} />
    </>
  )
  if (accounts.isPending) return <div className="vd-page">{head}<LoadingState /></div>
  if (accounts.isError) {
    return <div className="vd-page">{head}<ErrorState title="B 站账号没加载出来" error={errorText(accounts.error)} onRetry={() => void accounts.refetch()} /></div>
  }
  const list = accounts.data ?? []
  if (!list.length) {
    return (
      <div className="vd-page">{head}
        <EmptyState title="还没接 B 站网页登录"
          desc="新建一个「B 站网页登录」连接，再用 B 站 App 扫码登录。只查自己账号的数据、收发私信；凭证进保险箱，不在页面上出现"
          action={(
            <div className="bl-empty-acts">
              <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate({ tool: 'bilibili_web' })}>
                {create.isPending ? '正在新建' : '新建并扫码登录'}
              </Button>
              <Button onClick={() => void navigate('/settings/connectors?tool=bilibili_web')}>去连接器页</Button>
            </div>
          )} />
        {create.isError && <div className="vd-banner" role="alert">{errorText(create.error)}</div>}
      </div>
    )
  }
  const acc = list.find((a) => a.connector_id === search.get('c')) ?? list[0]

  return (
    <div className="vd-page">
      {head}
      {list.length > 1 && (
        <div className="vp-chips" role="radiogroup" aria-label="B 站账号">
          {list.map((a) => (
            <button key={a.connector_id} type="button" role="radio" aria-checked={a.connector_id === acc.connector_id}
              className={cls('chip', a.connector_id === acc.connector_id && 'chip-on')} onClick={() => setParams({ c: a.connector_id, t: '' })}>
              {a.uname || a.name}
            </button>
          ))}
        </div>
      )}
      <AccountBar acc={acc} />
      {acc.login !== 'logged_in' ? <QRLogin acc={acc} /> : (
        <>
          <div className="vd-dtabs" role="tablist" aria-label="B 站">
            <button type="button" role="tab" aria-selected={view === 'overview'} className={cls(view === 'overview' && 'on')} onClick={() => setParams({ v: '', t: '' })}>账户概览</button>
            <button type="button" role="tab" aria-selected={view === 'dm'} className={cls(view === 'dm' && 'on')} onClick={() => setParams({ v: 'dm' })}>
              私信{acc.unread > 0 && <span className="vd-mtab-n" aria-label={`${acc.unread} 条未读`}>{acc.unread}</span>}
            </button>
          </div>
          {view === 'overview'
            ? <OverviewPane cid={acc.connector_id} />
            : <Inbox acc={acc} talker={search.get('t')} onTalker={(t) => setParams({ t: t ?? '' }, !!t)} />}
        </>
      )}
    </div>
  )
}

/** 账号条：头像、昵称、登录状态、连接器异常和退避说明，右边退出登录 */
function AccountBar({ acc }: { acc: BiliAccount }) {
  const logout = useBiliLogout()
  const [ask, setAsk] = useState(false)
  const st = LOGIN_LABEL[acc.login]
  const guard = guardText(acc.guard)
  return (
    <section className="bl-acc">
      <div className="bl-acc-main">
        <Avatar name={acc.uname || 'B'} size={40} />
        <div className="bl-acc-text">
          <div className="bl-acc-name">
            <b className="ellipsis">{acc.uname || acc.name}</b>
            <Pill label={st.label} color={st.color} />
          </div>
          <div className="bl-acc-sub">
            {acc.mid ? `UID ${acc.mid}` : '还没登录'}
            {acc.snapshot_at && <> · 数据 {shortTime(acc.snapshot_at)} 拉取</>}
            {acc.login === 'logged_in' && <> · 每 {acc.poll_sec} 秒查一次新私信</>}
          </div>
        </div>
        <span className="spacer" />
        {acc.login === 'logged_in' && <Button size="sm" disabled={logout.isPending} onClick={() => setAsk(true)}>退出登录</Button>}
      </div>
      {guard && <div className="vd-banner" role="status">{guard}</div>}
      {!guard && acc.error && acc.login !== 'logged_out' && <div className="vd-banner" role="status">{acc.error}</div>}
      {logout.isError && <div className="vd-banner" role="alert">{errorText(logout.error)}</div>}
      <ConfirmDialog open={ask} title="退出 B 站登录" confirmLabel="退出登录" busy={logout.isPending}
        onConfirm={() => { setAsk(false); logout.mutate(acc.connector_id) }} onCancel={() => setAsk(false)}>
        清掉保险箱里的登录凭证，停止拉新私信。已经拉到的数据和私信留着，重新扫码登录后接着用。
      </ConfirmDialog>
    </section>
  )
}

const POLL_MS = 2000

/** 扫码登录：生成二维码，用户用 B 站 App 扫，每 2 秒问一次后端扫没扫、确认没确认；过期了重新生成 */
function QRLogin({ acc }: { acc: BiliAccount }) {
  const gen = useBiliQRCode()
  const poll = useBiliPoll()
  const [qr, setQr] = useState<BiliQRCode | null>(null)
  const [state, setState] = useState<BiliPollState | null>(null)
  const [msg, setMsg] = useState('')
  const cid = acc.connector_id
  const pollOnce = poll.mutateAsync

  useEffect(() => {
    if (!qr || state === 'done' || state === 'expired') return
    let stop = false
    const timer = window.setInterval(() => {
      if (stop) return
      if (Date.now() > new Date(qr.expires_at).getTime()) { setState('expired'); setMsg('二维码已过期，重新生成一个'); return }
      pollOnce({ cid, loginId: qr.login_id }).then((r) => {
        if (stop) return
        setState(r.state)
        setMsg(r.message)
      }, (e: unknown) => {
        if (stop) return
        // 出错（退避、连不上）就停下，不连续重试，等用户再点
        setState('expired')
        setMsg(failText(e))
      })
    }, POLL_MS)
    return () => { stop = true; window.clearInterval(timer) }
  }, [qr, state, cid, pollOnce])

  const start = () => {
    setState(null)
    setMsg('')
    gen.mutate(cid, { onSuccess: (r) => { setQr(r); setState('waiting'); setMsg('用 B 站 App 扫码') } })
  }
  const src = qr ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.qr_svg)}` : ''
  const live = qr && (state === 'waiting' || state === 'scanned')
  return (
    <section className="vd-sec bl-login">
      <div className="vd-sec-title">{acc.login === 'expired' ? '登录已失效，重新扫码登录' : '扫码登录 B 站'}</div>
      <div className="bl-login-body">
        <div className={cls('bl-qr', !live && 'dim')}>
          {qr ? <img src={src} alt="B 站登录二维码" width={180} height={180} /> : <span className="vd-faint">点下面的按钮生成二维码</span>}
        </div>
        <div className="bl-login-text">
          <ol className="bl-steps">
            <li>点「生成二维码」</li>
            <li>打开 B 站 App，用右上角的扫一扫扫码</li>
            <li>在手机上点「确认登录」</li>
          </ol>
          <p className="vd-faint">只用扫码，不填密码。登录后 Cookie 存进保险箱，页面上只显示昵称和登录状态；二维码 3 分钟内有效。</p>
          {msg && <div className={cls('bl-login-state', state === 'scanned' && 'ok', state === 'expired' && 'warn')} role="status">{msg}</div>}
          {gen.isError && <div className="vd-banner" role="alert">{failText(gen.error)}</div>}
          <div>
            <Button variant="primary" disabled={gen.isPending || !!live} onClick={start}>
              {gen.isPending ? '正在生成' : qr ? '重新生成二维码' : '生成二维码'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

/** 账户概览：数字卡、趋势，右上角手动刷新（后端每天自动拉一次） */
function OverviewPane({ cid }: { cid: string }) {
  const ov = useBiliOverview(cid)
  const refresh = useBiliRefreshOverview()
  const [curve, setCurve] = useState<BiliCurveKey>('click')
  if (ov.isPending) return <LoadingState />
  if (ov.isError) return <ErrorState title="账户数据没加载出来" error={errorText(ov.error)} onRetry={() => void ov.refetch()} />
  const d = ov.data
  const latest = d.latest
  const pts = curveOf(curve, d.trends, d.days)
  const c = BILI_CURVES.find((x) => x.key === curve)!
  const refreshBtn = (
    <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate(cid)}>{refresh.isPending ? '正在拉取' : '刷新数据'}</Button>
  )
  return (
    <div className="bl-ov">
      <div className="vp-sec-head">
        <span className="vd-sec-title">账户数据</span>
        <span className="vd-faint bl-note">
          {latest ? `${latest.date} 的数据，${shortTime(latest.updated_at)} 拉取` : '还没拉过'}
          {latest?.source === 'open+web' && '；粉丝、关注、过审稿件取开放平台'}
        </span>
        <span className="spacer" />
        {refreshBtn}
      </div>
      {refresh.isError && <div className="vd-banner" role="alert">{failText(refresh.error)}</div>}
      {!latest ? (
        <EmptyState compact title="还没有账户数据" desc="每天自动拉一次；现在要看就点「刷新数据」。一次要发 8 个请求，按限频排队，要十来秒" />
      ) : (
        <>
          <div className="bl-stats">
            {BILI_STATS.filter((s) => s.key !== 'archives' || latest.archives != null).map((s) => {
              const inc = s.incr ? latest[s.incr] : undefined
              return (
                <div key={s.key} className="vp-stat">
                  <span>{s.label}</span>
                  <b>{biliNum(latest[s.key])}</b>
                  {inc != null && <em className={cls('bl-inc', inc < 0 && 'neg')}>昨日 {inc >= 0 ? '+' : ''}{inc.toLocaleString('zh-CN')}</em>}
                </div>
              )
            })}
          </div>
          <section className="vd-sec">
            <div className="vp-sec-head">
              <span className="vd-sec-title">按天趋势</span>
              <div className="vp-chips" role="radiogroup" aria-label="趋势指标">
                {BILI_CURVES.map((x) => (
                  <button key={x.key} type="button" role="radio" aria-checked={curve === x.key} className={cls('chip', curve === x.key && 'chip-on')}
                    onClick={() => setCurve(x.key)}>{x.label}</button>
                ))}
              </div>
            </div>
            <div className="vd-faint bl-note">{c.desc}</div>
            <DayBars pts={pts} label={c.label} />
          </section>
        </>
      )}
    </div>
  )
}

/** 按天柱状图：柱子画在 HTML 里（不拉伸文字），最大值和首尾日期标出来 */
function DayBars({ pts, label }: { pts: { date: string; value: number }[]; label: string }) {
  if (pts.length === 0) return <div className="bl-bars-empty vd-faint">还没有数据，过几天就攒出来了</div>
  const max = Math.max(1, ...pts.map((p) => p.value))
  return (
    <div className="bl-bars" role="img" aria-label={`${label}按天：${pts.map((p) => `${p.date} ${p.value}`).join('，')}`}>
      <div className="bl-bars-plot">
        {pts.map((p) => (
          <span key={p.date} className="bl-bar" title={`${p.date}：${p.value.toLocaleString('zh-CN')}`}
            style={{ '--h': `${Math.max(2, (p.value / max) * 100)}%` } as CSSProperties} />
        ))}
      </div>
      <div className="bl-bars-axis">
        <span>{pts[0].date.slice(5)}</span>
        <span>最高 {biliNum(max)}</span>
        <span>{pts[pts.length - 1].date.slice(5)}</span>
      </div>
    </div>
  )
}

/** 私信：左边会话列表，右边会话详情加发送框；窄屏一次只显示一边 */
function Inbox({ acc, talker, onTalker }: { acc: BiliAccount; talker: string | null; onTalker: (t: string | null) => void }) {
  const cid = acc.connector_id
  const sessions = useBiliSessions(cid, acc.poll_sec * 1000)
  const refresh = useBiliRefreshSessions()
  if (sessions.isPending) return <LoadingState />
  if (sessions.isError) return <ErrorState title="私信没加载出来" error={errorText(sessions.error)} onRetry={() => void sessions.refetch()} />
  const list = sessions.data.items
  const cur = talker ? list.find((s) => s.talker_id === talker) : undefined
  return (
    <div className="bl-inbox-wrap">
      <div className="vp-sec-head">
        <span className="vd-faint bl-note">
          {acc.inbox_synced_at ? `${shortTime(acc.inbox_synced_at)} 查过新私信` : '还没查过私信'}；第一次只记下现有会话，之后来的新私信才发通知
        </span>
        <span className="spacer" />
        <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate(cid)}>{refresh.isPending ? '正在查' : '查新私信'}</Button>
      </div>
      {refresh.isError && <div className="vd-banner" role="alert">{failText(refresh.error)}</div>}
      <div className={cls('bl-inbox', cur && 'has-cur')}>
        <ul className="bl-sessions" aria-label="私信会话">
          {list.length === 0 && <li className="bl-sessions-empty vd-faint">还没有私信会话，点「查新私信」拉一次</li>}
          {list.map((s) => (
            <li key={s.talker_id}>
              <button type="button" className={cls('bl-session', s.talker_id === talker && 'sel')} onClick={() => onTalker(s.talker_id)}>
                <Avatar name={s.talker_name || s.talker_id} size={32} />
                <span className="bl-session-main">
                  <span className="bl-session-top">
                    <b className="ellipsis">{s.talker_name || `UID ${s.talker_id}`}</b>
                    {s.last_at && <span className="vd-faint">{msgTime(s.last_at)}</span>}
                  </span>
                  <span className="bl-session-last ellipsis">{s.last_text || '（没有内容）'}</span>
                </span>
                {s.unread > 0 && <span className="vd-mtab-n" aria-label={`${s.unread} 条未读`}>{s.unread}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="bl-chat-pane">
          {cur ? <Chat key={cur.talker_id} cid={cid} talker={cur.talker_id} name={cur.talker_name || `UID ${cur.talker_id}`} pollMs={acc.poll_sec * 1000} onBack={() => onTalker(null)} />
            : <div className="bl-chat-none vd-faint">选一个会话看消息</div>}
        </div>
      </div>
    </div>
  )
}

/** 一个会话：消息记录（本地库），打开时没有消息就拉一页；底下发送框，Ctrl/⌘+Enter 也能发 */
function Chat({ cid, talker, name, pollMs, onBack }: { cid: string; talker: string; name: string; pollMs: number; onBack: () => void }) {
  const msgs = useBiliMessages(cid, talker, pollMs)
  const sync = useBiliSyncTalker()
  const send = useBiliSend()
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const pulled = useRef(false)
  const endRef = useRef<HTMLDivElement>(null)
  const items = msgs.data?.items ?? []
  const syncOnce = sync.mutate

  // 第一次打开、本地还没有消息时拉一页；只拉这一次，不自动重试
  useEffect(() => {
    if (pulled.current || !msgs.isSuccess || msgs.data.items.length > 0) return
    pulled.current = true
    syncOnce({ cid, talker })
  }, [msgs.isSuccess, msgs.data, cid, talker, syncOnce])
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [items.length])

  const left = leftChars(text, BILI_TEXT_MAX)
  const canSend = text.trim() !== '' && left >= 0 && !send.isPending
  const doSend = (body: string) => {
    setErr(null)
    // 每次点发送一个新的 client_msg_id；按钮在发的时候是禁用的，同一次点击不会发两遍
    send.mutate({ cid, talker, clientMsgId: newClientMsgId(), text: body }, {
      onSuccess: () => setText(''),
      onError: (e) => setErr(chatFailText(e)),
    })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
      e.preventDefault()
      doSend(text.trim())
    }
  }
  return (
    <div className="bl-chat">
      <div className="bl-chat-head">
        <Button size="sm" className="bl-back" onClick={onBack}>返回</Button>
        <b className="ellipsis">{name}</b>
        <span className="vd-faint">UID {talker}</span>
        <span className="spacer" />
        <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate({ cid, talker })}>{sync.isPending ? '正在拉取' : '拉取消息'}</Button>
      </div>
      {sync.isError && <div className="vd-banner" role="alert">{chatFailText(sync.error)}</div>}
      <div className="bl-msgs" aria-live="polite">
        {msgs.isPending && <LoadingState />}
        {msgs.isSuccess && items.length === 0 && <div className="vd-faint bl-msgs-empty">{sync.isPending ? '正在拉取消息' : '还没有消息'}</div>}
        {items.map((m) => <Bubble key={m.id} m={m} onRetry={() => doSend(m.text)} busy={send.isPending} />)}
        <div ref={endRef} />
      </div>
      <div className="bl-compose">
        <Textarea rows={2} autoGrow value={text} placeholder={`发给 ${name}（只发文字，一次一条）`} aria-label="私信内容"
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} invalid={left < 0} />
        <div className="bl-compose-bar">
          <span className={cls('vd-faint', left < 0 && 'vp-bad')}>{left < 0 ? `超了 ${-left} 字` : `还能写 ${left} 字`}</span>
          {err && <span className="vd-danger-text bl-send-err" role="alert">{err}</span>}
          <span className="spacer" />
          <Button variant="primary" disabled={!canSend} onClick={() => doSend(text.trim())}>{send.isPending ? '正在发送' : '发送'}</Button>
        </div>
      </div>
    </div>
  )
}

const STATUS_TEXT: Partial<Record<BiliMessage['status'], string>> = { sending: '发送中', failed: '没发出去' }

function Bubble({ m, onRetry, busy }: { m: BiliMessage; onRetry: () => void; busy: boolean }) {
  return (
    <div className={cls('bl-msg', m.direction === 'out' ? 'out' : 'in', m.status === 'failed' && 'failed')}>
      <div className="bl-bubble">{m.text}</div>
      <div className="bl-msg-meta">
        <span>{msgTime(m.at)}</span>
        {STATUS_TEXT[m.status] && <span className={cls(m.status === 'failed' && 'vd-danger-text')}>{STATUS_TEXT[m.status]}</span>}
        {m.status === 'failed' && <button type="button" className="vd-link" disabled={busy} onClick={onRetry} title={m.error}>再发一次</button>}
      </div>
      {m.status === 'failed' && m.error && <div className="bl-msg-err">{m.error}</div>}
    </div>
  )
}
