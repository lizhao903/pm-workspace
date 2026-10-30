import { useEffect, useState } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { reloadIfStale } from './staleBuild'

export function RouteError() {
  const err = useRouteError()
  // 先看是不是服务换了新版本、页面还是旧的；是就自动刷新，不停在「出错了」
  const [checking, setChecking] = useState(!isRouteErrorResponse(err))
  useEffect(() => {
    if (!checking) return
    let live = true
    void reloadIfStale().then((reloading) => { if (live && !reloading) setChecking(false) })
    return () => { live = false }
  }, [checking])

  let msg = '页面出错了'
  if (isRouteErrorResponse(err)) msg = err.status === 404 ? '页面不存在' : err.status + ' ' + err.statusText
  else if (err instanceof Error) msg = err.message
  if (checking) return <section className="shell-placeholder"><p>正在加载…</p></section>
  return (
    <section className="shell-placeholder">
      <h1>出错了</h1>
      <p>{msg}</p>
      <p><button type="button" className="btn btn-outline btn-sm" onClick={() => location.reload()}>重新加载</button></p>
    </section>
  )
}
