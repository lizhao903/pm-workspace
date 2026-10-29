// Google 账号（SPEC-browser-4）：工具栏右边的账号按钮、账号面板、登录弹窗。
// 账号以 Google Drive 连接器实例为准（BR-01a）：登录是拿 Drive（和日历）实例的 OAuth 授权地址，在新窗口里由 Google 选账号、授权，
// 这里轮询 /api/browser/google 等授权完成；原型里的模拟选账号一步正式版没有。退出断开 Drive 和日历两个实例，不弹确认。
// 授权回调回到 /browser?oauth=…，那个窗口只显示结果并通知这边（OAuthDone）
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router'
import { Avatar, Button, Checkbox, cls } from '../../core/ui'
import {
  connectorsPagePath, errorText, isApiError, useBrowserGoogle, useBrowserGoogleLogin, useBrowserGoogleLogout, useNotifyChange,
  type BrowserGoogleLogin, type BrowserGoogleState,
} from '../../core/data'
import { GDRIVE_TOOL, GOOGLE_SCOPES, oauthReturnTo, timeAgo } from './model'

/** 等授权完成时多久看一次 */
export const GOOGLE_POLL_MS = 2000
/** 回调窗口和工作台窗口之间传结果 */
export const OAUTH_CHANNEL = 'pmw-browser-oauth'
export const NOT_CONFIGURED = '先在设置 / 连接器里配好 Google Drive 的 OAuth 客户端'

type OAuthMsg = { ok: boolean; connector: string; message: string }

function listenOAuth(f: (m: OAuthMsg) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const ch = new BroadcastChannel(OAUTH_CHANNEL)
  ch.onmessage = (e: MessageEvent<OAuthMsg>) => f(e.data)
  return () => ch.close()
}

