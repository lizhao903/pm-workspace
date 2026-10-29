// 内置浏览器（BR-01b）：浏览器插件 browser 的接口，契约见 docs/api-contract.md「内置浏览器插件 browser」（BR-01a）。
// 标签页启动时 GET 一次、之后整体 PUT（页面自己防抖），不走缓存。
// Google 账号以 Google Drive 连接器实例为准：登录、退出报 { kind: 'browser-google' }，连接器列表一起刷；
// 在连接器设置页断开 Drive（报 connector）时这里也跟着刷（SPEC-browser-4.13）。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { browserKeys } from './browserKeys'
import { useNotifyChange } from './invalidate'

export type BrowserTabKind = 'home' | 'proto' | 'drive' | 'web'

/** 存后端的标签：同原型 BrowserTab，多 position、active、updated_at；PUT 时后两项可不给 */
export type BrowserTabRecord = {
  id: string
  url: string
  title: string
  kind: BrowserTabKind
  history: string[]
  cursor: number
  pinned: boolean
  position: number
  active: boolean
  updated_at?: string
}

export type BrowserGoogleConn = {
  id: string
  name: string
  status: string
  error: string
  account: string
  /** GOOGLE_SCOPES 的 key，如 drive.readonly、calendar.events */
  scopes: string[]
  authorized_at: string | null
}

export type BrowserGoogleAccount = { email: string; name: string; scopes: string[]; connected_at: string | null }

export type BrowserGoogleState = {
  signed_in: boolean
  /** 有没有 Google Drive 连接器实例（OAuth 客户端填在实例配置里） */
  configured: boolean
  account: BrowserGoogleAccount | null
  drive: BrowserGoogleConn | null
  calendar: BrowserGoogleConn | null
}

export type BrowserOAuthStart = { connector_id: string; authorize_url: string; redirect_uri: string; expires_at: string }
export type BrowserGoogleLogin = BrowserOAuthStart & { calendar: BrowserOAuthStart | null }
export type BrowserGoogleLogout = { disconnected: string[]; google: BrowserGoogleState }

/** 后端最多存这么多个标签，前端同时开的仍按 12 个（SPEC-browser-1） */
export const BROWSER_MAX_STORED_TABS = 50

export const browserApi = {
  tabs: async (signal?: AbortSignal) => (await requestList<BrowserTabRecord>('/api/browser/tabs', { signal })).data,
  putTabs: (tabs: BrowserTabRecord[], keepalive = false) =>
    request<BrowserTabRecord[]>('PUT', '/api/browser/tabs', { body: { tabs }, keepalive }),
  google: (signal?: AbortSignal) => request<BrowserGoogleState>('GET', '/api/browser/google', { signal }),
  login: (returnTo?: string) => request<BrowserGoogleLogin>('POST', '/api/browser/google/login', { body: returnTo ? { return_to: returnTo } : {} }),
  logout: () => request<BrowserGoogleLogout>('POST', '/api/browser/google/logout', { body: {} }),
}

/** 浏览器的 Google 账号；pollMs 给了就按这个间隔轮询（等授权完成时用） */
export function useBrowserGoogle(pollMs: number | false = false) {
  return useQuery({
    queryKey: browserKeys.google,
    queryFn: ({ signal }) => browserApi.google(signal),
    refetchInterval: pollMs,
  })
}

/** 发起登录：拿回 Drive（和日历）实例的授权地址，由页面在新窗口打开；授权还没完成，不报改动 */
export function useBrowserGoogleLogin() {
  return useMutation({ mutationFn: (returnTo?: string) => browserApi.login(returnTo) })
}

/** 退出：断开这个账号的 Drive 和日历实例；失败也刷一次，状态以后端为准 */
export function useBrowserGoogleLogout() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: () => browserApi.logout(),
    onSettled: () => notify({ kind: 'browser-google' }),
  })
}
