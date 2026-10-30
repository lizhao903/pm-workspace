import { useEffect, useState } from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router'
import { incidentsPagePath } from '../data'
import { isChunkError, reportFrontError, type ReportResult } from './errorReport'
import { reloadIfStale } from './staleBuild'

export function RouteError() {
  const err = useRouteError()
  // 先看是不是服务换了新版本、页面还是旧的；是就自动刷新，不停在「出错了」
  const [checking, setChecking] = useState(!isRouteErrorResponse(err))
  // 检查完仍是错误的记成运行异常（INC-01b）；404 这类路由响应不是缺陷，不报
  const [reported, setReported] = useState<ReportResult | null>(null)
  useEffect(() => {
    if (!checking) return
    let live = true
    void reloadIfStale().then((reloading) => {
      if (!live || reloading) return
      setChecking(false)
      void reportFrontError(isChunkError(err) ? 'chunk' : 'route', err).then((r) => { if (live) setReported(r) })
    })
    return () => { live = false }
  }, [checking, err])

  let msg = '页面出错了'
  if (isRouteErrorResponse(err)) msg = err.status === 404 ? '页面不存在' : err.status + ' ' + err.statusText
  else if (err instanceof Error) msg = err.message
  if (checking) return <section className="shell-placeholder"><p>正在加载…</p></section>
  return (
    <section className="shell-placeholder">
      <h1>出错了</h1>
      <p>{msg}</p>
      {reported?.ok && (
        <p className="shell-placeholder-note">这个错误已记到 <Link to={incidentsPagePath(reported.id)}>设置 / 运行异常</Link>，可以在那里转成研发任务</p>
      )}
      <p><button type="button" className="btn btn-outline btn-sm" onClick={() => location.reload()}>重新加载</button></p>
    </section>
  )
}
