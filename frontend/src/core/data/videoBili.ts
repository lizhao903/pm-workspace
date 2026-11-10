// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频插件的 B 站组件（TSK-0455）：网页端扫码登录、账户概览和按天趋势、私信会话和消息、发文字私信。
// 契约见 docs/api-contract.md「B 站组件（TSK-0455）」。接口不给 Cookie、csrf 等凭证，只给登录状态、昵称、头像和数据。
// 被限频、风控时后端回 429，error.guard 是退避说明（到什么时候、为什么），界面照着显示，不自己重试。
// 缓存键在 video 前缀下的 bili 里；新私信由后端每 60 秒拉一轮，前端按 poll_sec 回查本地列表（只读库，不出网）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isApiError, request, requestEnvelope } from '../api'
import { useNotifyChange } from './invalidate'

export type BiliLogin = 'logged_out' | 'logged_in' | 'expired'

/** 退避中：到 until 之前不发 B 站请求 */
export type BiliGuard = { until: string; reason: string; code: number }

export type BiliAccount = {
  /** bilibili_web 连接器实例 id（cn_ 前缀） */
  connector_id: string
  /** 连接器名称 */
  name: string
  /** 连接器状态：connected / connecting / error / paused / disconnected */
  status: string
  error?: string
  login: BiliLogin
  mid?: string
  uname?: string
  face?: string
  guard?: BiliGuard
  unread: number
  inbox_synced_at?: string
  snapshot_at?: string
  /** 后端拉新私信的间隔（秒） */
  poll_sec: number
}

export type BiliSnapshot = {
  /** 北京时间的日期 YYYY-MM-DD */
  date: string
  /** web：网页接口；open+web：粉丝、关注、稿件数取开放平台 */
  source: 'web' | 'open+web'
  followers?: number
  following?: number
  archives?: number
  total_click?: number
  total_like?: number
  total_coin?: number
  total_fav?: number
  total_reply?: number
  total_dm?: number
  total_share?: number
  total_elec?: number
  incr_fans?: number
  incr_click?: number
  updated_at: string
}

export type BiliTrendMetric = 'click' | 'like' | 'coin' | 'fav' | 'elec'
export type BiliTrend = { metric: BiliTrendMetric; points: { date: string; value: number }[] }

export type BiliOverview = { account: BiliAccount; latest: BiliSnapshot | null; days: BiliSnapshot[]; trends: BiliTrend[] }

export type BiliSession = {
  talker_id: string
  talker_name: string
  talker_face: string
  unread: number
  last_text: string
  last_at?: string
  updated_at: string
}

export type BiliMessageStatus = 'received' | 'sending' | 'sent' | 'failed'

export type BiliMessage = {
  /** bpm_ 前缀 */
  id: string
  talker_id: string
  direction: 'in' | 'out'
  msg_type: number
  text: string
  at: string
  status: BiliMessageStatus
  error?: string
  client_msg_id?: string
  created_at: string
}

export type BiliQRCode = { login_id: string; qr_svg: string; expires_at: string }
export type BiliPollState = 'waiting' | 'scanned' | 'expired' | 'done'
export type BiliPoll = { state: BiliPollState; message: string; account?: BiliAccount }

export type BiliSessions = { items: BiliSession[]; unread: number; account: BiliAccount }
export type BiliMessages = { items: BiliMessage[]; hasMore: boolean; session: BiliSession }

/** 单条私信最多几个字，同后端 */
export const BILI_TEXT_MAX = 500

export const videoBiliKeys = {
  all: ['video', 'bili'] as const,
  accounts: ['video', 'bili', 'accounts'] as const,
  overview: (cid: string) => ['video', 'bili', 'overview', cid] as const,
  sessions: (cid: string) => ['video', 'bili', 'sessions', cid] as const,
  messages: (cid: string, talker: string) => ['video', 'bili', 'messages', cid, talker] as const,
}

const base = '/api/video/bili'
const seg = encodeURIComponent
const cpath = (cid: string) => `${base}/${seg(cid)}`

async function sessionsOf(p: Promise<{ data: BiliSession[]; meta?: unknown }>): Promise<BiliSessions> {
  const { data, meta } = await p
  const m = (meta ?? {}) as { unread?: number; account: BiliAccount }
  return { items: data ?? [], unread: m.unread ?? 0, account: m.account }
}

async function messagesOf(p: Promise<{ data: BiliMessage[]; meta?: unknown }>): Promise<BiliMessages> {
  const { data, meta } = await p
  const m = (meta ?? {}) as { has_more?: boolean; session: BiliSession }
  return { items: data ?? [], hasMore: !!m.has_more, session: m.session }
}