export function AccountButton({ google, onLogin }: { google: BrowserGoogleState | undefined; onLogin: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const logout = useBrowserGoogleLogout()
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [open])

  const acc = google?.signed_in ? google.account : null
  if (!acc) {
    return (
      <button type="button" className="btn btn-outline br-login-btn" onClick={onLogin} aria-label="登录 Google">
        <span className="br-g" aria-hidden="true">G</span><span className="br-login-text">登录 Google</span>
      </button>
    )
  }
  const name = acc.name || acc.email
  return (
    <div className="br-acc-wrap" ref={ref}>
      <button type="button" className="br-acc" title={acc.email} aria-label={`Google 账号 ${acc.email}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar name={name} size={28} />
      </button>
      {open && (
        <div className="menu br-acc-menu" role="dialog" aria-label="Google 账号">
          <div className="br-acc-head">
            <Avatar name={name} size={40} />
            <div className="br-acc-text">
              <div className="br-acc-name ellipsis">{name}</div>
              <div className="muted ellipsis">{acc.email}</div>
              {acc.connected_at && <div className="faint">{timeAgo(acc.connected_at)}登录</div>}
            </div>
          </div>
          <div className="menu-sep" />
          <div className="menu-label">已授权的范围</div>
          <div className="br-acc-scopes">
            {GOOGLE_SCOPES.map((s) => {
              const on = acc.scopes.includes(s.key)
              return (
                <div key={s.key} className={cls('br-scope-line', !on && 'off')}>
                  <span className="br-scope-mark">{on ? '已授权' : '未授权'}</span>
                  <span className="ellipsis">{s.label}</span>
                </div>
              )
            })}
          </div>
          {logout.isError && <div className="br-acc-err">退出没成功：{errorText(logout.error)}</div>}
          <div className="menu-sep" />
          <button type="button" className="menu-item" onClick={() => { setOpen(false); onLogin() }}>切换账号或重新授权</button>
          <button type="button" className="menu-item br-danger-item" disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSuccess: () => setOpen(false) })}>{logout.isPending ? '正在退出…' : '退出登录'}</button>
        </div>
      )}
    </div>
  )
}

type Step = 'consent' | 'drive' | 'calendar' | 'calendar-wait' | 'failed'

/** 新窗口打开授权页：先同步开一个空窗口（点击里开才不会被拦），拿到地址再跳过去 */
function openBlank(): Window | null {
  try {
    const w = window.open('', '_blank')
    if (w) w.opener = null
    return w
  } catch {
    return null
  }
}

export function LoginDialog({ google, onClose }: { google: BrowserGoogleState | undefined; onClose: () => void }) {
  const navigate = useNavigate()
  const notify = useNotifyChange()
  const login = useBrowserGoogleLogin()
  const [step, setStep] = useState<Step>('consent')
  const [withCalendar, setWithCalendar] = useState(true)
  const [error, setError] = useState('')
  const [start, setStart] = useState<BrowserGoogleLogin | null>(null)
  /** 开始授权前的授权时间，变了就是这次授权完成了 */
  const before = useRef<{ drive: string | null; calendar: string | null }>({ drive: null, calendar: null })
  const waiting = step === 'drive' || step === 'calendar-wait'
  const state = useBrowserGoogle(waiting ? GOOGLE_POLL_MS : false)
  const g = state.data ?? google
  const hasCalendar = !!g?.calendar
  const notConfigured = !!g && !g.configured
  // 「去配置」直接打开 Drive 实例的抽屉，还没有实例时打开新建（POL-01）
  const configure = () => { onClose(); void navigate(connectorsPagePath(g?.drive ? { connector: g.drive.id } : { tool: GDRIVE_TOOL })) }

  const finish = () => {
    void notify({ kind: 'browser-google' })
    onClose()
  }

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !waiting) onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [waiting, onClose])

  // 回调窗口报回来的失败（成功以轮询到的状态为准）
  const refetch = state.refetch
  useEffect(() => {
    if (!waiting) return
    return listenOAuth((m) => {
      if (m.ok) { void refetch(); return }
      setError(m.message || '对方没有给出原因')
      setStep('failed')
    })
  }, [waiting, refetch])

  // 轮询到授权时间变了：Drive 完了接着问日历，日历完了收尾
  const driveAt = g?.drive?.authorized_at ?? null
  const calAt = g?.calendar?.authorized_at ?? null
  const driveStatus = g?.drive?.status
  useEffect(() => {
    if (step === 'drive' && driveAt && driveAt !== before.current.drive && driveStatus !== 'disconnected') {
      if (withCalendar && start?.calendar) setStep('calendar')
      else finish()
    }
    if (step === 'calendar-wait' && calAt && calAt !== before.current.calendar) finish()
    // finish 每次渲染都是新的，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, driveAt, calAt, driveStatus, withCalendar, start])

  const allow = () => {
    before.current = { drive: g?.drive?.authorized_at ?? null, calendar: g?.calendar?.authorized_at ?? null }
    setError('')
    const w = openBlank()
    login.mutate(oauthReturnTo(), {
      onSuccess: (r) => {
        setStart(r)
        if (w) w.location.href = r.authorize_url
        setStep('drive')
      },
      onError: (e) => {
        w?.close()
        setError(isApiError(e, 'conflict') ? e.message || NOT_CONFIGURED : errorText(e))
        setStep('failed')
      },
    })
  }

  const authorizeCalendar = () => {
    if (!start?.calendar) { finish(); return }
    window.open(start.calendar.authorize_url, '_blank', 'noopener')
    setStep('calendar-wait')
  }

  const onMask = (e: ReactMouseEvent) => { if (e.target === e.currentTarget && !waiting) onClose() }

  return (
    <div className="dialog-scrim br-login-scrim" onMouseDown={onMask}>
      <div className="dialog br-modal" role="dialog" aria-modal="true" aria-label="登录 Google">
        <div className="br-g-word">Google</div>

        {step === 'consent' && notConfigured && <>
          <h2 className="br-modal-title">还不能登录 Google</h2>
          <div className="muted">{NOT_CONFIGURED}。Google 账号用的就是 Google Drive 连接器的授权。</div>
          <div className="br-modal-foot">
            <Button onClick={onClose}>取消</Button>
            <span className="spacer" />
            <Button variant="primary" onClick={configure}>去配置</Button>
          </div>
        </>}

        {step === 'consent' && !notConfigured && <>
          <h2 className="br-modal-title">「一人之下」想要访问你的 Google 账号</h2>
          <div className="muted br-modal-sub">点「允许」后会在新窗口打开 Google 的授权页，在那里选账号、确认授权。</div>
          <div className="br-scope-list">
            {GOOGLE_SCOPES.map((s) => {
              const isCal = s.conn === 'calendar'
              return (
                <div key={s.key} className={cls('br-scope', isCal && !hasCalendar && 'off')}>
                  <Checkbox checked={isCal ? withCalendar && hasCalendar : true} disabled={!isCal || !hasCalendar}
                    aria-label={s.label} onChange={(e) => setWithCalendar(e.target.checked)} />
                  <span className="br-scope-text">
                    <span className="br-scope-label">{s.label}</span>
                    <span className="faint">{isCal && !hasCalendar ? '设置 / 连接器里还没有 Google 日历，登录后不会连上日历' : s.desc}</span>
                    <span className="br-scope-key">{s.key}{!isCal ? ' · 登录必需' : ''}</span>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="muted br-modal-note">登录后，设置 / 连接器里的 Google Drive{hasCalendar && withCalendar ? '、Google 日历' : ''}会一并连上；随时可以在这里退出登录或在连接器里断开。</div>
          <div className="br-modal-foot">
            <Button onClick={onClose}>取消</Button>
            <span className="spacer" />
            <Button variant="primary" disabled={login.isPending} onClick={allow}>{login.isPending ? '正在打开…' : '允许'}</Button>
          </div>
        </>}

        {waiting && (
          <div className="br-working">
            <span className="br-spin br-spin-lg" aria-hidden="true" />
            <div>{step === 'drive' ? '正在等你在 Google 的页面完成授权…' : '正在等 Google 日历的授权…'}</div>
            {step === 'drive' && start && (
              <a className="link" href={start.authorize_url} target="_blank" rel="noopener noreferrer">授权页没打开？点这里打开</a>
            )}
            <Button size="sm" onClick={() => setStep('consent')}>不等了</Button>
          </div>
        )}

        {step === 'calendar' && <>
          <h2 className="br-modal-title">Google Drive 已连上</h2>
          <div className="muted">再授权一次 Google 日历，日程就能同步到工作台。</div>
          <div className="br-modal-foot">
            <Button onClick={finish}>跳过</Button>
            <span className="spacer" />
            <Button variant="primary" onClick={authorizeCalendar}>授权 Google 日历</Button>
          </div>
        </>}

        {step === 'failed' && <>
          <h2 className="br-modal-title">授权没完成</h2>
          <div className="br-login-err" role="alert">授权没完成：{error}</div>
          <div className="br-modal-foot">
            <Button onClick={onClose}>取消</Button>
            <span className="spacer" />
            {error === NOT_CONFIGURED
              ? <Button variant="primary" onClick={configure}>去配置</Button>
              : <Button variant="primary" onClick={() => setStep('consent')}>重试</Button>}
          </div>
        </>}
      </div>
    </div>
  )
}

/** 授权回调回到的窗口：显示结果，告诉工作台窗口，能关就自己关掉 */
export function OAuthDone({ ok, connector, message }: OAuthMsg) {
  useEffect(() => {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(OAUTH_CHANNEL)
      ch.postMessage({ ok, connector, message } satisfies OAuthMsg)
      ch.close()
    }
    if (ok) {
      const t = setTimeout(() => window.close(), 800)
      return () => clearTimeout(t)
    }
  }, [ok, connector, message])
  return (
    <div className="br-page">
      <div className="br-center">
        <div className="br-notice">
          <div className="br-g-word">Google</div>
          <div className="br-notice-title">{ok ? '授权完成' : '授权没完成'}</div>
          <div className="muted">{ok ? '可以关掉这个窗口，回到工作台继续。' : message || '对方没有给出原因，回到工作台重试。'}</div>
        </div>
      </div>
    </div>
  )
}
