// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 连接器的 OAuth 授权（CONN-04b）：抽屉点「去授权」在新窗口打开对方的授权页，授权结束后那个窗口回到
// /settings/connectors?oauth=ok|error&connector=…&message=…，只显示结果并经 BroadcastChannel 告诉抽屉（成功以轮询到的实例为准）。

/** 等授权完成时多久重取一次实例 */
export const OAUTH_POLL_MS = 2000
/** 回调窗口和工作台窗口之间传结果 */
export const OAUTH_CHANNEL = 'pmw-connector-oauth'

export type OAuthMsg = { ok: boolean; connector: string; message: string }

export function listenOAuth(f: (m: OAuthMsg) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const ch = new BroadcastChannel(OAUTH_CHANNEL)
  ch.onmessage = (e: MessageEvent<OAuthMsg>) => f(e.data)
  return () => ch.close()
}

/** 回调带回来的结果；不是回调窗口时是 null */
export function oauthResult(search: string): OAuthMsg | null {
  const p = new URLSearchParams(search)
  const r = p.get('oauth')
  if (!r) return null
  return { ok: r === 'ok', connector: p.get('connector') ?? '', message: p.get('message') ?? '' }
}

/** 先同步开一个空窗口（在点击里开才不会被拦），拿到授权地址再跳过去 */
export function openBlank(): Window | null {
  try {
    const w = window.open('', '_blank')
    if (w) w.opener = null
    return w
  } catch {
    return null
  }
}