export const videoBiliApi = {
  accounts: (signal?: AbortSignal) => request<BiliAccount[]>('GET', `${base}/accounts`, { signal }),
  qrcode: (cid: string) => request<BiliQRCode>('POST', `${cpath(cid)}/login/qrcode`, { body: {} }),
  poll: (cid: string, loginId: string) => request<BiliPoll>('POST', `${cpath(cid)}/login/poll`, { body: { login_id: loginId } }),
  logout: (cid: string) => request<BiliAccount>('POST', `${cpath(cid)}/logout`, { body: {} }),
  overview: (cid: string, signal?: AbortSignal) => request<BiliOverview>('GET', `${cpath(cid)}/overview`, { signal }),
  refreshOverview: (cid: string) => request<BiliOverview>('POST', `${cpath(cid)}/overview/refresh`, { body: {} }),
  sessions: (cid: string, signal?: AbortSignal) => sessionsOf(requestEnvelope<BiliSession[]>('GET', `${cpath(cid)}/sessions`, { signal })),
  refreshSessions: (cid: string) => sessionsOf(requestEnvelope<BiliSession[]>('POST', `${cpath(cid)}/sessions/refresh`, { body: {} })),
  messages: (cid: string, talker: string, signal?: AbortSignal) =>
    messagesOf(requestEnvelope<BiliMessage[]>('GET', `${cpath(cid)}/sessions/${seg(talker)}/messages`, { signal })),
  syncTalker: (cid: string, talker: string) =>
    messagesOf(requestEnvelope<BiliMessage[]>('POST', `${cpath(cid)}/sessions/${seg(talker)}/sync`, { body: {} })),
  send: (cid: string, talker: string, body: { client_msg_id: string; text: string }) =>
    request<BiliMessage>('POST', `${cpath(cid)}/sessions/${seg(talker)}/messages`, { body }),
}

/** 被限频、风控时的退避说明（429 的 error.guard），别的错误回 null */
export function biliGuardOf(e: unknown): BiliGuard | null {
  if (!isApiError(e)) return null
  const g = e.extra.guard as BiliGuard | undefined
  return g && typeof g.until === 'string' ? g : null
}

/** 登录失效（409 bili_login_required） */
export function biliNeedsLogin(e: unknown): boolean {
  return isApiError(e) && e.status === 409 && e.extra.code === undefined && /扫码/.test(e.message)
}

/** 发送用的客户端消息 id：同一次点击只生成一个，重复提交后端只发一次 */
export function newClientMsgId(): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `cm-${r}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
}

export function useBiliAccounts() {
  return useQuery({ queryKey: videoBiliKeys.accounts, queryFn: ({ signal }) => videoBiliApi.accounts(signal), refetchInterval: 60_000 })
}

export function useBiliOverview(cid: string | null) {
  return useQuery({ queryKey: videoBiliKeys.overview(cid ?? ''), queryFn: ({ signal }) => videoBiliApi.overview(cid!, signal), enabled: !!cid })
}

/** 会话列表按 pollMs 回查本地库（后端后台任务负责出网拉新私信） */
export function useBiliSessions(cid: string | null, pollMs: number | false = 60_000) {
  return useQuery({
    queryKey: videoBiliKeys.sessions(cid ?? ''), queryFn: ({ signal }) => videoBiliApi.sessions(cid!, signal), enabled: !!cid, refetchInterval: pollMs,
  })
}

export function useBiliMessages(cid: string | null, talker: string | null, pollMs: number | false = 60_000) {
  return useQuery({
    queryKey: videoBiliKeys.messages(cid ?? '', talker ?? ''), queryFn: ({ signal }) => videoBiliApi.messages(cid!, talker!, signal),
    enabled: !!cid && !!talker, refetchInterval: pollMs,
  })
}

function useBiliWrite<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: fn,
    // 出错也刷：退避、登录失效会改账号上的状态
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: videoBiliKeys.all }), notify({ kind: 'connector' })]).then(() => undefined),
  })
}

export const useBiliQRCode = () => useMutation({ mutationFn: (cid: string) => videoBiliApi.qrcode(cid) })
export const useBiliPoll = () => useBiliWriteIfDone()
export const useBiliLogout = () => useBiliWrite((cid: string) => videoBiliApi.logout(cid))
export const useBiliRefreshOverview = () => useBiliWrite((cid: string) => videoBiliApi.refreshOverview(cid))
export const useBiliRefreshSessions = () => useBiliWrite((cid: string) => videoBiliApi.refreshSessions(cid))
export const useBiliSyncTalker = () => useBiliWrite(({ cid, talker }: { cid: string; talker: string }) => videoBiliApi.syncTalker(cid, talker))
export const useBiliSend = () =>
  useBiliWrite(({ cid, talker, clientMsgId, text }: { cid: string; talker: string; clientMsgId: string; text: string }) =>
    videoBiliApi.send(cid, talker, { client_msg_id: clientMsgId, text }))

/** 轮询扫码状态：登录成功时才刷缓存，等待中的不刷 */
function useBiliWriteIfDone() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ cid, loginId }: { cid: string; loginId: string }) => videoBiliApi.poll(cid, loginId),
    onSuccess: (r) => (r.state === 'done'
      ? Promise.all([qc.invalidateQueries({ queryKey: videoBiliKeys.all }), notify({ kind: 'connector' })]).then(() => undefined)
      : undefined),
  })
}
